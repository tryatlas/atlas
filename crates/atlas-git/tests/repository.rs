//! Every rule [`Repository`] encodes, against real temporary repositories
//! and through its public interface only.
//!
//! Each repository runs under a hermetic environment: no global or system
//! git config (a developer's `commit.gpgsign` or `core.hooksPath` must not
//! decide a result) and a fixed identity. A remote is a bare repository on
//! disk, so nothing touches the network.
//!
//! One [`Log`] is both the injected change notifier and the operation
//! observer, so a test reads the order things happened in, and how often
//! the notifier was told, from one list.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use atlas_git::repo::{
    CommitRequest, InProgressKind, MergePreviewKind, OpAction, PullPreference, PullStrategy,
    PushOptions, ResetMode,
};
use atlas_git::{
    ChangeNotifier, GitCommand, GitErrorCode, GitErrorPayload, OpObserver, Repository, Stream,
};

const HERMETIC_ENV: &[(&str, &str)] = &[
    ("GIT_CONFIG_GLOBAL", "/dev/null"),
    ("GIT_CONFIG_NOSYSTEM", "1"),
    ("GIT_AUTHOR_NAME", "Atlas Test"),
    ("GIT_AUTHOR_EMAIL", "test@atlas.invalid"),
    ("GIT_COMMITTER_NAME", "Atlas Test"),
    ("GIT_COMMITTER_EMAIL", "test@atlas.invalid"),
];

/// Plain git under the hermetic environment: the tests' own setup.
fn hermetic(path: &Path, args: &[&str]) -> Result<String, GitErrorPayload> {
    let mut cmd = GitCommand::new(path, args);
    for (k, v) in HERMETIC_ENV {
        cmd = cmd.env(k, v);
    }
    Ok(cmd.run()?.stdout)
}

/// What the notifier and the observer were told, in order.
#[derive(Default)]
struct Log(Mutex<Vec<String>>);

impl Log {
    fn push(&self, entry: impl Into<String>) {
        self.0.lock().unwrap().push(entry.into());
    }

    fn entries(&self) -> Vec<String> {
        self.0.lock().unwrap().clone()
    }

    /// How many times the notifier was told.
    fn changes(&self) -> usize {
        self.entries().iter().filter(|e| *e == "changed").count()
    }

    /// The lifecycle without the output lines.
    fn lifecycle(&self) -> Vec<String> {
        self.entries()
            .into_iter()
            .filter(|e| !e.starts_with("out:") && e != "progress")
            .collect()
    }

