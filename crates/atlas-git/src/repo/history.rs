//! Moving through history: undo, squash, reset, revert, cherry-pick, tags,
//! one commit's detail, and the operation a conflict left in progress.

use serde::Serialize;

use super::{Repository, Result, US};
use crate::error::GitErrorPayload;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub hash: String,
    pub short_hash: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub subject: String,
    pub body: String,
    pub diff: String,
}

/// Which operations a conflict has left waiting to be continued or aborted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InProgress {
    pub merge: bool,
    pub rebase: bool,
    pub cherry_pick: bool,
    pub revert: bool,
}

/// What `git reset` does with the index and the working tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResetMode {
    /// Move HEAD only: the difference stays staged.
    Soft,
    /// git's default: the difference is unstaged, the files untouched.
    Mixed,
    /// The difference is discarded.
    Hard,
}

impl ResetMode {
    /// `"soft"` or `"hard"`; anything else is git's own default, mixed.
    pub fn parse(mode: &str) -> Self {
        match mode {
            "soft" => ResetMode::Soft,
            "hard" => ResetMode::Hard,
            _ => ResetMode::Mixed,
        }
    }

    fn flag(self) -> &'static str {
        match self {
            ResetMode::Soft => "--soft",
            ResetMode::Mixed => "--mixed",
            ResetMode::Hard => "--hard",
        }
    }
}

/// An operation git can leave in progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InProgressKind {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

impl InProgressKind {
    /// The git subcommand's own name: `merge`, `rebase`, `cherry-pick`,
    /// `revert`.
    pub fn parse(kind: &str) -> Option<Self> {
        Some(match kind {
            "merge" => InProgressKind::Merge,
            "rebase" => InProgressKind::Rebase,
            "cherry-pick" => InProgressKind::CherryPick,
            "revert" => InProgressKind::Revert,
            _ => return None,
        })
    }

    fn subcommand(self) -> &'static str {
        match self {
            InProgressKind::Merge => "merge",
            InProgressKind::Rebase => "rebase",
            InProgressKind::CherryPick => "cherry-pick",
            InProgressKind::Revert => "revert",
        }
    }
}

/// What to do with an operation in progress.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpAction {
    Abort,
    Continue,
}

impl OpAction {
    /// `"continue"`; anything else aborts.
    pub fn parse(action: &str) -> Self {
        if action == "continue" {
            OpAction::Continue
        } else {
            OpAction::Abort
        }
    }
}

