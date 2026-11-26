//! The index and the working tree: staging, discarding, and the stash.

use serde::Serialize;

use super::{Repository, Result, US};
use crate::error::GitErrorPayload;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct StashEntry {
    pub index: u32,
    pub message: String,
    pub branch: String,
}

impl Repository<'_> {
    /// Stage `files`. Nothing to stage is not a git run. The watcher sees
    /// the index move; nobody else is told.
    pub fn stage(&self, files: &[String]) -> Result<()> {
        if files.is_empty() {
            return Ok(());
        }
        self.git(&["add"]).pathspecs(files).run()?;
        Ok(())
    }

    /// Unstage `files`, leaving the working tree alone.
    pub fn unstage(&self, files: &[String]) -> Result<()> {
        if files.is_empty() {
            return Ok(());
        }
        self.git(&["restore", "--staged"]).pathspecs(files).run()?;
        Ok(())
    }

    /// Discard tracked changes (staged and working tree) for `files`, back
    /// to HEAD. Untracked files are left alone (deleting them is
    /// destructive, and is [`delete_added`](Self::delete_added)'s).
    pub fn discard(&self, files: &[String]) -> Result<()> {
        if files.is_empty() {
            return Ok(());
        }
        self.git(&["restore", "--staged", "--worktree"])
            .pathspecs(files)
            .run()?;
        self.changed();
        Ok(())
    }

    /// "Revert" added files (new or untracked). There is no HEAD version to
    /// restore, so reverting an addition means removing it: any staged index
    /// entry is dropped (`--cached --ignore-unmatch`, so an untracked file
    /// is a no-op rather than an error) and the working-tree copy deleted.
    /// This is the only way to revert an added binary, which has no diff.
    ///
    /// The notifier is told once the index has been touched, before the
    /// files go, whether or not git succeeded.
    pub fn delete_added(&self, files: &[String]) -> Result<()> {
        if files.is_empty() {
            return Ok(());
        }
        let root = std::fs::canonicalize(self.path())
            .map_err(|e| GitErrorPayload::internal(e.to_string()))?;
        for file in files {
            let relative = std::path::Path::new(file);
            if file.is_empty()
                || relative
                    .components()
                    .any(|part| !matches!(part, std::path::Component::Normal(_)))
                || relative.components().next()
                    == Some(std::path::Component::Normal(std::ffi::OsStr::new(".git")))
            {
                return Err(GitErrorPayload::internal(
                    "Only paths inside the working tree can be deleted",
                ));
            }
            // Remove a selected symlink itself, but never follow an intermediate
            // directory link to delete somebody else's tree.
            if let Some(parent) = self.path().join(relative).parent() {
                match std::fs::canonicalize(parent) {
                    Ok(parent) if !parent.starts_with(&root) => {
                        return Err(GitErrorPayload::internal(
                            "Deletion would escape the working tree",
                        ));
                    }
                    Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                        return Err(GitErrorPayload::internal(e.to_string()));
                    }
                    _ => {}
                }
            }
        }
        // Remove from the index if it was staged-new; ignore untracked ones.
        if !files.is_empty() {
            let _ = self
                .git(&["rm", "-r", "-f", "--cached", "--ignore-unmatch"])
                .pathspecs(files)
                .run();
            self.changed();
        }
        // Delete the working-tree copies.
        for f in files {
            let abs = self.path().join(f);
            // Symlink metadata keeps dangling links removable, and prevents
            // following a directory link outside the selected tree.
            match std::fs::symlink_metadata(&abs) {
                Ok(meta) => {
                    (if meta.is_dir() {
                        std::fs::remove_dir_all(&abs)
                    } else {
                        std::fs::remove_file(&abs)
                    })
                    .map_err(|e| GitErrorPayload::internal(format!("Failed to delete {f}: {e}")))?;
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    return Err(GitErrorPayload::internal(format!(
                        "Failed to inspect {f}: {e}"
                    )))
                }
            }
        }
        Ok(())
    }

    /// The stash, newest first. `index` is the position (`stash@{index}`).
    pub fn stashes(&self) -> Result<Vec<StashEntry>> {
        let out = self.out(&["stash", "list", &format!("--format=%gd{US}%gs")])?;
        Ok(out
            .lines()
            .filter(|l| !l.is_empty())
            .enumerate()
            .map(|(i, line)| {
                let p: Vec<&str> = line.split(US).collect();
                let gs = p.get(1).copied().unwrap_or("");
                // "WIP on main: abc1234 message" → branch = "main"
                let branch = gs
                    .strip_prefix("WIP on ")
                    .or_else(|| gs.strip_prefix("On "))
                    .and_then(|s| s.split(':').next())
                    .unwrap_or("")
                    .to_string();
                StashEntry {
                    index: i as u32,
                    message: gs.to_string(),
                    branch,
                }
            })
            .collect())
    }

    /// Stash tracked changes; a blank message is no message. Untracked files
    /// stay where they are, as with a plain `git stash`.
    pub fn stash_push(&self, message: Option<&str>) -> Result<()> {
        let mut args = vec!["stash", "push"];
        if let Some(m) = message.filter(|m| !m.trim().is_empty()) {
            args.extend(["-m", m]);
        }
        self.mutate(&args)?;
        Ok(())
    }

    /// Apply a stash and keep it.
    pub fn stash_apply(&self, index: u32) -> Result<()> {
        self.mutate(&["stash", "apply", &format!("stash@{{{index}}}")])?;
        Ok(())
    }

    /// Apply a stash and drop it. A pop that conflicts keeps the stash.
    pub fn stash_pop(&self, index: u32) -> Result<()> {
        self.mutate(&["stash", "pop", &format!("stash@{{{index}}}")])?;
        Ok(())
    }

    pub fn stash_drop(&self, index: u32) -> Result<()> {
        self.mutate(&["stash", "drop", &format!("stash@{{{index}}}")])?;
        Ok(())
    }
}
