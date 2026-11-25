//! Where pack content comes from: source parsing and the fetch seam.

use std::fs;
use std::path::{Path, PathBuf};

// ── GitHub source resolution + fetch ──────────────────────────────────────────

/// A safe GitHub `owner`/`repo` segment: ASCII alnum plus `.`/`_`/`-`, never
/// leading `-` (so it can't be misread as a `git` flag). Keeps the values safe
/// as clone-URL components and process arguments.
fn is_safe_gh_segment(s: &str) -> bool {
    !s.is_empty()
        && !s.starts_with('-')
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Parse a skills.sh `source` into `(owner, repo)`. Accepts `owner/repo`,
/// `owner/repo/extra…` (extra ignored), and `https://github.com/owner/repo[.git]`.
pub(crate) fn parse_owner_repo(source: &str) -> Result<(String, String), String> {
    let s = source.trim();
    let s = s
        .strip_prefix("https://github.com/")
        .or_else(|| s.strip_prefix("http://github.com/"))
        .or_else(|| s.strip_prefix("github.com/"))
        .unwrap_or(s);
    let mut parts = s.split('/').filter(|p| !p.is_empty());
    let owner = parts
        .next()
        .ok_or_else(|| format!("invalid source: {source:?}"))?;
    let repo = parts
        .next()
        .ok_or_else(|| format!("invalid source (need owner/repo): {source:?}"))?;
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if !is_safe_gh_segment(owner) || !is_safe_gh_segment(repo) {
        return Err(format!("unsafe source segments: {source:?}"));
    }
    Ok((owner.to_string(), repo.to_string()))
}

/// Unique (not-yet-created) temp path for a clone.
fn temp_clone_path() -> PathBuf {
    let mut p = std::env::temp_dir();
    let uniq = format!(
        "atlas-pack-clone-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    p.push(uniq);
    p
}

/// Shallow-clone `owner/repo` into `dest` (must not pre-exist) and return the
/// HEAD commit SHA. Never prompts — auth failures fail fast.
fn git_clone_shallow(owner: &str, repo: &str, dest: &Path) -> Result<String, String> {
    let url = format!("https://github.com/{owner}/{repo}.git");
    let out = atlas_git::shallow_clone(&url, dest)
        .map_err(|e| format!("failed to run `git` (is it installed?): {e}"))?;
    if !out.success() {
        return Err(format!(
            "git clone of {owner}/{repo} failed: {}",
            out.stderr_text().trim()
        ));
    }
    let rev = atlas_git::GitCommand::without_repo(&["-C"])
        .arg(dest)
        .args(&["rev-parse", "HEAD"])
        .timeout(std::time::Duration::from_secs(30))
        .output()
        .map_err(|e| format!("failed to read HEAD: {e}"))?;
    Ok(rev.stdout_text().trim().to_string())
}

/// Resolve the remote default-branch HEAD SHA WITHOUT fetching content
/// (`git ls-remote <url> HEAD`). Network-only, auth-free for public repos, never
/// prompts. Used to detect whether an installed pack is behind its source.
fn git_ls_remote_head(owner: &str, repo: &str) -> Result<String, String> {
    let url = format!("https://github.com/{owner}/{repo}.git");
    let out = atlas_git::GitCommand::without_repo(&["ls-remote", "--quiet", &url, "HEAD"])
        .timeout(std::time::Duration::from_secs(30))
        .output()
        .map_err(|e| format!("failed to run `git` (is it installed?): {e}"))?;
    if !out.success() {
        return Err(format!(
            "git ls-remote of {owner}/{repo} failed: {}",
            out.stderr_text().trim()
        ));
    }
    // Output is `<sha>\tHEAD` — take the first whitespace-delimited token.
    out.stdout_text()
        .split_whitespace()
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "git ls-remote returned no HEAD".to_string())
}

/// Clone `owner/repo` to a temp dir and strip its `.git`. Returns
/// `(temp_dir, commit_sha)`; the caller must remove `temp_dir` when done.
fn fetch_repo_to_temp(owner: &str, repo: &str) -> Result<(PathBuf, String), String> {
    let dest = temp_clone_path();
    match git_clone_shallow(owner, repo, &dest) {
        Ok(commit) => {
            // Drop VCS metadata so it never lands in the store or content hash.
            let _ = fs::remove_dir_all(dest.join(".git"));
            Ok((dest, commit))
        }
        Err(e) => {
            let _ = fs::remove_dir_all(&dest);
            Err(e)
        }
    }
}

/// Where a pack's content comes from. The app's is GitHub over `git`
/// ([`GitHub`]); a test's is a directory on disk.
pub trait PackSource {
    /// Fetch `owner/repo` into a fresh directory with no VCS metadata in it and
    /// return `(dir, commit)`. The caller removes `dir` when it is done.
    fn fetch(&self, owner: &str, repo: &str) -> Result<(PathBuf, String), String>;
    /// The source's current HEAD commit, without fetching any content.
    fn head_commit(&self, owner: &str, repo: &str) -> Result<String, String>;
}

/// `https://github.com/<owner>/<repo>.git`, shallow-cloned through
/// [`atlas_git`]. Never prompts: an auth failure fails fast.
pub struct GitHub;

impl PackSource for GitHub {
    fn fetch(&self, owner: &str, repo: &str) -> Result<(PathBuf, String), String> {
        fetch_repo_to_temp(owner, repo)
    }

    fn head_commit(&self, owner: &str, repo: &str) -> Result<String, String> {
        git_ls_remote_head(owner, repo)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_owner_repo_accepts_shorthand_url_and_extra() {
        assert_eq!(
            parse_owner_repo("openai/skills").unwrap(),
            ("openai".into(), "skills".into())
        );
        // Extra path segments (the skillId) are ignored — we install the repo.
        assert_eq!(
            parse_owner_repo("openai/skills/pdf").unwrap(),
            ("openai".into(), "skills".into())
        );
        assert_eq!(
            parse_owner_repo("https://github.com/vercel-labs/agent-skills.git").unwrap(),
            ("vercel-labs".into(), "agent-skills".into())
        );
        assert_eq!(
            parse_owner_repo("github.com/foo/bar").unwrap(),
            ("foo".into(), "bar".into())
        );
    }

    #[test]
    fn parse_owner_repo_rejects_bad_and_unsafe_sources() {
        assert!(parse_owner_repo("justone").is_err()); // no repo segment
        assert!(parse_owner_repo("").is_err());
        // Argument-injection guard: a leading-dash segment must be rejected.
        assert!(parse_owner_repo("-evil/repo").is_err());
        assert!(parse_owner_repo("owner/--upload-pack").is_err());
        assert!(parse_owner_repo("ow ner/repo").is_err()); // space
        assert!(!is_safe_gh_segment("-x"));
        assert!(is_safe_gh_segment("vercel-labs"));
        assert!(is_safe_gh_segment("agent.skills_v2"));
    }
}