    fn output(&self) -> String {
        self.entries()
            .iter()
            .filter_map(|e| e.strip_prefix("out:"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn clear(&self) {
        self.0.lock().unwrap().clear();
    }
}

impl ChangeNotifier for Log {
    fn changed(&self, _repo: &Path) {
        self.push("changed");
    }
}

impl OpObserver for Log {
    fn started(&self) {
        self.push("started");
    }
    fn output(&self, _stream: Stream, line: &str) {
        self.push(format!("out:{line}"));
    }
    fn progress(&self, _fraction: f32, _title: &str) {
        self.push("progress");
    }
    fn finished(&self, error: Option<&GitErrorPayload>) {
        self.push(match error {
            None => "finished:ok".to_string(),
            Some(e) => format!("finished:{:?}", e.code),
        });
    }
}

/// A working repository on `main`, with helpers that panic on failure —
/// setup is not what is under test.
struct Repo {
    path: PathBuf,
    log: Log,
}

impl Repo {
    fn init(dir: &Path) -> Self {
        std::fs::create_dir_all(dir).unwrap();
        let repo = Repo {
            path: dir.to_path_buf(),
            log: Log::default(),
        };
        repo.git(&["init", "-q", "-b", "main"]);
        repo
    }

    /// The repository as the code under test sees it.
    fn ops(&self) -> Repository<'_> {
        let mut repo = Repository::new(&self.path, &self.log);
        for (k, v) in HERMETIC_ENV {
            repo = repo.env(k, v);
        }
        repo
    }

    fn git(&self, args: &[&str]) -> String {
        hermetic(&self.path, args).unwrap_or_else(|e| panic!("git {args:?}: {}", e.raw_stderr))
    }

    fn write(&self, file: &str, contents: &str) {
        std::fs::write(self.path.join(file), contents).unwrap();
    }

    fn read(&self, file: &str) -> String {
        std::fs::read_to_string(self.path.join(file)).unwrap()
    }

    fn exists(&self, file: &str) -> bool {
        self.path.join(file).exists()
    }

    fn commit(&self, file: &str, contents: &str, message: &str) -> String {
        self.write(file, contents);
        self.git(&["add", file]);
        self.git(&["commit", "-q", "-m", message]);
        self.head()
    }

    fn head(&self) -> String {
        self.rev("HEAD")
    }

    fn rev(&self, rev: &str) -> String {
        self.git(&["rev-parse", rev]).trim().to_string()
    }

    fn branch(&self) -> String {
        self.git(&["branch", "--show-current"]).trim().to_string()
    }

    fn subject(&self) -> String {
        self.git(&["log", "-1", "--format=%s"]).trim().to_string()
    }

    fn body(&self) -> String {
        self.git(&["log", "-1", "--format=%B"]).trim().to_string()
    }

    fn staged(&self) -> String {
        self.git(&["diff", "--cached", "--name-only"])
            .trim()
            .to_string()
    }

    fn unstaged(&self) -> String {
        self.git(&["diff", "--name-only"]).trim().to_string()
    }

    fn has_git_file(&self, name: &str) -> bool {
        self.path.join(".git").join(name).exists()
    }

    #[cfg(unix)]
    fn hook(&self, name: &str, body: &str) {
        let hooks = self.path.join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let path = hooks.join(name);
        std::fs::write(&path, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
}

fn scratch() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("atlas-git-repo-")
        .tempdir()
        .unwrap()
}

/// `a.txt` at "1" then "2": two commits to move between.
fn two_commits(dir: &Path) -> (Repo, String, String) {
    let repo = Repo::init(dir);
    let first = repo.commit("a.txt", "1\n", "first");
    let second = repo.commit("a.txt", "2\n", "second");
    (repo, first, second)
}

/// A clone of a fresh bare remote with one published commit on `main`.
fn published(dir: &Path) -> (Repo, PathBuf) {
    let remote = dir.join("remote.git");
    std::fs::create_dir_all(&remote).unwrap();
    hermetic(&remote, &["init", "-q", "--bare", "-b", "main"]).unwrap();

    let repo = Repo::init(&dir.join("work"));
    repo.git(&["remote", "add", "origin", remote.to_str().unwrap()]);
    repo.commit("a.txt", "1\n", "first");
    repo.git(&["push", "-q", "-u", "origin", "HEAD"]);
    (repo, remote)
}

fn remote_main(remote: &Path) -> String {
    hermetic(remote, &["rev-parse", "main"])
        .unwrap()
        .trim()
        .to_string()
}

/// A second clone that pushes one commit to the remote's `main`, changing
/// `file`. Returns that commit.
fn someone_else_pushes(dir: &Path, remote: &Path, file: &str) -> String {
    let other = Repo::init(&dir.join("other"));
    other.git(&["remote", "add", "origin", remote.to_str().unwrap()]);
    other.git(&["fetch", "-q", "origin"]);
    other.git(&["reset", "-q", "--hard", "origin/main"]);
    let theirs = other.commit(file, "theirs\n", "theirs");
    other.git(&["push", "-q", "origin", "HEAD:main"]);
    theirs
}

/// `repo` and the remote each gain a commit on `main` (different files, so
/// reconciling never conflicts). Returns the remote's new commit.
fn diverged(dir: &Path) -> (Repo, String) {
    let (repo, remote) = published(dir);
    let theirs = someone_else_pushes(dir, &remote, "theirs.txt");
    repo.commit("ours.txt", "ours\n", "ours");
    (repo, theirs)
}

/// `main` and `feature` both edit `a.txt` from a shared base, with `main`
/// checked out: merging, picking or rebasing across them conflicts.
fn conflicting(dir: &Path) -> (Repo, String) {
    let repo = Repo::init(dir);
    repo.commit("a.txt", "base\n", "base");
    repo.git(&["checkout", "-q", "-b", "feature"]);
    let feature = repo.commit("a.txt", "feature\n", "feature edit");
    repo.git(&["checkout", "-q", "main"]);
    repo.commit("a.txt", "main\n", "main edit");
    (repo, feature)
}

fn is_conflict(err: &GitErrorPayload) -> bool {
    matches!(
        err.code,
        GitErrorCode::RebaseConflicts | GitErrorCode::MergeConflicts
    )
}

fn files(names: &[&str]) -> Vec<String> {
    names.iter().map(ToString::to_string).collect()
}

// ── the notifier ──────────────────────────────────────────────────────────

/// The rule every method keeps: told when the repository changed, never by a
/// read, and never by a command git refused.
#[test]
fn the_notifier_hears_a_change_and_not_a_read_or_a_refusal() {
    let dir = scratch();
    let (repo, _, _) = two_commits(dir.path());
    let ops = repo.ops();

    // Reads.
    ops.branches().unwrap();
    ops.remotes().unwrap();
    ops.stashes().unwrap();
    ops.tags().unwrap();
    ops.in_progress().unwrap();
    ops.show("HEAD", false).unwrap();
    ops.pull_preference();
    repo.git(&["branch", "other"]);
    ops.merge_preview("other").unwrap();
    assert_eq!(repo.log.changes(), 0, "a read told the notifier");

    // Refused by git: nothing changed.
    assert!(ops.rename_branch("no-such-branch", "x").is_err());
    assert!(ops.delete_branch("main", true).is_err());
    assert!(ops.reset("no-such-ref", ResetMode::Hard).is_err());
    assert!(ops.cherry_pick("no-such-ref").is_err());
    assert!(ops.delete_tag("no-such-tag").is_err());
    assert!(ops.stash_drop(7).is_err());
    assert!(ops.remove_remote("no-such-remote").is_err());
    assert!(ops.merge("no-such-branch").is_err());
    // Refused before git ran.
    assert!(ops.squash_last(1, "x", None).is_err());
    assert!(ops.squash_last(9, "x", None).is_err());
    assert_eq!(repo.log.changes(), 0, "a refusal told the notifier");

    // One change, one notification, naming this repository.
    let seen = Mutex::new(Vec::new());
    let notifier = |p: &Path| seen.lock().unwrap().push(p.to_path_buf());
    let mut closure_ops = Repository::new(&repo.path, &notifier);
    for (k, v) in HERMETIC_ENV {
        closure_ops = closure_ops.env(k, v);
    }
    closure_ops.rename_branch("other", "renamed").unwrap();
    assert_eq!(*seen.lock().unwrap(), vec![repo.path.clone()]);

    ops.create_tag("v1", None, Some("one")).unwrap();
    ops.reset("HEAD~1", ResetMode::Soft).unwrap();
    assert_eq!(repo.log.changes(), 2);
}

// ── branches ──────────────────────────────────────────────────────────────

#[test]
fn branches_lists_local_and_remote_with_tracking_and_no_symbolic_head() {
    let dir = scratch();
    let (repo, remote) = published(dir.path());
    someone_else_pushes(dir.path(), &remote, "theirs.txt");
    repo.git(&["fetch", "-q", "origin"]);
    repo.git(&["remote", "set-head", "origin", "main"]);
    repo.commit("ours.txt", "ours\n", "ours");
    repo.git(&["branch", "side"]);

    let branches = repo.ops().branches().unwrap();
    let names: Vec<&str> = branches.iter().map(|b| b.name.as_str()).collect();
    assert!(names.contains(&"main") && names.contains(&"side") && names.contains(&"origin/main"));
    assert!(
        !names.contains(&"origin") && !names.contains(&"origin/HEAD"),
        "the symbolic origin/HEAD is not a branch: {names:?}"
    );

    let main = branches.iter().find(|b| b.name == "main").unwrap();
    assert!(main.is_current && !main.is_remote);
    assert_eq!(main.upstream.as_deref(), Some("origin/main"));
    assert_eq!((main.ahead, main.behind), (1, 1));
    assert_eq!(main.subject, "ours");
    assert!(!main.date.is_empty());

    let side = branches.iter().find(|b| b.name == "side").unwrap();
    assert!(!side.is_current && side.upstream.is_none());
    assert_eq!((side.ahead, side.behind), (0, 0));

    let tracking = branches.iter().find(|b| b.name == "origin/main").unwrap();
    assert!(tracking.is_remote && !tracking.is_current);
    assert_eq!(tracking.subject, "theirs");
}

#[test]
fn a_branch_is_renamed() {
    let dir = scratch();
    let (repo, _, _) = two_commits(dir.path());
    repo.git(&["branch", "old"]);
    repo.ops().rename_branch("old", "new").unwrap();
    assert!(hermetic(&repo.path, &["rev-parse", "--verify", "new"]).is_ok());
    assert!(hermetic(&repo.path, &["rev-parse", "--verify", "old"]).is_err());
    assert_eq!(repo.log.changes(), 1);

    // Onto a name that is taken: refused, typed.
    repo.git(&["branch", "taken"]);
    let err = repo.ops().rename_branch("new", "taken").unwrap_err();
    assert_eq!(
        err.code,
        GitErrorCode::BranchAlreadyExists,
        "{}",
        err.raw_stderr
    );
    assert_eq!(repo.log.changes(), 1);
}

#[test]
fn deleting_refuses_the_current_branch_and_needs_force_for_unmerged_work() {
    let dir = scratch();
    let (repo, _, _) = two_commits(dir.path());
    repo.git(&["checkout", "-q", "-b", "unmerged"]);
    repo.commit("b.txt", "b\n", "only here");
    repo.git(&["checkout", "-q", "main"]);
    repo.git(&["branch", "merged"]);
    let ops = repo.ops();

    // The branch that is checked out, forced or not.
    for force in [false, true] {
        let err = ops.delete_branch("main", force).unwrap_err();
        assert!(!err.raw_stderr.is_empty());
        assert_eq!(repo.branch(), "main");
    }

    // Work that is nowhere else: only with force.
    let err = ops.delete_branch("unmerged", false).unwrap_err();
    assert!(
        err.raw_stderr.contains("not fully merged"),
        "{}",
        err.raw_stderr
    );
    assert!(hermetic(&repo.path, &["rev-parse", "--verify", "unmerged"]).is_ok());
    assert_eq!(repo.log.changes(), 0);

    ops.delete_branch("merged", false).unwrap();
    ops.delete_branch("unmerged", true).unwrap();
    assert!(hermetic(&repo.path, &["rev-parse", "--verify", "unmerged"]).is_err());
    assert_eq!(repo.log.changes(), 2);
}

#[test]
fn a_name_git_would_read_as_an_option_is_not_a_branch() {
    let dir = scratch();
    let (repo, _, second) = two_commits(dir.path());
    let ops = repo.ops();
    for name in ["", "-f", "--orphan"] {
        for err in [
            ops.checkout(name).unwrap_err(),
            ops.create_branch(name).unwrap_err(),
            ops.switch_if_clean(name).unwrap_err(),
        ] {
            assert_eq!(err.message, format!("'{name}' is not a branch name."));
        }
    }
    assert_eq!(repo.branch(), "main");
    assert_eq!(repo.head(), second);
}

#[test]
fn checkout_switches_and_reads_a_name_shared_with_a_file_as_the_branch() {
    let dir = scratch();
    let (repo, _, _) = two_commits(dir.path());
    // A branch named like a tracked file: `git checkout a.txt` would restore
    // the file and stay put.
    repo.git(&["branch", "a.txt"]);
    repo.write("a.txt", "edited\n");
    repo.ops().checkout("a.txt").unwrap();
    assert_eq!(repo.branch(), "a.txt");
    assert_eq!(
        repo.read("a.txt"),
        "edited\n",
        "the edit was not restored away"
    );

    let err = repo.ops().checkout("no-such-branch").unwrap_err();
    assert!(!err.raw_stderr.is_empty());
    assert_eq!(repo.branch(), "a.txt");
}

#[test]
fn create_branch_starts_at_head_and_switches_to_it() {
    let dir = scratch();
    let (repo, _, second) = two_commits(dir.path());
    repo.ops().create_branch("feature/x").unwrap();
    assert_eq!(repo.branch(), "feature/x");
    assert_eq!(repo.head(), second);

    let err = repo.ops().create_branch("main").unwrap_err();
    assert_eq!(
        err.code,
        GitErrorCode::BranchAlreadyExists,
        "{}",
        err.raw_stderr
    );
}

#[test]
fn switch_if_clean_refuses_a_dirty_tree_and_leaves_it_alone() {
    let dir = scratch();
    let (repo, _, _) = two_commits(dir.path());
    repo.git(&["branch", "other"]);

    // Untracked counts, staged counts, modified counts.
    type Dirty = fn(&Repo);
    let cases: [(&str, Dirty); 3] = [
        ("untracked", |r| r.write("new.txt", "new\n")),
        ("modified", |r| r.write("a.txt", "dirty\n")),
        ("staged", |r| {
            r.write("a.txt", "dirty\n");
            r.git(&["add", "a.txt"]);
        }),
    ];
    for (what, make_dirty) in cases {
        make_dirty(&repo);
        let err = repo.ops().switch_if_clean("other").unwrap_err();
        assert_eq!(err.code, GitErrorCode::UncommittedChanges, "{what}");
        assert_eq!(repo.branch(), "main", "{what}");
        repo.git(&["reset", "-q", "--hard"]);
        repo.git(&["clean", "-fdq"]);
    }

    repo.ops().switch_if_clean("other").unwrap();
    assert_eq!(repo.branch(), "other");
}

#[test]
fn merge_brings_a_branch_in_and_a_conflict_is_typed_and_left_in_progress() {
    let dir = scratch();
    let repo = Repo::init(dir.path());
    repo.commit("a.txt", "1\n", "base");
    repo.git(&["checkout", "-q", "-b", "feature"]);
    let feature = repo.commit("b.txt", "feature\n", "add b");
    repo.git(&["checkout", "-q", "main"]);
    repo.ops().merge("feature").unwrap();
    assert_eq!(repo.head(), feature, "a fast-forward");
    assert_eq!(repo.log.changes(), 1);

    let dir = scratch();
    let (repo, _) = conflicting(dir.path());
    let head = repo.head();
    let err = repo.ops().merge("feature").unwrap_err();
    assert_eq!(err.code, GitErrorCode::MergeConflicts, "{}", err.raw_stderr);
    assert!(repo.has_git_file("MERGE_HEAD"));
    assert!(repo.read("a.txt").contains("<<<<<<<"));
    assert_eq!(repo.head(), head);
    assert!(repo.ops().in_progress().unwrap().merge);
}

#[test]
fn merge_preview_says_what_a_merge_would_do_without_doing_it() {
    use MergePreviewKind::{Clean, Conflicts, Invalid, Uptodate};

    // Clean: two commits come in.
    let dir = scratch();
    let repo = Repo::init(dir.path());
    repo.commit("a.txt", "1\n", "base");
    repo.git(&["checkout", "-q", "-b", "feature"]);
    repo.commit("b.txt", "b\n", "add b");
    repo.commit("c.txt", "c\n", "add c");
    repo.git(&["checkout", "-q", "main"]);
    repo.commit("d.txt", "d\n", "add d");
    let head = repo.head();
    let preview = repo.ops().merge_preview("feature").unwrap();
    assert_eq!((preview.kind, preview.commit_count), (Clean, 2));
    assert_eq!(preview.conflicted_files, 0);

    // Up to date: everything on the branch is already here.
    repo.git(&["branch", "behind", "HEAD~1"]);
    let preview = repo.ops().merge_preview("behind").unwrap();
    assert_eq!((preview.kind, preview.commit_count), (Uptodate, 0));

    // Unrelated histories.
    repo.git(&["checkout", "-q", "--orphan", "island"]);
    repo.commit("island.txt", "x\n", "island");
    repo.git(&["checkout", "-q", "main"]);
    let preview = repo.ops().merge_preview("island").unwrap();
    assert_eq!(preview.kind, Invalid);

    let err = repo.ops().merge_preview("no-such-branch").unwrap_err();
    assert_eq!(err.message, "branch 'no-such-branch' not found");

    assert_eq!(repo.head(), head, "a preview merges nothing");
    assert!(!repo.has_git_file("MERGE_HEAD"));
    assert_eq!(repo.log.changes(), 0);

    // Conflicts: one file, counted.
    let dir = scratch();
    let (repo, _) = conflicting(dir.path());
    let preview = repo.ops().merge_preview("feature").unwrap();
    assert_eq!(
        (preview.kind, preview.commit_count, preview.conflicted_files),
        (Conflicts, 1, 1)
    );
    assert_eq!(repo.read("a.txt"), "main\n");
}

// ── sync ──────────────────────────────────────────────────────────────────

#[test]
fn push_sends_new_commits_to_the_upstream() {
    let dir = scratch();
    let (repo, remote) = published(dir.path());
    let second = repo.commit("a.txt", "2\n", "second");

    repo.ops().push(PushOptions::default(), None).unwrap();
    assert_eq!(remote_main(&remote), second);
    assert_eq!(repo.log.entries(), ["changed"]);
}

#[test]
fn push_with_follow_tags_sends_annotated_tags() {
    let dir = scratch();
    let (repo, remote) = published(dir.path());
    repo.commit("a.txt", "2\n", "second");
    repo.git(&["tag", "-a", "v1", "-m", "release"]);

    let follow_tags = PushOptions {
        follow_tags: true,
        ..PushOptions::default()
    };
    repo.ops().push(follow_tags, None).unwrap();
    assert!(hermetic(&remote, &["rev-parse", "--verify", "refs/tags/v1"]).is_ok());
}

#[test]
fn push_without_an_upstream_fails_as_no_upstream_and_publishing_sets_one() {
    let dir = scratch();
    let (repo, remote) = published(dir.path());
    repo.git(&["checkout", "-q", "-b", "unpublished"]);
    let tip = repo.commit("b.txt", "b\n", "b");

    let err = repo.ops().push(PushOptions::default(), None).unwrap_err();
    assert_eq!(err.code, GitErrorCode::NoUpstream, "{}", err.raw_stderr);
    assert_eq!(repo.log.changes(), 0, "a buffered failure changed nothing");

    // `origin` when no remote is named.
    repo.ops().publish_branch(None, None).unwrap();
    assert_eq!(
        hermetic(&remote, &["rev-parse", "unpublished"])
            .unwrap()
            .trim(),
        tip
    );
    assert_eq!(repo.rev("@{upstream}"), tip);
    assert_eq!(repo.log.changes(), 1);
    repo.ops().push(PushOptions::default(), None).unwrap();
}

/// The remote moved on: a plain push is rejected as non-fast-forward, a
/// lease against the stale remote-tracking ref is rejected as stale, a
/// fetch alone does not make forcing safe, and forcing succeeds once
/// their commit has been part of this branch.
#[test]
fn a_diverged_push_is_forced_only_over_commits_this_branch_has_seen() {
    let dir = scratch();
    let (repo, remote) = published(dir.path());
    let theirs = someone_else_pushes(dir.path(), &remote, "a.txt");
    let ours = repo.commit("a.txt", "ours\n", "ours");
    let plain = PushOptions::default();
    let force = PushOptions {
        force_with_lease: true,
        ..plain
    };

    let err = repo.ops().push(plain, None).unwrap_err();
    assert_eq!(err.code, GitErrorCode::NonFastForward, "{}", err.raw_stderr);
    assert_eq!(remote_main(&remote), theirs);

    let err = repo.ops().push(force, None).unwrap_err();
    assert_eq!(
        err.code,
        GitErrorCode::ForcePushRejected,
        "{}",
        err.raw_stderr
    );
    assert_eq!(
        remote_main(&remote),
        theirs,
        "a stale lease must not overwrite"
    );

    // Fetched but never integrated — what background auto-fetch leaves
    // behind. The lease alone would now pass; `--force-if-includes` holds.
    repo.ops().fetch(None).unwrap();
    let err = repo.ops().push(force, None).unwrap_err();
    assert_eq!(
        err.code,
        GitErrorCode::ForcePushRejected,
        "{}",
        err.raw_stderr
    );
    assert_eq!(
        remote_main(&remote),
        theirs,
        "an unseen fetch must not overwrite"
    );

    // Once their commit has been part of this branch, forcing is a choice.
    repo.git(&["merge", "-q", "-X", "ours", "origin/main", "-m", "merge"]);
    repo.git(&["reset", "-q", "--hard", &ours]);
    repo.ops().push(force, None).unwrap();
    assert_eq!(remote_main(&remote), ours);
}

/// A push after amending a pushed commit is `HistoryRewritten`; a push
/// behind someone else's new commit stays `NonFastForward`; and the
/// force-push the first one offers then goes through.
#[test]
fn a_rejected_push_tells_a_rewrite_from_new_remote_work() {
    let plain = PushOptions::default();
    let force = PushOptions {
        force_with_lease: true,
        ..plain
    };

    let dir = scratch();
    let (repo, _) = published(dir.path());
    repo.commit("b.txt", "b\n", "second");
    repo.git(&["push", "-q"]);
    repo.git(&["commit", "-q", "--amend", "-m", "second, reworded"]);
    let rewritten = repo.ops().push(plain, None).unwrap_err();
    assert_eq!(
        rewritten.code,
        GitErrorCode::HistoryRewritten,
        "{}",
        rewritten.raw_stderr
    );
    assert!(
        rewritten.raw_stderr.contains("(non-fast-forward)"),
        "git's own words are kept under the recoded error"
    );
    repo.ops()
        .push(force, None)
        .expect("force-with-lease after a rewrite");

    let dir = scratch();
    let (repo, _) = diverged(dir.path());
    repo.git(&["fetch", "-q"]);
    assert_eq!(
        repo.ops().push(plain, None).unwrap_err().code,
        GitErrorCode::NonFastForward
    );

    // Not fetched: the remote's tip is unknown here ("fetch first").
    let dir = scratch();
    let (repo, _) = diverged(dir.path());
    assert_eq!(
        repo.ops().push(plain, None).unwrap_err().code,
        GitErrorCode::NonFastForward
    );
}

/// An observed operation: started, its lines, the notifier, then finished.
/// And the notifier is told even when it fails, since a streamed operation
/// can stop halfway.
#[test]
fn an_observed_operation_reports_its_whole_life_in_order() {
    let dir = scratch();
    let (repo, remote) = published(dir.path());
    let second = repo.commit("a.txt", "2\n", "second");

    repo.ops()
        .push(PushOptions::default(), Some(&repo.log))
        .unwrap();
    assert_eq!(remote_main(&remote), second);
    assert_eq!(repo.log.lifecycle(), ["started", "changed", "finished:ok"]);
    let entries = repo.log.entries();
    assert_eq!(entries.first().map(String::as_str), Some("started"));
    assert_eq!(entries.last().map(String::as_str), Some("finished:ok"));
    assert!(
        !repo.log.output().is_empty(),
        "git's progress reached the observer"
    );

    // A failure: the same shape, with the error.
    repo.log.clear();
    repo.git(&["checkout", "-q", "-b", "unpublished"]);
    let err = repo
        .ops()
        .push(PushOptions::default(), Some(&repo.log))
        .unwrap_err();
    assert_eq!(err.code, GitErrorCode::NoUpstream);
    assert_eq!(
        repo.log.lifecycle(),
        ["started", "changed", "finished:NoUpstream"]
    );
}

/// The observer hears the rejection as git classified it; only the caller's
/// error is recoded as a rewrite.
#[test]
fn a_rewritten_push_finishes_as_git_worded_it_and_returns_the_explanation() {
    let dir = scratch();
    let (repo, _) = published(dir.path());
    repo.commit("b.txt", "b\n", "second");
    repo.git(&["push", "-q"]);
    repo.git(&["commit", "-q", "--amend", "-m", "second, reworded"]);

    let err = repo
        .ops()
        .push(PushOptions::default(), Some(&repo.log))
        .unwrap_err();
    assert_eq!(err.code, GitErrorCode::HistoryRewritten);
    assert_eq!(
        repo.log.lifecycle(),
        ["started", "changed", "finished:NonFastForward"]
    );
}

#[test]
fn fetch_brings_remote_work_in_and_prunes_what_is_gone() {
    let dir = scratch();
    let (repo, remote) = published(dir.path());
    repo.git(&["push", "-q", "origin", "HEAD:refs/heads/doomed"]);
    repo.git(&["fetch", "-q", "origin"]);
    assert!(hermetic(&repo.path, &["rev-parse", "--verify", "origin/doomed"]).is_ok());
    let theirs = someone_else_pushes(dir.path(), &remote, "theirs.txt");
    hermetic(&remote, &["branch", "-D", "doomed"]).unwrap();

    repo.ops().fetch(Some(&repo.log)).unwrap();
    assert_eq!(repo.rev("origin/main"), theirs);
    assert!(hermetic(&repo.path, &["rev-parse", "--verify", "origin/doomed"]).is_err());
    assert_eq!(repo.log.lifecycle(), ["started", "changed", "finished:ok"]);
}

fn contains(repo: &Repo, commit: &str) -> bool {
    hermetic(&repo.path, &["merge-base", "--is-ancestor", commit, "HEAD"]).is_ok()
}

/// The preference Atlas reads agrees with what a plain pull then does:
/// `ask` exactly when git refuses, a strategy exactly when it reconciles.
#[test]
fn pull_preference_predicts_a_plain_pull() {
    let configs: &[&[(&str, &str)]] = &[
        &[],
        &[("pull.rebase", "true")],
        &[("pull.rebase", "false")],
        &[("pull.ff", "only")],
        &[("pull.ff", "only"), ("pull.rebase", "true")],
        &[("pull.rebase", "false"), ("branch.main.rebase", "true")],
    ];
    for config in configs {
        let dir = scratch();
        let (repo, _) = diverged(dir.path());
        for (k, v) in *config {
            repo.git(&["config", k, v]);
        }
        let preference = repo.ops().pull_preference();
        let pulled = repo.ops().pull(PullStrategy::Default, None, None);
        assert_eq!(
            preference == PullPreference::Ask,
            pulled.is_err(),
            "{config:?}: preference {preference:?}, pull {:?}",
            pulled.err().map(|e| e.raw_stderr)
        );
    }
}

/// Both of git's wordings — no `pull.rebase` set, and `pull.ff=only` —
/// classify as `DivergentBranches`, and both strategies then succeed.
#[test]
fn a_diverged_pull_needs_a_strategy_and_either_one_reconciles() {
    for ff_only in [false, true] {
        for strategy in [PullStrategy::Rebase, PullStrategy::Merge] {
            let dir = scratch();
            let (repo, theirs) = diverged(dir.path());
            if ff_only {
                repo.git(&["config", "pull.ff", "only"]);
            }

            let err = repo
                .ops()
                .pull(PullStrategy::Default, None, None)
                .unwrap_err();
            assert_eq!(
                err.code,
                GitErrorCode::DivergentBranches,
                "ff_only={ff_only}: {}",
                err.raw_stderr
            );
            assert_eq!(repo.log.changes(), 0);

            repo.ops()
                .pull(strategy, Some("origin"), None)
                .unwrap_or_else(|e| panic!("{strategy:?} ff_only={ff_only}: {}", e.raw_stderr));
            assert!(contains(&repo, &theirs), "{strategy:?} ff_only={ff_only}");
            assert_eq!(repo.log.changes(), 1);
        }
    }
}

#[test]
fn rebase_replays_the_branch_and_a_conflict_pauses_it_until_aborted() {
    // Clean: the feature commit lands on top of main's.
    let dir = scratch();
    let repo = Repo::init(dir.path());
    repo.commit("a.txt", "1\n", "base");
    repo.git(&["checkout", "-q", "-b", "feature"]);
    repo.commit("b.txt", "b\n", "add b");
    repo.git(&["checkout", "-q", "main"]);
    let main = repo.commit("c.txt", "c\n", "add c");
    repo.git(&["checkout", "-q", "feature"]);
    repo.ops().rebase("main", Some(&repo.log)).unwrap();
    assert_eq!(repo.rev("HEAD~1"), main);
    assert_eq!(repo.subject(), "add b");
    assert_eq!(repo.log.lifecycle(), ["started", "changed", "finished:ok"]);

    // Conflict: paused, typed, and abort puts everything back.
    let dir = scratch();
    let (repo, feature) = conflicting(dir.path());
    repo.git(&["checkout", "-q", "feature"]);
    let err = repo.ops().rebase("main", None).unwrap_err();
    assert_eq!(
        err.code,
        GitErrorCode::RebaseConflicts,
        "{}",
        err.raw_stderr
    );
    assert!(repo.ops().in_progress().unwrap().rebase);

    repo.ops()
        .control(InProgressKind::Rebase, OpAction::Abort)
        .unwrap();
    assert!(!repo.ops().in_progress().unwrap().rebase);
    assert_eq!(repo.head(), feature);
    assert_eq!(repo.read("a.txt"), "feature\n");
}

#[test]
fn remotes_are_listed_once_each_added_and_removed() {
    let dir = scratch();
    let (repo, _, _) = two_commits(dir.path());
    assert!(repo.ops().remotes().unwrap().is_empty());

    repo.ops()
        .add_remote("origin", "https://example.invalid/a.git")
        .unwrap();
    repo.ops()
        .add_remote("fork", "https://example.invalid/b.git")
        .unwrap();
    let mut remotes: Vec<(String, String)> = repo
        .ops()
        .remotes()
        .unwrap()
        .into_iter()
        .map(|r| (r.name, r.url))
        .collect();
    remotes.sort();
    assert_eq!(
        remotes,
        [
            (
                "fork".to_string(),
                "https://example.invalid/b.git".to_string()
            ),
            (
                "origin".to_string(),
                "https://example.invalid/a.git".to_string()
            ),
        ],
        "fetch and push lines collapse to one entry"
    );

    assert!(repo
        .ops()
        .add_remote("origin", "https://example.invalid/c.git")
        .is_err());
    repo.ops().remove_remote("fork").unwrap();
    assert_eq!(repo.ops().remotes().unwrap().len(), 1);
    assert_eq!(repo.log.changes(), 3);
}

// ── history ───────────────────────────────────────────────────────────────

#[test]
fn reset_soft_moves_head_and_keeps_the_change_staged() {
    let dir = scratch();
    let (repo, first, _) = two_commits(dir.path());
    repo.ops().reset("HEAD~1", ResetMode::Soft).unwrap();
    assert_eq!(repo.head(), first);
    assert_eq!(repo.staged(), "a.txt");
    assert_eq!(repo.read("a.txt"), "2\n");
}

#[test]
fn reset_mixed_and_any_unknown_mode_unstage_but_keep_the_worktree() {
    for mode in ["mixed", "", "bogus"] {
        let dir = scratch();
        let (repo, first, _) = two_commits(dir.path());
        assert_eq!(ResetMode::parse(mode), ResetMode::Mixed, "{mode:?}");
        repo.ops().reset("HEAD~1", ResetMode::parse(mode)).unwrap();
        assert_eq!(repo.head(), first, "{mode:?}");
        assert_eq!(repo.staged(), "", "{mode:?}");
        assert_eq!(repo.unstaged(), "a.txt", "{mode:?}");
        assert_eq!(repo.read("a.txt"), "2\n", "{mode:?}");
    }
    assert_eq!(ResetMode::parse("soft"), ResetMode::Soft);
    assert_eq!(ResetMode::parse("hard"), ResetMode::Hard);
}

#[test]
fn reset_hard_discards_the_change() {
    let dir = scratch();
    let (repo, first, second) = two_commits(dir.path());
    repo.write("a.txt", "dirty\n");
    repo.ops().reset(&first, ResetMode::Hard).unwrap();
    assert_eq!(repo.head(), first);
    assert_eq!(repo.staged(), "");
    assert_eq!(repo.unstaged(), "");
    assert_eq!(repo.read("a.txt"), "1\n");

    // And forward again to a sha.
    repo.ops().reset(&second, ResetMode::Hard).unwrap();
    assert_eq!(repo.read("a.txt"), "2\n");
}

#[test]
fn reset_to_an_unknown_target_fails_typed_and_moves_nothing() {
    let dir = scratch();
    let (repo, _, second) = two_commits(dir.path());
    let err = repo
        .ops()
        .reset("no-such-ref", ResetMode::Hard)
        .unwrap_err();
    assert_eq!(err.code, GitErrorCode::UnknownRef, "{}", err.raw_stderr);
    assert_eq!(repo.head(), second);
}

#[test]
fn revert_commits_the_inverse_change() {
    let dir = scratch();
    let (repo, _, second) = two_commits(dir.path());
    repo.ops().revert(&second).unwrap();
    assert_eq!(repo.read("a.txt"), "1\n");
    assert_eq!(repo.subject(), "Revert \"second\"");
    assert_eq!(repo.rev("HEAD~1"), second, "a new commit, not a rewrite");
    assert_eq!(repo.unstaged(), "");
    assert_eq!(repo.log.changes(), 1);
}

/// A merge commit refuses a plain revert ("is a merge but no -m option");
/// the revert must retry against the first parent.
#[test]
fn revert_of_a_merge_commit_falls_back_to_the_first_parent() {
    let dir = scratch();
    let repo = Repo::init(dir.path());
    repo.commit("a.txt", "1\n", "base");
    repo.git(&["checkout", "-q", "-b", "feature"]);
    repo.commit("b.txt", "feature\n", "add b");
    repo.git(&["checkout", "-q", "main"]);
    repo.commit("c.txt", "main\n", "add c");
    repo.git(&["merge", "-q", "--no-ff", "--no-edit", "feature"]);
    let merge = repo.head();
    assert!(repo.exists("b.txt"));

    repo.ops().revert(&merge).expect("falls back to -m 1");
    assert!(!repo.exists("b.txt"), "the feature side is undone");
    assert!(repo.exists("c.txt"), "mainline is kept");
    assert_eq!(repo.rev("HEAD~1"), merge);
    assert_eq!(repo.log.changes(), 1, "one revert, told once");
}

#[test]
fn revert_that_conflicts_fails_typed_and_leaves_the_revert_in_progress() {
    let dir = scratch();
    let (repo, _, second) = two_commits(dir.path());
    repo.commit("a.txt", "3\n", "third");
    let head = repo.head();

    let err = repo.ops().revert(&second).unwrap_err();
    // Either conflict code: today a revert lands on MergeConflicts (its
    // stdout `CONFLICT (`) and a cherry-pick on RebaseConflicts (its
    // stderr `error: could not apply`). Both route to the conflicts view.
    assert!(is_conflict(&err), "{:?}: {}", err.code, err.raw_stderr);
    assert!(
        repo.has_git_file("REVERT_HEAD"),
        "the in-progress banner keys off this"
    );
    assert!(repo.ops().in_progress().unwrap().revert);
    assert_eq!(repo.head(), head, "nothing committed");
}

#[test]
fn cherry_pick_copies_a_commit_onto_the_current_branch() {
    let dir = scratch();
    let repo = Repo::init(dir.path());
    repo.commit("a.txt", "1\n", "base");
    repo.git(&["checkout", "-q", "-b", "feature"]);
    let picked = repo.commit("b.txt", "from feature\n", "add b");
    repo.git(&["checkout", "-q", "main"]);
    // Diverge first: onto its own parent, within the same second, a pick
    // would reproduce the original commit's sha exactly.
    let main_before = repo.commit("c.txt", "main\n", "add c");

    repo.ops().cherry_pick(&picked).unwrap();
    assert_eq!(repo.read("b.txt"), "from feature\n");
    assert_eq!(repo.subject(), "add b");
    assert_eq!(repo.rev("HEAD~1"), main_before);
    assert_ne!(repo.head(), picked, "a copy, not the original commit");
    assert_eq!(repo.log.changes(), 1);
}

#[test]
fn cherry_pick_that_conflicts_is_typed_left_in_progress_and_can_be_aborted() {
    let dir = scratch();
    let (repo, picked) = conflicting(dir.path());
    let head = repo.head();

    let err = repo.ops().cherry_pick(&picked).unwrap_err();
    assert!(is_conflict(&err), "{:?}: {}", err.code, err.raw_stderr);
    assert!(repo.has_git_file("CHERRY_PICK_HEAD"));
    assert!(repo.ops().in_progress().unwrap().cherry_pick);
    assert!(
        repo.read("a.txt").contains("<<<<<<<"),
        "conflict markers in the tree"
    );
    assert_eq!(repo.head(), head);

    // And the in-progress pick aborts cleanly back to where it started.
    repo.ops()
        .control(InProgressKind::CherryPick, OpAction::Abort)
        .unwrap();
    assert_eq!(repo.read("a.txt"), "main\n");
    assert!(!repo.ops().in_progress().unwrap().cherry_pick);
}

#[test]
fn cherry_pick_of_an_unknown_sha_fails_typed() {
    let dir = scratch();
    let (repo, _, _) = two_commits(dir.path());
    let err = repo
        .ops()
        .cherry_pick("0000000000000000000000000000000000000001")
        .unwrap_err();
    assert!(!err.raw_stderr.is_empty());
    assert_ne!(err.code, GitErrorCode::RebaseConflicts);
}

#[test]
fn undo_returns_the_last_commit_to_the_index() {
    let dir = scratch();
    let (repo, first, _) = two_commits(dir.path());
    repo.ops().undo_commit().unwrap();
    assert_eq!(repo.head(), first);
    assert_eq!(repo.staged(), "a.txt");
    assert_eq!(repo.read("a.txt"), "2\n");
    assert_eq!(repo.log.changes(), 1);
}

#[test]
fn undo_refuses_the_first_commit_and_a_commit_that_is_already_pushed() {
    let dir = scratch();
    let repo = Repo::init(dir.path());
    let only = repo.commit("a.txt", "1\n", "first");
    let err = repo.ops().undo_commit().unwrap_err();
    assert_eq!(
        err.message,
        "The first commit of a repository can't be undone."
    );
    assert_eq!(repo.head(), only);

    let dir = scratch();
    let (repo, _) = published(dir.path());
    repo.commit("a.txt", "2\n", "second");
    repo.git(&["push", "-q"]);
    let pushed = repo.head();
    let err = repo.ops().undo_commit().unwrap_err();
    assert_eq!(
        err.message,
        "This commit is already pushed. Revert it instead of undoing it."
    );
    assert_eq!(repo.head(), pushed);
    assert_eq!(repo.log.changes(), 0);

    // One commit ahead of the upstream: that one can go.
    repo.commit("a.txt", "3\n", "third");
    repo.ops().undo_commit().unwrap();
    assert_eq!(repo.head(), pushed);
}

#[test]
fn squash_folds_the_last_commits_into_one_with_the_new_message() {
    let dir = scratch();
    let repo = Repo::init(dir.path());
    let base = repo.commit("a.txt", "1\n", "base");
    repo.commit("a.txt", "2\n", "wip");
    repo.commit("b.txt", "b\n", "more wip");

    repo.ops()
        .squash_last(2, "  the feature  ", Some("\nwhy it exists\n"))
        .unwrap();
    assert_eq!(repo.rev("HEAD~1"), base);
    assert_eq!(repo.body(), "the feature\n\nwhy it exists");
    assert_eq!(repo.read("a.txt"), "2\n");
    assert_eq!(repo.read("b.txt"), "b\n");
    assert_eq!(repo.staged(), "");
    assert_eq!(repo.log.changes(), 1);
}

#[test]
fn squash_refuses_too_few_commits_and_a_range_that_reaches_pushed_history() {
    let dir = scratch();
    let (repo, _, second) = two_commits(dir.path());
    for count in [0, 1] {
        let err = repo.ops().squash_last(count, "x", None).unwrap_err();
        assert_eq!(err.message, "Squash needs at least 2 commits.");
    }
    // Two commits: HEAD~2 does not exist.
    let err = repo.ops().squash_last(2, "x", None).unwrap_err();
    assert_eq!(err.message, "Not enough commits to squash.");
    assert_eq!(repo.head(), second);

    let dir = scratch();
    let (repo, _) = published(dir.path());
    repo.commit("a.txt", "2\n", "second");
    repo.git(&["push", "-q"]);
    repo.commit("a.txt", "3\n", "third");
    let head = repo.head();
    // One of the two is already on the upstream.
    let err = repo.ops().squash_last(2, "x", None).unwrap_err();
    assert_eq!(
        err.message,
        "Some of these commits are already pushed — squashing would rewrite shared history."
    );
    assert_eq!(repo.head(), head);
    assert_eq!(repo.log.changes(), 0);

    // Two unpushed commits squash.
    repo.commit("a.txt", "4\n", "fourth");
    repo.ops().squash_last(2, "three and four", None).unwrap();
    assert_eq!(repo.subject(), "three and four");
}

/// The reset has already moved HEAD when the commit's hook refuses: the
/// notifier must hear of it even though the squash failed.
#[cfg(unix)]
#[test]
fn a_squash_whose_commit_fails_still_tells_the_notifier() {
    let dir = scratch();
    let repo = Repo::init(dir.path());
    let base = repo.commit("a.txt", "1\n", "base");
    repo.commit("a.txt", "2\n", "wip");
    repo.commit("a.txt", "3\n", "more wip");
    repo.hook("pre-commit", "#!/bin/sh\necho no >&2\nexit 1\n");

    assert!(repo.ops().squash_last(2, "squashed", None).is_err());
    assert_eq!(repo.head(), base, "the reset happened");
    assert_eq!(repo.staged(), "a.txt", "and the work is still staged");
    assert_eq!(repo.log.changes(), 1);
}

#[test]
fn a_conflicted_merge_is_finished_with_a_commit_or_aborted() {
    let dir = scratch();
    let (repo, feature) = conflicting(dir.path());
    let head = repo.head();
    assert!(repo.ops().merge("feature").is_err());

    // Abort: back where it started.
    repo.ops()
        .control(InProgressKind::Merge, OpAction::Abort)
        .unwrap();
    assert_eq!(repo.read("a.txt"), "main\n");
    assert!(!repo.has_git_file("MERGE_HEAD"));

    // Continue: a merge has no `--continue`; resolving and continuing commits.
    assert!(repo.ops().merge("feature").is_err());
    repo.write("a.txt", "resolved\n");
    repo.git(&["add", "a.txt"]);
    repo.log.clear();
    repo.ops()
        .control(InProgressKind::Merge, OpAction::Continue)
        .unwrap();
    assert!(!repo.has_git_file("MERGE_HEAD"));
    assert_eq!(repo.rev("HEAD^1"), head);
    assert_eq!(repo.rev("HEAD^2"), feature);
    assert_eq!(repo.log.changes(), 1);

    // Nothing in progress: refused, and nobody is told.
    repo.log.clear();
    assert!(repo
        .ops()
        .control(InProgressKind::Rebase, OpAction::Abort)
        .is_err());
    assert_eq!(repo.log.changes(), 0);
}

#[test]
fn the_names_the_app_sends_parse_to_the_operation_and_action() {
    assert_eq!(InProgressKind::parse("merge"), Some(InProgressKind::Merge));
    assert_eq!(
        InProgressKind::parse("rebase"),
        Some(InProgressKind::Rebase)
    );
    assert_eq!(
        InProgressKind::parse("cherry-pick"),
        Some(InProgressKind::CherryPick)
    );
    assert_eq!(
        InProgressKind::parse("revert"),
        Some(InProgressKind::Revert)
    );
    assert_eq!(InProgressKind::parse("bisect"), None);
    assert_eq!(OpAction::parse("continue"), OpAction::Continue);
    assert_eq!(OpAction::parse("abort"), OpAction::Abort);
    assert_eq!(OpAction::parse("anything else"), OpAction::Abort);
}

#[test]
fn in_progress_is_all_clear_on_a_quiet_repository() {
    let dir = scratch();
    let (repo, _, _) = two_commits(dir.path());
    let quiet = repo.ops().in_progress().unwrap();
    assert!(!quiet.merge && !quiet.rebase && !quiet.cherry_pick && !quiet.revert);

    let not_a_repo = scratch();
    let err = Repository::new(not_a_repo.path(), &())
        .in_progress()
        .unwrap_err();
    assert_eq!(err.code, GitErrorCode::NotARepository);
}

#[test]
fn tags_are_annotated_placed_listed_and_deleted() {
    let dir = scratch();
    let (repo, first, second) = two_commits(dir.path());
    let ops = repo.ops();
    assert!(ops.tags().unwrap().is_empty());

    ops.create_tag("v1", Some(&first), Some("the first"))
        .unwrap();
    // No target, or an empty one, is HEAD.
    ops.create_tag("v2", Some(""), Some("the second")).unwrap();
    assert_eq!(repo.rev("v1^{commit}"), first);
    assert_eq!(repo.rev("v2^{commit}"), second);
    assert_eq!(
        repo.git(&["cat-file", "-t", "v1"]).trim(),
        "tag",
        "annotated, not lightweight"
    );
    assert_eq!(
        repo.git(&["tag", "-l", "--format=%(contents:subject)", "v1"])
            .trim(),
        "the first"
    );
    let mut tags = ops.tags().unwrap();
    tags.sort();
    assert_eq!(tags, ["v1", "v2"]);

    let err = ops.create_tag("v1", None, Some("again")).unwrap_err();
    assert_eq!(
        err.code,
        GitErrorCode::TagAlreadyExists,
        "{}",
        err.raw_stderr
    );

    ops.delete_tag("v1").unwrap();
    assert_eq!(ops.tags().unwrap(), ["v2"]);
    assert_eq!(repo.log.changes(), 3);
}

#[test]
fn show_reads_one_commit_and_its_diff() {
    let dir = scratch();
    let repo = Repo::init(dir.path());
    repo.commit("a.txt", "one\n", "base");
    repo.write("a.txt", "one  \ntwo\n");
    repo.git(&["add", "a.txt"]);
    repo.git(&["commit", "-q", "-m", "subject line", "-m", "body text"]);
    let sha = repo.head();

    let detail = repo.ops().show(&sha, false).unwrap();
    assert_eq!(detail.hash, sha);
    assert!(sha.starts_with(&detail.short_hash) && detail.short_hash.len() < sha.len());
    assert_eq!(detail.author, "Atlas Test");
    assert_eq!(detail.email, "test@atlas.invalid");
    assert_eq!(detail.subject, "subject line");
    assert_eq!(detail.body, "body text");
    // `YYYY-MM-DD HH:MM`.
    assert_eq!(detail.date.len(), 16, "{}", detail.date);
    assert!(detail.diff.starts_with("diff --git a/a.txt b/a.txt"));
    assert!(detail.diff.contains("-one\n") && detail.diff.contains("+two"));

    // Ignoring whitespace, the trailing-space change to line one is gone.
    let quiet = repo.ops().show(&sha, true).unwrap();
    assert!(!quiet.diff.contains("-one\n") && quiet.diff.contains("+two"));

    // A merge shows what it brought in, not an empty combined diff.
    repo.git(&["checkout", "-q", "-b", "feature", "HEAD~1"]);
    repo.commit("b.txt", "b\n", "add b");
    repo.git(&["checkout", "-q", "main"]);
    repo.git(&["merge", "-q", "--no-ff", "--no-edit", "feature"]);
    let merge = repo.ops().show("HEAD", false).unwrap();
    assert!(merge.diff.contains("b/b.txt"), "{}", merge.diff);

    let err = repo.ops().show("no-such-ref", false).unwrap_err();
    assert_eq!(err.code, GitErrorCode::UnknownRef);
}

// ── index, working tree, stash ────────────────────────────────────────────

#[test]
fn selected_filenames_are_literal_for_every_worktree_mutation() {
    let dir = scratch();
    let repo = Repo::init(dir.path());
    repo.write("[id].txt", "original\n");
    repo.write("i.txt", "original\n");
    repo.git(&["add", "--all"]);
    repo.git(&["commit", "-qm", "initial files"]);
    repo.write("[id].txt", "selected change\n");
    repo.write("i.txt", "other change\n");

    repo.ops().stage(&files(&["[id].txt"])).unwrap();
    assert_eq!(repo.staged(), "[id].txt");
    repo.ops().stage(&files(&["i.txt"])).unwrap();
    repo.ops().unstage(&files(&["[id].txt"])).unwrap();
    assert_eq!(repo.staged(), "i.txt");

    repo.ops().discard(&files(&["[id].txt"])).unwrap();
    assert_eq!(repo.read("[id].txt"), "original\n");
    assert_eq!(repo.read("i.txt"), "other change\n");
    assert_eq!(repo.staged(), "i.txt");

    repo.write("[xy].txt", "selected addition\n");
    repo.write("x.txt", "other addition\n");
    repo.git(&["add", "--all"]);
    repo.ops().delete_added(&files(&["[xy].txt"])).unwrap();
    assert!(!repo.exists("[xy].txt"));
    assert_eq!(repo.read("x.txt"), "other addition\n");
    assert_eq!(repo.staged(), "i.txt\nx.txt");
}

#[test]
fn stage_and_unstage_move_files_in_and_out_of_the_index() {
    let dir = scratch();
    let (repo, _, _) = two_commits(dir.path());
    repo.write("a.txt", "edited\n");
    repo.write("new file.txt", "new\n");
    let ops = repo.ops();

    ops.stage(&files(&["a.txt", "new file.txt"])).unwrap();
    assert_eq!(repo.staged(), "a.txt\nnew file.txt");
    ops.unstage(&files(&["a.txt"])).unwrap();
    assert_eq!(repo.staged(), "new file.txt");
    assert_eq!(repo.read("a.txt"), "edited\n", "unstaging keeps the edit");

    // Nothing to do is not a git run, so not even a missing repository fails.
    let nowhere = Repository::new(dir.path().join("missing"), &());
    nowhere.stage(&[]).unwrap();
    nowhere.unstage(&[]).unwrap();
    nowhere.discard(&[]).unwrap();
    nowhere.delete_added(&[]).unwrap();

    assert!(ops.stage(&files(&["no-such-file.txt"])).is_err());
    // The watcher covers the index; these never tell the notifier.
    assert_eq!(repo.log.changes(), 0);
}

#[test]
fn discard_restores_tracked_files_and_leaves_untracked_ones() {
    let dir = scratch();
    let (repo, _, _) = two_commits(dir.path());
    repo.commit("b.txt", "b\n", "add b");
    repo.write("a.txt", "staged edit\n");
    repo.git(&["add", "a.txt"]);
    repo.write("a.txt", "and a worktree edit\n");
    repo.write("b.txt", "edited b\n");
    repo.write("untracked.txt", "keep me\n");

    repo.ops().discard(&files(&["a.txt"])).unwrap();
    assert_eq!(
        repo.read("a.txt"),
        "2\n",
        "staged and worktree both restored"
    );
    assert_eq!(repo.staged(), "");
    assert_eq!(repo.read("b.txt"), "edited b\n", "only the named file");
    assert_eq!(repo.read("untracked.txt"), "keep me\n");
    assert_eq!(repo.log.changes(), 1);

    // An untracked file has no HEAD version: refused, nothing deleted.
    let err = repo.ops().discard(&files(&["untracked.txt"])).unwrap_err();
    assert!(!err.raw_stderr.is_empty());
    assert!(repo.exists("untracked.txt"));
    repo.ops().discard(&[]).unwrap();
    assert_eq!(repo.log.changes(), 1);
}

#[test]
fn delete_added_removes_new_files_staged_or_not() {
    let dir = scratch();
    let (repo, _, _) = two_commits(dir.path());
    repo.write("staged-new.txt", "new\n");
    repo.git(&["add", "staged-new.txt"]);
    repo.write("untracked.bin", "\u{0}\u{1}");
    repo.write("bystander.txt", "stay\n");

    repo.ops()
        .delete_added(&files(&[
            "staged-new.txt",
            "untracked.bin",
            "already-gone.txt",
        ]))
        .unwrap();
    assert!(!repo.exists("staged-new.txt") && !repo.exists("untracked.bin"));
    assert_eq!(repo.staged(), "", "the index entry went too");
    assert!(repo.exists("bystander.txt"));
    assert_eq!(repo.log.changes(), 1);

    repo.ops().delete_added(&[]).unwrap();
    assert_eq!(repo.log.changes(), 1, "nothing named, nobody told");
}

#[test]
fn stash_takes_tracked_changes_and_leaves_untracked_files() {
    let dir = scratch();
    let (repo, _, _) = two_commits(dir.path());
    repo.write("a.txt", "work in progress\n");
    repo.write("untracked.txt", "not stashed\n");
    let ops = repo.ops();

    ops.stash_push(Some("half done")).unwrap();
    assert_eq!(repo.read("a.txt"), "2\n");
    assert_eq!(repo.read("untracked.txt"), "not stashed\n");
    // A blank message is no message: git names it after the branch.
    repo.write("a.txt", "second attempt\n");
    ops.stash_push(Some("   ")).unwrap();

    let stashes = ops.stashes().unwrap();
    assert_eq!(stashes.len(), 2);
    assert_eq!(stashes[0].index, 0);
    assert!(
        stashes[0].message.starts_with("WIP on main:"),
        "{:?}",
        stashes[0]
    );
    assert_eq!(stashes[0].branch, "main");
    assert_eq!(stashes[1].index, 1);
    assert_eq!(stashes[1].message, "On main: half done");
    assert_eq!(stashes[1].branch, "main");
    assert_eq!(repo.log.changes(), 2);
}

#[test]
fn a_stash_is_applied_and_kept_popped_and_dropped_or_dropped_outright() {
    let dir = scratch();
    let (repo, _, _) = two_commits(dir.path());
    let ops = repo.ops();
    for contents in ["oldest\n", "middle\n", "newest\n"] {
        repo.write("a.txt", contents);
        ops.stash_push(Some(contents.trim())).unwrap();
    }
    repo.log.clear();

    // Apply by position, keeping it.
    ops.stash_apply(2).unwrap();
    assert_eq!(repo.read("a.txt"), "oldest\n");
    assert_eq!(ops.stashes().unwrap().len(), 3);
    repo.git(&["reset", "-q", "--hard"]);

    // Pop: applied and gone.
    ops.stash_pop(0).unwrap();
    assert_eq!(repo.read("a.txt"), "newest\n");
    let left: Vec<String> = ops
        .stashes()
        .unwrap()
        .into_iter()
        .map(|s| s.message)
        .collect();
    assert_eq!(left, ["On main: middle", "On main: oldest"]);

    // A pop over a conflicting edit fails and keeps the stash.
    repo.git(&["commit", "-qam", "newest, committed"]);
    assert!(ops.stash_pop(0).is_err());
    assert_eq!(ops.stashes().unwrap().len(), 2);
    repo.git(&["reset", "-q", "--hard"]);

    ops.stash_drop(1).unwrap();
    let left: Vec<String> = ops
        .stashes()
        .unwrap()
        .into_iter()
        .map(|s| s.message)
        .collect();
    assert_eq!(left, ["On main: middle"]);
    assert!(ops.stash_apply(5).is_err());
    assert_eq!(
        repo.log.changes(),
        3,
        "apply, pop and drop; not the two refusals"
    );
}

// ── commit ────────────────────────────────────────────────────────────────

fn request(summary: &str) -> CommitRequest {
    CommitRequest {
        summary: summary.to_string(),
        ..CommitRequest::default()
    }
}

#[test]
fn commit_writes_the_message_and_reports_its_life() {
    let dir = scratch();
    let (repo, _, second) = two_commits(dir.path());
    repo.write("a.txt", "3\n");
    repo.git(&["add", "a.txt"]);

    repo.ops()
        .commit(
            CommitRequest {
                summary: "  third: \"quoted\" & $HOME  ".into(),
                description: Some("\nline one\n\n- a list\n# not a comment\n".into()),
                ..CommitRequest::default()
            },
            &repo.log,
        )
        .unwrap();
    assert_eq!(repo.rev("HEAD~1"), second);
    assert_eq!(
        repo.body(),
        "third: \"quoted\" & $HOME\n\nline one\n\n- a list\n# not a comment",
        "the message went over stdin, untouched by a shell or a comment filter"
    );
    assert_eq!(repo.log.lifecycle(), ["started", "changed", "finished:ok"]);
    assert!(
        repo.log.output().contains("third:"),
        "git's summary line streamed: {:?}",
        repo.log.output()
    );
}

/// The notifier is told after a commit that failed too: the index and HEAD
/// may have moved even then.
#[test]
fn commit_with_nothing_staged_fails_typed() {
    let dir = scratch();
    let (repo, _, second) = two_commits(dir.path());
    let err = repo
        .ops()
        .commit(request("nothing"), &repo.log)
        .unwrap_err();
    assert_eq!(
        err.code,
        GitErrorCode::NothingToCommit,
        "{}",
        err.raw_stderr
    );
    assert_eq!(repo.head(), second);
    assert_eq!(
        repo.log.lifecycle(),
        ["started", "changed", "finished:NothingToCommit"]
    );
}

#[test]
fn amend_rewrites_the_message_or_keeps_it_when_the_summary_is_empty() {
    let dir = scratch();
    let (repo, first, _) = two_commits(dir.path());

    // New message, same parent.
    repo.ops()
        .commit(
            CommitRequest {
                summary: "second, reworded".into(),
                amend: true,
                ..CommitRequest::default()
            },
            &repo.log,
        )
        .unwrap();
    assert_eq!(repo.subject(), "second, reworded");
    assert_eq!(repo.rev("HEAD~1"), first);

    // Empty summary: staged work folded in, message untouched.
    repo.write("b.txt", "b\n");
    repo.git(&["add", "b.txt"]);
    repo.ops()
        .commit(
            CommitRequest {
                summary: "   ".into(),
                description: Some("ignored when the message is kept".into()),
                amend: true,
                ..CommitRequest::default()
            },
            &repo.log,
        )
        .unwrap();
    assert_eq!(repo.body(), "second, reworded");
    assert_eq!(repo.rev("HEAD~1"), first);
    assert!(repo.git(&["show", "--stat", "--format="]).contains("b.txt"));

    // Not amending, an empty summary is an empty message, which git refuses.
    repo.write("c.txt", "c\n");
    repo.git(&["add", "c.txt"]);
    assert!(repo.ops().commit(request("  "), &repo.log).is_err());
}

#[test]
fn co_authors_become_trailers_once_each() {
    let dir = scratch();
    let (repo, _, _) = two_commits(dir.path());
    repo.write("a.txt", "3\n");
    repo.git(&["add", "a.txt"]);

    repo.ops()
        .commit(
            CommitRequest {
                summary: "pairing".into(),
                description: Some("the why\n\nCo-authored-by: Ada <ada@example.invalid>".into()),
                co_authors: vec![
                    "  Ada <ada@example.invalid>  ".into(),
                    "Grace <grace@example.invalid>".into(),
                    "   ".into(),
                ],
                ..CommitRequest::default()
            },
            &repo.log,
        )
        .unwrap();
    assert_eq!(
        repo.body(),
        "pairing\n\nthe why\n\nCo-authored-by: Ada <ada@example.invalid>\nCo-authored-by: Grace <grace@example.invalid>",
        "the one already typed is not repeated, and a blank one is dropped"
    );
}

/// git prints no stable marker when a hook rejects, so an unexplained
/// failure in a repository that has commit hooks is reported as the hook's.
#[cfg(unix)]
#[test]
fn a_rejecting_hook_is_heard_and_reported_as_a_hook_failure() {
    let dir = scratch();
    let (repo, _, second) = two_commits(dir.path());
    repo.hook(
        "pre-commit",
        "#!/bin/sh\necho 'lint: 3 problems' >&2\nexit 1\n",
    );
    repo.write("a.txt", "3\n");
    repo.git(&["add", "a.txt"]);

    let err = repo.ops().commit(request("third"), &repo.log).unwrap_err();
    assert_eq!(err.code, GitErrorCode::HookFailed, "{}", err.raw_stderr);
    assert_eq!(repo.head(), second);
    assert!(repo.log.output().contains("lint: 3 problems"));
    assert_eq!(
        repo.log.lifecycle(),
        ["started", "changed", "finished:HookFailed"],
        "the observer hears the recoded failure"
    );

    // A hook that is present but not executable is not a hook: git skips it,
    // and the commit goes through.
    use std::os::unix::fs::PermissionsExt;
    let hook = repo.path.join(".git/hooks/pre-commit");
    std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o644)).unwrap();
    repo.ops().commit(request("third"), &repo.log).unwrap();
    assert_eq!(repo.subject(), "third");
}

/// A failure git did explain keeps its own code, hooks or not.
#[cfg(unix)]
#[test]
fn a_classified_failure_is_not_blamed_on_a_hook() {
    let dir = scratch();
    let (repo, _, _) = two_commits(dir.path());
    repo.hook("pre-commit", "#!/bin/sh\nexit 0\n");
    let err = repo
        .ops()
        .commit(request("nothing staged"), &repo.log)
        .unwrap_err();
    assert_eq!(err.code, GitErrorCode::NothingToCommit);
}

// ── what crosses to the app ───────────────────────────────────────────────

/// The frontend reads these by field name. A rename here is a breaking
/// change no compiler sees.
#[test]
fn the_serialized_shapes_are_the_ones_the_frontend_reads() {
    let dir = scratch();
    let (repo, remote) = published(dir.path());
    let ops = repo.ops();
    let json = |v: serde_json::Value| v;

    let branch = serde_json::to_value(&ops.branches().unwrap()[0]).unwrap();
    let mut keys: Vec<&str> = branch
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "ahead",
            "behind",
            "date",
            "isCurrent",
            "isRemote",
            "name",
            "subject",
            "upstream"
        ]
    );

    assert_eq!(
        serde_json::to_value(ops.remotes().unwrap()).unwrap(),
        json(serde_json::json!([{ "name": "origin", "url": remote.to_str().unwrap() }]))
    );

    repo.write("a.txt", "wip\n");
    ops.stash_push(Some("wip")).unwrap();
    assert_eq!(
        serde_json::to_value(ops.stashes().unwrap()).unwrap(),
        serde_json::json!([{ "index": 0, "message": "On main: wip", "branch": "main" }])
    );

    assert_eq!(
        serde_json::to_value(ops.in_progress().unwrap()).unwrap(),
        serde_json::json!({ "merge": false, "rebase": false, "cherryPick": false, "revert": false })
    );

    repo.git(&["branch", "same"]);
    assert_eq!(
        serde_json::to_value(ops.merge_preview("same").unwrap()).unwrap(),
        serde_json::json!({ "kind": "uptodate", "commitCount": 0, "conflictedFiles": 0 })
    );
    for (kind, name) in [
        (MergePreviewKind::Clean, "clean"),
        (MergePreviewKind::Conflicts, "conflicts"),
        (MergePreviewKind::Uptodate, "uptodate"),
        (MergePreviewKind::Invalid, "invalid"),
        (MergePreviewKind::Unsupported, "unsupported"),
    ] {
        assert_eq!(serde_json::to_value(kind).unwrap(), name);
    }

    let detail = serde_json::to_value(ops.show("HEAD", false).unwrap()).unwrap();
    let mut keys: Vec<&str> = detail
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        [
            "author",
            "body",
            "date",
            "diff",
            "email",
            "hash",
            "shortHash",
            "subject"
        ]
    );

    for (preference, name) in [
        (PullPreference::Rebase, "rebase"),
        (PullPreference::Merge, "merge"),
        (PullPreference::Ask, "ask"),
    ] {
        assert_eq!(serde_json::to_value(preference).unwrap(), name);
    }
    for (name, strategy) in [
        ("default", PullStrategy::Default),
        ("rebase", PullStrategy::Rebase),
        ("merge", PullStrategy::Merge),
    ] {
        let parsed: PullStrategy = serde_json::from_value(serde_json::json!(name)).unwrap();
        assert_eq!(parsed, strategy);
    }
}