impl Repository<'_> {
    /// How many commits HEAD is ahead of its upstream; `None` when the
    /// branch has no upstream (git exits 128), where nothing is pushed.
    fn ahead_of_upstream(&self) -> Result<Option<u32>> {
        let ahead = self
            .git(&["rev-list", "--count", "@{upstream}..HEAD"])
            .read_only()
            .success_codes(&[0, 128])
            .run()?;
        Ok((ahead.exit_code == 0).then(|| ahead.stdout.trim().parse::<u32>().unwrap_or(0)))
    }

    /// Undo the last commit (`reset --soft HEAD~1`: its changes return to
    /// the index). Refused for the first commit of a repository, and when
    /// the commit is already on the upstream: rewriting pushed history needs
    /// an explicit force-push decision, not an "undo".
    pub fn undo_commit(&self) -> Result<()> {
        // HEAD must have a parent.
        self.git(&["rev-parse", "--verify", "HEAD~1"])
            .read_only()
            .run()
            .map_err(|_| {
                GitErrorPayload::internal("The first commit of a repository can't be undone.")
            })?;
        // Not already pushed: with an upstream, ahead must be ≥ 1.
        if self.ahead_of_upstream()? == Some(0) {
            return Err(GitErrorPayload::internal(
                "This commit is already pushed. Revert it instead of undoing it.",
            ));
        }
        self.mutate(&["reset", "--soft", "HEAD~1"])?;
        Ok(())
    }

    /// Squash the last `count` commits into one with this message.
    /// Implemented as `reset --soft HEAD~N` plus a fresh commit — equivalent
    /// to an interactive tail squash, without the todo-file machinery.
    /// Refused for fewer than two commits, for more than the branch has, and
    /// when the range reaches into pushed history (same guard as undo).
    ///
    /// Once the reset has run the notifier is told even if the commit then
    /// fails (a hook), because HEAD has already moved.
    pub fn squash_last(&self, count: u32, summary: &str, description: Option<&str>) -> Result<()> {
        if count < 2 {
            return Err(GitErrorPayload::internal(
                "Squash needs at least 2 commits.",
            ));
        }
        self.git(&["rev-parse", "--verify", &format!("HEAD~{count}")])
            .read_only()
            .run()
            .map_err(|_| GitErrorPayload::internal("Not enough commits to squash."))?;
        if self.ahead_of_upstream()?.is_some_and(|ahead| ahead < count) {
            return Err(GitErrorPayload::internal(
                "Some of these commits are already pushed — squashing would rewrite shared history.",
            ));
        }

        self.git(&["reset", "--soft", &format!("HEAD~{count}")])
            .run()?;
        let commit = self
            .git(&["commit", "-F", "-"])
            .stdin(super::commit::message(summary, description).into_bytes())
            .run();
        self.changed();
        commit?;
        Ok(())
    }

    /// `git reset` to `target`.
    pub fn reset(&self, target: &str, mode: ResetMode) -> Result<()> {
        self.mutate(&["reset", mode.flag(), target])?;
        Ok(())
    }

    /// Revert `sha` with a no-edit commit. A merge commit is reverted
    /// against its first parent. A revert that conflicts fails as
    /// `merge-conflicts` and leaves the revert in progress.
    pub fn revert(&self, sha: &str) -> Result<String> {
        // Plain revert first; merge commits need a parent (-m 1).
        let out = match self.out(&["revert", "--no-edit", sha]) {
            Ok(o) => o,
            Err(e) if e.raw_stderr.contains("is a merge") || e.raw_stderr.contains("mainline") => {
                self.out(&["revert", "--no-edit", "-m", "1", sha])?
            }
            Err(e) => return Err(e),
        };
        self.changed();
        Ok(out)
    }

    /// Copy `sha` onto the current branch. A pick that conflicts fails as
    /// `merge-conflicts` and leaves the pick in progress.
    pub fn cherry_pick(&self, sha: &str) -> Result<String> {
        self.mutate(&["cherry-pick", sha])
    }

    /// Continue or abort an operation in progress. A merge has no
    /// `--continue`; finishing it is a no-edit commit.
    pub fn control(&self, kind: InProgressKind, action: OpAction) -> Result<String> {
        match (kind, action) {
            (InProgressKind::Merge, OpAction::Continue) => self.mutate(&["commit", "--no-edit"]),
            (kind, OpAction::Continue) => {
                let out = self
                    .git(&[kind.subcommand(), "--continue"])
                    .env("GIT_EDITOR", "true")
                    .env("GIT_SEQUENCE_EDITOR", "true")
                    .run()?
                    .stdout;
                self.changed();
                Ok(out)
            }
            (kind, OpAction::Abort) => self.mutate(&[kind.subcommand(), "--abort"]),
        }
    }

    /// Which operations are waiting, read from the markers git leaves in its
    /// directory.
    pub fn in_progress(&self) -> Result<InProgress> {
        let git_dir = self
            .out(&["rev-parse", "--absolute-git-dir"])?
            .trim()
            .to_string();
        let exists = |p: &str| std::path::Path::new(&git_dir).join(p).exists();
        Ok(InProgress {
            merge: exists("MERGE_HEAD"),
            rebase: exists("rebase-merge") || exists("rebase-apply"),
            cherry_pick: exists("CHERRY_PICK_HEAD"),
            revert: exists("REVERT_HEAD"),
        })
    }

    /// Tag names, newest first.
    pub fn tags(&self) -> Result<Vec<String>> {
        let out = self.out(&["tag", "--sort=-creatordate"])?;
        Ok(out
            .lines()
            .filter(|l| !l.is_empty())
            .map(String::from)
            .collect())
    }

    /// An annotated tag at `target` (HEAD when `None` or empty). No message
    /// is an empty one, which git refuses.
    pub fn create_tag(
        &self,
        name: &str,
        target: Option<&str>,
        message: Option<&str>,
    ) -> Result<()> {
        let mut args = vec!["tag", "-a", name, "-m", message.unwrap_or_default()];
        if let Some(t) = target.filter(|t| !t.is_empty()) {
            args.push(t);
        }
        self.mutate(&args)?;
        Ok(())
    }

    pub fn delete_tag(&self, name: &str) -> Result<()> {
        self.mutate(&["tag", "-d", name])?;
        Ok(())
    }

    /// One commit for the history view: who, when, what it says and its
    /// diff. `ignore_whitespace` reads the diff with `-w`.
    pub fn show(&self, sha: &str, ignore_whitespace: bool) -> Result<CommitDetail> {
        let fmt = format!("%H{US}%h{US}%an{US}%ae{US}%ad{US}%s{US}%b");
        let meta = self.out(&[
            "log",
            "-1",
            "--date=format:%Y-%m-%d %H:%M",
            &format!("--format={fmt}"),
            sha,
        ])?;
        let p: Vec<&str> = meta.trim_end().split(US).collect();
        // Diff only (empty --format suppresses the header). `-m --first-parent`
        // shows a merge as what it brought into its branch — the default is a
        // combined `diff --cc`, which is empty for a clean merge and not a
        // unified diff the viewer can read. No effect on ordinary commits.
        let mut args = vec!["show", "--no-color", "--format=", "-m", "--first-parent"];
        if ignore_whitespace {
            args.push("-w");
        }
        args.push(sha);
        let diff = self.out(&args)?;
        let field = |i: usize| p.get(i).copied().unwrap_or("");
        Ok(CommitDetail {
            hash: field(0).to_string(),
            short_hash: field(1).to_string(),
            author: field(2).to_string(),
            email: field(3).to_string(),
            date: field(4).to_string(),
            subject: field(5).to_string(),
            body: field(6).trim().to_string(),
            diff,
        })
    }
}
