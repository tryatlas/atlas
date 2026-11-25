// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
use super::*;
use anyhow::Context;
use anyhow::Result;
use tokio::fs;

#[tokio::test]
async fn small_hook_output_remains_inline() -> Result<()> {
    let spiller = HookOutputSpiller::new(ThreadId::new());

    let output = spiller.maybe_spill_text("short".to_string()).await;

    assert_eq!(output, "short");
    assert!(spiller.output_dir.get().is_none());
    Ok(())
}

#[tokio::test]
async fn large_hook_output_spills_to_file() -> Result<()> {
    let text = "hook output ".repeat(1_000);
    let spiller = HookOutputSpiller::new(ThreadId::new());

    let output = spiller.maybe_spill_text(text.clone()).await;

    assert!(output.contains("tokens truncated"));
    let path = output
        .lines()
        .find_map(|line| line.strip_prefix("Full hook output saved to: "))
        .context("spill path")?;
    assert_eq!(fs::read_to_string(path).await?, text);
    Ok(())
}

#[tokio::test]
async fn additional_contexts_apply_limits_individually() -> Result<()> {
    let limited_text = "limited hook output ".repeat(1_000);
    let unlimited_text = "unlimited hook output ".repeat(5_000);
    assert!(approx_token_count(&unlimited_text) > 10_000);
    let spiller = HookOutputSpiller::new(ThreadId::new());
    let output = spiller
        .maybe_spill_additional_contexts(vec![
            AdditionalContext {
                text: limited_text.clone(),
                limit: AdditionalContextLimit::from_config(Some(1)),
            },
            AdditionalContext {
                text: unlimited_text.clone(),
                limit: AdditionalContextLimit::from_config(Some(0)),
            },
            AdditionalContext {
                text: unlimited_text.clone(),
                limit: AdditionalContextLimit::from_config(Some(usize::MAX)),
            },
        ])
        .await;
    let [limited_output, zero_limit_output, high_limit_output] = output.as_slice() else {
        panic!("expected one output for each additional context");
    };
    assert!(limited_output.contains("Full hook output saved to:"));
    assert_eq!(zero_limit_output, &unlimited_text);
    assert_eq!(high_limit_output, &unlimited_text);
    Ok(())
}

#[tokio::test]
async fn spills_are_private_and_removed_when_the_final_session_owner_drops() -> Result<()> {
    let spiller = HookOutputSpiller::new(ThreadId::new());
    let other_owner = spiller.clone();
    let output = spiller
        .maybe_spill_text("private content ".repeat(2000))
        .await;
    let path = std::path::PathBuf::from(
        output
            .lines()
            .find_map(|line| line.strip_prefix("Full hook output saved to: "))
            .context("spill path")?,
    );
    let directory = path.parent().context("spill directory")?.to_path_buf();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&directory).await?.permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).await?.permissions().mode() & 0o777,
            0o600
        );
    }
    drop(spiller);
    assert!(path.exists());
    drop(other_owner);
    assert!(!directory.exists());
    Ok(())
}