/// Staging a hunk re-reads the file's diff, finds the hunk the changes view
/// displayed and writes a patch for `git apply`. A CRLF file's lines carry
/// their `\r` on both sides of that: without it the displayed hunk is not
/// found, and a patch that did get written would not apply.
#[test]
fn a_hunk_of_a_crlf_file_is_found_and_stages() {
    use atlas_git::patch;

    let dir = scratch();
    let repo = Repo::init(dir.path());
    repo.commit("crlf.txt", "a\r\nb\r\nc\r\n", "a CRLF file");
    repo.write("crlf.txt", "a\r\nB\r\nc\r\n");

    let fresh = repo.git(&["diff", "--no-color", "--", "crlf.txt"]);
    let parsed = patch::parse_file_diff(&fresh).expect("the file has a diff");
    // The hunk as the changes view displays it and sends it back.
    let displayed = [(b' ', "a\r"), (b'-', "b\r"), (b'+', "B\r"), (b' ', "c\r")]
        .map(|(marker, text)| (marker, text.to_string()));
    let index = patch::find_matching_hunk(&parsed, &displayed).expect("the displayed hunk");
    let text = patch::whole_hunk_patch(&parsed, index).expect("a hunk with changes");

    let mut apply = GitCommand::new(&repo.path, &["apply", "--cached", "-"]).stdin(text.into());
    for (k, v) in HERMETIC_ENV {
        apply = apply.env(k, v);
    }
    apply.run().unwrap_or_else(|e| panic!("{}", e.raw_stderr));
    assert_eq!(repo.staged(), "crlf.txt");
    assert_eq!(repo.unstaged(), "", "the whole change is staged");
}

