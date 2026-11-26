// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
use atlas_engine_protocol::ThreadId;
use atlas_engine_protocol::items::HookPromptFragment;
use atlas_engine_utils_absolute_path::AbsolutePathBuf;
use atlas_engine_utils_output_truncation::TruncationPolicy;
use atlas_engine_utils_output_truncation::approx_token_count;
use atlas_engine_utils_output_truncation::formatted_truncate_text;
use std::io::Write;
use std::sync::Arc;
use tokio::sync::OnceCell;
use tracing::warn;
use uuid::Uuid;

const HOOK_OUTPUTS_DIR: &str = "hook_outputs";
pub(crate) const DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT: usize = 2_500;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct AdditionalContextLimit {
    token_limit: usize,
}

impl AdditionalContextLimit {
    pub(crate) fn from_config(value: Option<usize>) -> Self {
        Self {
            token_limit: value.unwrap_or(DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT),
        }
    }
}

impl Default for AdditionalContextLimit {
    fn default() -> Self {
        Self::from_config(/*value*/ None)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AdditionalContext {
    pub text: String,
    pub limit: AdditionalContextLimit,
}

#[derive(Clone)]
pub(crate) struct HookOutputSpiller {
    output_dir: Arc<OnceCell<tempfile::TempDir>>,
    prefix: String,
}

impl HookOutputSpiller {
    pub(crate) fn new(thread_id: ThreadId) -> Self {
        Self {
            output_dir: Arc::new(OnceCell::new()),
            prefix: format!("{HOOK_OUTPUTS_DIR}-{thread_id}-"),
        }
    }

    /// Keeps hook text within the model-visible hook-output budget.
    ///
    /// Oversized text is written in full under the OS temp directory at
    /// a private, randomly named per-session directory, and replaced with a
    /// head/tail preview plus a path back to the preserved full text. The final
    /// owner removes the directory when the session ends.
    pub(crate) async fn maybe_spill_text(&self, text: String) -> String {
        self.maybe_spill_text_with_limit(text, AdditionalContextLimit::default())
            .await
    }

    async fn maybe_spill_text_with_limit(
        &self,
        text: String,
        limit: AdditionalContextLimit,
    ) -> String {
        let token_limit = limit.token_limit;
        if token_limit == 0 || approx_token_count(&text) <= token_limit {
            return text;
        }

        let directory = self
            .output_dir
            .get_or_try_init(|| async {
                let prefix = self.prefix.clone();
                tokio::task::spawn_blocking(move || {
                    let mut builder = tempfile::Builder::new();
                    builder.prefix(&prefix);
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        builder.permissions(std::fs::Permissions::from_mode(0o700));
                    }
                    builder.tempdir()
                })
                .await
                .map_err(std::io::Error::other)?
            })
            .await;
        let directory = match directory {
            Ok(directory) => directory,
            Err(error) => {
                warn!("failed to create private hook output directory: {error}");
                return formatted_truncate_text(&text, TruncationPolicy::Tokens(token_limit));
            }
        };
        let path = AbsolutePathBuf::resolve_path_against_base(directory.path(), "/")
            .join(format!("{}.txt", Uuid::new_v4()));
        let preview = spilled_hook_output_preview(&text, &path, token_limit);
        let fallback = formatted_truncate_text(&text, TruncationPolicy::Tokens(token_limit));
        let write_path = path.to_path_buf();
        let write = tokio::task::spawn_blocking(move || {
            let parent = write_path.parent().expect("spill path has parent");
            // NamedTempFile is private at creation; no secret bytes are written
            // to a permissive file even when the process umask is permissive.
            let mut file = tempfile::NamedTempFile::new_in(parent)?;
            file.write_all(text.as_bytes())?;
            file.persist_noclobber(write_path)
                .map_err(|error| error.error)?;
            Ok::<_, std::io::Error>(())
        })
        .await;
        if !matches!(write, Ok(Ok(()))) {
            warn!("failed to write hook output {}", path.display());
            return fallback;
        }

        preview
    }

    pub(crate) async fn maybe_spill_additional_contexts(
        &self,
        contexts: Vec<AdditionalContext>,
    ) -> Vec<String> {
        let mut spilled = Vec::with_capacity(contexts.len());
        for context in contexts {
            spilled.push(
                self.maybe_spill_text_with_limit(context.text, context.limit)
                    .await,
            );
        }
        spilled
    }

    pub(crate) async fn maybe_spill_prompt_fragments(
        &self,
        fragments: Vec<HookPromptFragment>,
    ) -> Vec<HookPromptFragment> {
        let mut spilled = Vec::with_capacity(fragments.len());
        for fragment in fragments {
            spilled.push(HookPromptFragment {
                text: self.maybe_spill_text(fragment.text).await,
                hook_run_id: fragment.hook_run_id,
            });
        }
        spilled
    }
}

/// Builds the model-visible replacement for a spilled hook output.
///
/// The path footer is budgeted before truncation so adding the recovery path
/// does not consume the configured preview budget.
fn spilled_hook_output_preview(text: &str, path: &AbsolutePathBuf, token_limit: usize) -> String {
    let footer = format!("\n\nFull hook output saved to: {}", path.display());
    let preview_policy =
        TruncationPolicy::Tokens(token_limit.saturating_sub(approx_token_count(&footer)));
    format!("{}{footer}", formatted_truncate_text(text, preview_policy))
}

#[cfg(test)]
#[path = "output_spill_tests.rs"]
mod tests;