#[test]
fn partial_changes_preserve_unselected_lines_and_eof_boundaries() {
    use atlas_git::patch;
    for (before, after, selected, reverse, expected) in [
        ("a\nb\nc\n", "a\nB\nC\n", vec![3], true, "a\nC\n"),
        ("old tail", "new tail", vec![1], false, "old tail\nnew tail"),
        ("old tail", "new tail", vec![0], true, "old tail\nnew tail"),
    ] {
        let dir = scratch();
        let repo = Repo::init(dir.path());
        repo.commit("f.txt", before, "initial");
        repo.write("f.txt", after);
        let diff = repo.git(&["diff", "--", "f.txt"]);
        let parsed = patch::parse_file_diff(&diff).unwrap();
        let patch = if reverse {
            patch::reverse_line_selection_patch(&parsed, 0, Some(&selected))
        } else {
            patch::line_selection_patch(&parsed, 0, Some(&selected))
        }
        .unwrap();
        let args = if reverse {
            vec!["apply", "--reverse", "-"]
        } else {
            vec!["apply", "--cached", "-"]
        };
        GitCommand::new(&repo.path, &args)
            .stdin(patch.as_bytes().to_vec())
            .run()
            .unwrap_or_else(|e| panic!("{}\n{}", e.raw_stderr, patch));
        let actual = if reverse {
            repo.read("f.txt")
        } else {
            repo.git(&["show", ":f.txt"])
        };
        assert_eq!(actual, expected);
    }
}

#[test]
fn deleting_added_folders_keeps_their_symlink_targets() {
    let dir = scratch();
    let repo = Repo::init(dir.path());
    repo.commit("kept.txt", "kept\n", "initial");
    std::fs::create_dir_all(repo.path.join("new/nested")).unwrap();
    repo.write("new/nested/f.txt", "new\n");
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink("../kept.txt", repo.path.join("new/link")).unwrap();
        std::os::unix::fs::symlink("absent", repo.path.join("dangling")).unwrap();
        repo.ops().delete_added(&files(&["dangling"])).unwrap();
        assert!(std::fs::symlink_metadata(repo.path.join("dangling")).is_err());
    }
    repo.ops().delete_added(&files(&["new/"])).unwrap();
    assert!(!repo.exists("new"));
    assert_eq!(repo.read("kept.txt"), "kept\n");
}

#[test]
fn a_resolved_rebase_continues_without_an_interactive_editor() {
    let dir = scratch();
    let repo = Repo::init(dir.path());
    repo.commit("a.txt", "base\n", "initial");
    repo.git(&["checkout", "-qb", "feature"]);
    repo.commit("a.txt", "feature\n", "feature edit");
    repo.git(&["checkout", "-q", "main"]);
    repo.commit("a.txt", "main\n", "main edit");
    repo.git(&["checkout", "-q", "feature"]);
    assert!(repo.ops().rebase("main", None).is_err());
    repo.write("a.txt", "resolved\n");
    repo.ops().stage(&files(&["a.txt"])).unwrap();
    repo.ops()
        .control(InProgressKind::Rebase, OpAction::Continue)
        .unwrap();
    assert!(!repo.ops().in_progress().unwrap().rebase);
    assert_eq!(repo.read("a.txt"), "resolved\n");
}
