//! The single git spawn chokepoint: every git subprocess in Atlas goes
//! through [`GitCommand`] (`tests/spawn_audit.rs` fails on one that does
//! not). It provides one environment with prompts off, per-call
//! success-exit-code contracts, stderr→typed-error parsing on failure, a raw
//! variant for callers that read the exit code or binary output themselves,
//! and a streaming variant that feeds hook/progress output line by line
//! while retaining a bounded tail for error context.
//!
//! Always the REAL git binary: hooks, credential helpers, LFS filters and
//! user config all behave exactly as in a terminal.

use crate::error::{self, GitErrorPayload};
use std::collections::HashSet;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Which pipe a streamed line arrived on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

/// Receives live output from [`GitCommand::run_streaming`]. Implemented by
/// the Tauri glue, which forwards lines as `atlas:git:op` events.
pub trait OpSink: Send + Sync {
    fn output(&self, stream: Stream, line: &str);
}

#[derive(Debug, Clone)]
pub struct GitOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// A git process that ran to its exit, whatever the exit was: what
/// [`GitCommand::output`] returns. Bytes, because a blob or a patch is not
/// always text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRawOutput {
    /// `None` when a signal ended it.
    pub exit_code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

impl GitRawOutput {
    pub fn success(&self) -> bool {
        self.exit_code == Some(0)
    }

    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    pub fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

/// What [`GitCommand::stdout_capped`] read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CappedStdout {
    /// At most one byte more than the cap; the caller trims to a boundary
    /// that means something to it (a file header, a line).
    pub bytes: Vec<u8>,
    /// The cap cut the output short and git was killed.
    pub truncated: bool,
    /// Whether git exited 0. Unknowable once killed, so `true` then.
    pub success: bool,
}

/// Why a git run has no output at all: no process ran to its end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GitRunError {
    /// The binary could not be started because it is not there.
    NotInstalled,
    /// Killed after [`GitCommand::timeout`] passed.
    TimedOut { command: String, limit: Duration },
    /// The spawn or the wait failed for any other reason.
    Failed(String),
}

impl std::fmt::Display for GitRunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GitRunError::NotInstalled => {
                f.write_str("git was not found on this system. Install git and try again.")
            }
            GitRunError::TimedOut { command, limit } => {
                write!(f, "{command} timed out after {}s", limit.as_secs())
            }
            GitRunError::Failed(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for GitRunError {}

impl From<GitRunError> for GitErrorPayload {
    fn from(e: GitRunError) -> Self {
        match e {
            GitRunError::TimedOut { command, limit } => timed_out(&command, limit),
            other => GitErrorPayload::internal(other.to_string()),
        }
    }
}

/// Keep only the newest `cap` bytes of streamed output (whole lines) — the
/// same idea as Desktop's 256 KB terminal ring buffer.
const TAIL_CAP: usize = 256 * 1024;

fn push_capped(buf: &mut String, line: &str) {
    buf.push_str(line);
    buf.push('\n');
    if buf.len() > TAIL_CAP {
        let cut = buf.len() - TAIL_CAP;
        // Trim at a line boundary so the tail starts clean. Searched in bytes:
        // `cut` can fall inside a multi-byte character (every `✓` a test
        // runner prints), where slicing the str panics; a `\n` byte is always
        // a character boundary.
        let cut = buf.as_bytes()[cut..]
            .iter()
            .position(|&b| b == b'\n')
            .map_or(buf.len(), |i| cut + i + 1);
        buf.drain(..cut);
    }
}

/// A single git invocation. Build with [`GitCommand::new`], chain options,
/// then call [`run`](Self::run) or [`run_streaming`](Self::run_streaming).
pub struct GitCommand {
    program: OsString,
    cwd: Option<PathBuf>,
    args: Vec<OsString>,
    envs: Vec<(String, String)>,
    success_exit_codes: HashSet<i32>,
    stdin: Option<Vec<u8>>,
    read_only: bool,
    timeout: Option<Duration>,
}

impl GitCommand {
    pub fn new(cwd: impl Into<PathBuf>, args: &[&str]) -> Self {
        Self::new_owned(
            cwd,
            args.iter().map(std::string::ToString::to_string).collect(),
        )
    }

    pub fn new_owned(cwd: impl Into<PathBuf>, args: Vec<String>) -> Self {
        GitCommand {
            program: "git".into(),
            cwd: Some(cwd.into()),
            args: args.into_iter().map(OsString::from).collect(),
            envs: Vec::new(),
            success_exit_codes: HashSet::from([0]),
            stdin: None,
            read_only: false,
            timeout: None,
        }
    }

    /// A git that is not about any repository (`clone`, `ls-remote <url>`,
    /// `--version`): it runs in the process's own directory.
    pub fn without_repo(args: &[&str]) -> Self {
        let mut cmd = Self::new(PathBuf::new(), args);
        cmd.cwd = None;
        cmd
    }

    /// Test seam: run another program in place of `git`. A parameter rather
    /// than an environment variable or a `PATH` trick, so nothing outside
    /// the call can redirect a real run.
    pub fn program(mut self, program: impl Into<OsString>) -> Self {
        self.program = program.into();
        self
    }

    /// One more argument. Takes a path as it is, so a file name that is not
    /// UTF-8 reaches git intact.
    pub fn arg(mut self, arg: impl Into<OsString>) -> Self {
        self.args.push(arg.into());
        self
    }

    /// More arguments, after the ones already given.
    pub fn args<S: AsRef<std::ffi::OsStr>>(mut self, args: &[S]) -> Self {
        self.args
            .extend(args.iter().map(|a| a.as_ref().to_os_string()));
        self
    }

    /// Mark as a read query: prepends `--no-optional-locks` so background
    /// status/log refreshes never take `index.lock` out from under a
    /// user-initiated mutation (Desktop does this on every status call).
    pub fn read_only(mut self) -> Self {
        self.read_only = true;
        self
    }

    /// Accept additional exit codes as success (e.g. `{0, 1}` for
    /// `git diff --check`, which exits 1 when conflicts markers exist).
    pub fn success_codes(mut self, codes: &[i32]) -> Self {
        self.success_exit_codes = codes.iter().copied().collect();
        self
    }

    pub fn env(mut self, key: &str, val: &str) -> Self {
        self.envs.push((key.to_string(), val.to_string()));
        self
    }

    /// Bytes piped to git's stdin (commit messages via `-F -`, patches for
    /// `apply`, path lists for `update-index --stdin`).
    pub fn stdin(mut self, bytes: Vec<u8>) -> Self {
        self.stdin = Some(bytes);
        self
    }

    /// Pass `paths` as pathspecs over stdin (`--pathspec-from-file=-`), in
    /// place of `-- <paths>` on the command line. A large change set (Stage
    /// all on a few thousand files) overflows Windows' 32,767-character
    /// command line, and the spawn itself fails. Each entry is a literal filename;
    /// only for commands that take the flag (`add`, `restore`, `rm`, `reset`,
    /// `checkout`, `commit`, `stash push`). Replaces any [`stdin`](Self::stdin).
    pub fn pathspecs<S: AsRef<str>>(mut self, paths: &[S]) -> Self {
        self.args.insert(0, "--literal-pathspecs".into());
        self.args.push("--pathspec-from-file=-".into());
        self.args.push("--pathspec-file-nul".into());
        let mut bytes = Vec::new();
        for p in paths {
            bytes.extend_from_slice(p.as_ref().as_bytes());
            bytes.push(0);
        }
        self.stdin = Some(bytes);
        self
    }

    /// Kill git if it hasn't exited after `limit` ([`run`](Self::run) and
    /// [`output`](Self::output); a streaming run has none).
    /// For unattended network ops: a remote that never answers otherwise
    /// holds the calling thread for as long as TCP takes to give up, which
    /// can be minutes. Expiry is a `NetworkError`.
    pub fn timeout(mut self, limit: Duration) -> Self {
        self.timeout = Some(limit);
        self
    }

    /// `git <args>` as a display string for error payloads / logs.
    fn display(&self) -> String {
        let mut s = String::from("git");
        for a in &self.args {
            let a = a.to_string_lossy();
            s.push(' ');
            // Keep messages readable — elide long stdin-ish args. Cut on a
            // character boundary: an argument can be a path in any script.
            match a.char_indices().nth(57) {
                Some((cut, _)) if a.len() > 60 => {
                    s.push_str(&a[..cut]);
                    s.push('…');
                }
                _ => s.push_str(&a),
            }
        }
        s
    }

    fn command(&self) -> Command {
        let mut cmd = atlas_process::command(&self.program);
        if self.read_only {
            cmd.arg("--no-optional-locks");
        }
        if let Some(cwd) = &self.cwd {
            cmd.current_dir(cwd);
        }
        cmd.args(&self.args)
            // Never hang on a credential prompt — fail fast and let the UI
            // route the typed AuthFailed error instead.
            .env("GIT_TERMINAL_PROMPT", "0")
            // Stable English output so the error regex table matches
            // regardless of the user's locale.
            .env("LC_ALL", "C")
            .env("TERM", "dumb");
        for (k, v) in &self.envs {
            cmd.env(k, v);
        }
        cmd
    }

    /// Buffered run. `Ok` when the exit code is in `success_exit_codes`,
    /// otherwise a typed [`GitErrorPayload`] classified from stderr/stdout.
    pub fn run(self) -> Result<GitOutput, GitErrorPayload> {
        let display = self.display();
        let success_exit_codes = self.success_exit_codes.clone();
        let out = self.output()?;
        let exit_code = out.exit_code.unwrap_or(-1);
        let stdout = out.stdout_text();
        let stderr = out.stderr_text();
        if success_exit_codes.contains(&exit_code) {
            Ok(GitOutput {
                exit_code,
                stdout,
                stderr,
            })
        } else {
            Err(error::payload(display, out.exit_code, &stderr, &stdout))
        }
    }

    /// Run to exit and return what git printed, as bytes, whatever the exit
    /// code: for a caller whose exit code is an answer (`merge-base
    /// --is-ancestor`, `diff --no-index`), who reads binary output (a blob),
    /// or who words its own failure. Nothing is classified;
    /// [`success_codes`](Self::success_codes) does not apply.
    ///
    /// `Err` means no process ran to its end: no binary, a failed spawn, or
    /// the [`timeout`](Self::timeout).
    pub fn output(self) -> Result<GitRawOutput, GitRunError> {
        let display = self.display();
        let mut cmd = self.command();
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.stdin(if self.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });

        let mut child = cmd
            .spawn()
            .map_err(|e| spawn_error(&display, self.cwd.as_deref(), &e))?;

        // Feed stdin from a thread so a chatty child can't deadlock us.
        let stdin_fed = self
            .stdin
            .and_then(|bytes| child.stdin.take().map(|pipe| feed_stdin(pipe, bytes)));

        let out = match wait_with_deadline(child, self.timeout) {
            Ok(Some(out)) => Ok(out),
            Ok(None) => {
                return Err(GitRunError::TimedOut {
                    command: display,
                    limit: self.timeout.expect("only a deadline can time out"),
                })
            }
            Err(e) => Err(e),
        }
        .map_err(|e| GitRunError::Failed(format!("{display}: {e}")))?;
        // Git has exited, so the feeder is normally done: git read the
        // bytes, or its exit closed the pipe under the write. Whatever git
        // left running can still hold the read end without reading it, so
        // the feeder is waited on for the grace and no longer.
        if let Some(fed) = stdin_fed {
            let _ = fed.recv_timeout(STREAM_DRAIN_GRACE);
        }
        Ok(GitRawOutput {
            exit_code: out.status.code(),
            stdout: out.stdout,
            stderr: out.stderr,
        })
    }

    /// Run and keep at most `cap` bytes of stdout. Past the cap git is killed
    /// rather than drained: a 50 MB patch should cost `cap` bytes of reading.
    /// stderr is discarded, and stdin and the timeout are not used.
    pub fn stdout_capped(self, cap: usize) -> Result<CappedStdout, GitRunError> {
        use std::io::Read;
        let display = self.display();
        let mut child = self
            .command()
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null())
            .spawn()
            .map_err(|e| spawn_error(&display, self.cwd.as_deref(), &e))?;
        let mut bytes = Vec::new();
        let Some(mut stdout) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return Err(GitRunError::Failed(format!("{display}: no stdout pipe")));
        };
        // One byte past the cap tells "exactly cap" from "more than cap".
        let read = (&mut stdout).take(cap as u64 + 1).read_to_end(&mut bytes);
        drop(stdout);
        // Reaped on every path: a read error must not leave a zombie behind.
        if read.is_err() || bytes.len() > cap {
            let _ = child.kill();
            let _ = child.wait();
            read.map_err(|e| GitRunError::Failed(format!("{display}: {e}")))?;
            return Ok(CappedStdout {
                bytes,
                truncated: true,
                success: true,
            });
        }
        let status = child
            .wait()
            .map_err(|e| GitRunError::Failed(format!("{display}: {e}")))?;
        Ok(CappedStdout {
            bytes,
            truncated: false,
            success: status.success(),
        })
    }

    /// Streaming run: stdout/stderr are read line by line and forwarded to
    /// `sink` as they arrive (hook output, progress). The full (tail-capped)
    /// text is still collected so failures classify exactly like [`run`].
    ///
    /// Done when git exits, not when its pipes close: a hook that leaves a
    /// process running (a test runner's daemon, a dev server) hands it the
    /// write ends, and waiting for EOF held the operation open for as long
    /// as that process lived. After git exits, output already in flight gets
    /// [`STREAM_DRAIN_GRACE`] to arrive; the reader threads are then left to
    /// end by themselves when the last holder closes the pipe.
    pub fn run_streaming(self, sink: &dyn OpSink) -> Result<GitOutput, GitErrorPayload> {
        use std::sync::mpsc;

        enum Msg {
            Line(Stream, String),
            Eof,
            Exited(std::io::Result<std::process::ExitStatus>),
        }

        let display = self.display();
        let mut cmd = self.command();
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.stdin(if self.stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        });

        let mut child = cmd
            .spawn()
            .map_err(|e| spawn_error(&display, self.cwd.as_deref(), &e))?;

        let stdin_thread = self.stdin.and_then(|bytes| {
            child.stdin.take().map(|mut pipe| {
                std::thread::spawn(move || {
                    let _ = pipe.write_all(&bytes);
                })
            })
        });

        let (tx, rx) = mpsc::channel::<Msg>();
        let mut readers = 0;
        for (stream, pipe) in [
            (
                Stream::Stdout,
                child
                    .stdout
                    .take()
                    .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
            ),
            (
                Stream::Stderr,
                child
                    .stderr
                    .take()
                    .map(|p| Box::new(p) as Box<dyn std::io::Read + Send>),
            ),
        ] {
            let Some(pipe) = pipe else { continue };
            readers += 1;
            let tx = tx.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(pipe);
                let mut raw = Vec::new();
                loop {
                    raw.clear();
                    match read_progress(&mut reader, &mut raw) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    if tx.send(Msg::Line(stream, decode_line(&raw))).is_err() {
                        break;
                    }
                }
                let _ = tx.send(Msg::Eof);
            });
        }
        std::thread::spawn(move || {
            let _ = tx.send(Msg::Exited(child.wait()));
        });

        let mut stdout = String::new();
        let mut stderr = String::new();
        let mut status = None;
        let mut deadline: Option<Instant> = None;
        while readers > 0 || status.is_none() {
            let msg = match deadline {
                None => rx.recv().ok(),
                Some(d) => rx
                    .recv_timeout(d.saturating_duration_since(Instant::now()))
                    .ok(),
            };
            match msg {
                // Timed out draining, or every sender is gone.
                None => break,
                Some(Msg::Line(stream, line)) => {
                    sink.output(stream, &line);
                    match stream {
                        Stream::Stdout => push_capped(&mut stdout, &line),
                        Stream::Stderr => push_capped(&mut stderr, &line),
                    }
                }
                Some(Msg::Eof) => readers -= 1,
                Some(Msg::Exited(s)) => {
                    status = Some(s);
                    deadline = Some(Instant::now() + STREAM_DRAIN_GRACE);
                }
            }
        }
        if let Some(t) = stdin_thread {
            let _ = t.join();
        }

        let status = status
            .unwrap_or_else(|| Err(std::io::Error::other("git exited without a status")))
            .map_err(|e| GitErrorPayload::internal(format!("{display}: {e}")))?;
        let exit_code = status.code().unwrap_or(-1);
        if self.success_exit_codes.contains(&exit_code) {
            Ok(GitOutput {
                exit_code,
                stdout,
                stderr,
            })
        } else {
            Err(error::payload(display, status.code(), &stderr, &stdout))
        }
    }
}

/// Clone the tip of `url`'s default branch into `dest`: one commit, no tags,
/// and no LFS downloads. For a copy that is read and never worked in (a
/// skill pack, a reference repository). The run's own answer is returned so
/// each caller words its failure.
pub fn shallow_clone(url: &str, dest: &std::path::Path) -> Result<GitRawOutput, GitRunError> {
    // `--` so neither the URL nor the path can ever parse as a flag.
    GitCommand::without_repo(&["clone", "--depth", "1", "--no-tags", "--", url])
        .arg(dest)
        .env("GIT_LFS_SKIP_SMUDGE", "1")
        .env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o ConnectTimeout=15",
        )
        .timeout(Duration::from_secs(120))
        .output()
}

/// How long a run keeps reading git's pipes after git itself has exited
/// ([`GitCommand::run_streaming`], and any run with a timeout), and how long
/// [`GitCommand::output`] then waits for its stdin feeder.
const STREAM_DRAIN_GRACE: Duration = Duration::from_millis(500);

/// Write `bytes` to git's stdin on a thread of its own, and close the pipe.
/// The receiver hears once when that is over, written or refused. The thread
/// is never joined: a write blocked on a pipe nobody reads cannot be
/// interrupted, and ends by itself when the last holder closes the read end.
fn feed_stdin(mut pipe: std::process::ChildStdin, bytes: Vec<u8>) -> std::sync::mpsc::Receiver<()> {
    let (done, fed) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = pipe.write_all(&bytes);
        drop(pipe);
        let _ = done.send(());
    });
    fed
}

/// One raw line as text: the trailing `\n` / `\r\n` dropped, as
/// [`BufRead::lines`] does, but bytes that are not UTF-8 (a Windows console
/// codepage, a test printing a binary fixture) replaced instead of ending
/// the stream.
fn decode_line(raw: &[u8]) -> String {
    let raw = raw.strip_suffix(b"\n").unwrap_or(raw);
    let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
    String::from_utf8_lossy(raw).into_owned()
}

/// Git redraws progress with CR and terminates phases with LF. Both are
/// complete records; waiting for LF hides every intermediate percentage.
fn read_progress(reader: &mut impl BufRead, raw: &mut Vec<u8>) -> std::io::Result<usize> {
    loop {
        let chunk = reader.fill_buf()?;
        if chunk.is_empty() {
            return Ok(raw.len());
        }
        let end = chunk.iter().position(|b| *b == b'\r' || *b == b'\n');
        let n = end.map_or(chunk.len(), |i| i + 1);
        raw.extend_from_slice(&chunk[..n]);
        reader.consume(n);
        if end.is_some() {
            if raw.len() == 1 {
                raw.clear();
                continue;
            }
            return Ok(raw.len());
        }
    }
}

/// `wait_with_output` with a deadline: `Ok(None)` once `limit` passes, after
/// killing the child. Pipes drain on their own threads so a chatty child
/// can't block on a full pipe while we poll.
///
/// Those threads are never joined without a limit. A process git started can
/// hold a pipe open after git is gone: a helper (`ssh`, `git-remote-https`)
/// briefly, a hook that left something in the background for as long as that
/// lives. So once git has exited the pipes get [`STREAM_DRAIN_GRACE`] to
/// reach their end, and whatever was read by then is the output.
fn wait_with_deadline(
    mut child: Child,
    limit: Option<Duration>,
) -> std::io::Result<Option<std::process::Output>> {
    use std::io::Read;
    use std::sync::{mpsc, Arc, Mutex};
    type Drained = (Arc<Mutex<Vec<u8>>>, mpsc::Receiver<()>);
    fn drain(pipe: Option<impl Read + Send + 'static>) -> Drained {
        let read = Arc::new(Mutex::new(Vec::new()));
        let (done, ended) = mpsc::channel();
        let into = read.clone();
        std::thread::spawn(move || {
            if let Some(mut pipe) = pipe {
                let mut chunk = [0u8; 8192];
                loop {
                    match pipe.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut buf = into
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            buf.extend_from_slice(&chunk[..n]);
                        }
                    }
                }
            }
            let _ = done.send(());
        });
        (read, ended)
    }
    fn taken(read: &Arc<Mutex<Vec<u8>>>) -> Vec<u8> {
        std::mem::take(
            &mut *read
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }
    let (out, out_ended) = drain(child.stdout.take());
    let (err, err_ended) = drain(child.stderr.take());
    let deadline = limit.map(|limit| Instant::now() + limit);
    loop {
        if let Some(status) = child.try_wait()? {
            let grace = Instant::now() + STREAM_DRAIN_GRACE;
            for ended in [&out_ended, &err_ended] {
                let _ = ended.recv_timeout(grace.saturating_duration_since(Instant::now()));
            }
            return Ok(Some(std::process::Output {
                status,
                stdout: taken(&out),
                stderr: taken(&err),
            }));
        }
        if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn timed_out(display: &str, limit: Duration) -> GitErrorPayload {
    let message = format!("{display} timed out after {}s", limit.as_secs());
    GitErrorPayload {
        code: error::GitErrorCode::NetworkError,
        raw_stderr: message.clone(),
        message,
        command: display.to_string(),
        exit_code: None,
        files: Vec::new(),
        hint: None,
    }
}

/// A spawn that failed. `NotFound` is "git is not installed" unless the
/// working directory is the thing that is missing: a deleted worktree or
/// project gives the same error kind, and "install git" would be the wrong
/// thing to tell its owner.
fn spawn_error(display: &str, cwd: Option<&std::path::Path>, e: &std::io::Error) -> GitRunError {
    if e.kind() != std::io::ErrorKind::NotFound {
        return GitRunError::Failed(format!("failed to start {display}: {e}"));
    }
    match cwd {
        Some(dir) if !dir.is_dir() => GitRunError::Failed(format!(
            "{display}: the folder {} does not exist",
            dir.display()
        )),
        _ => GitRunError::NotInstalled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct CollectSink(Mutex<Vec<(Stream, String)>>);
    impl OpSink for CollectSink {
        fn output(&self, stream: Stream, line: &str) {
            self.0.lock().unwrap().push((stream, line.to_string()));
        }
    }

    fn temp_repo() -> tempfile::TempDir {
        // `SystemTime` names collide when these tests start together, making
        // concurrent `git init` calls race while copying template files.
        // TempDir reserves a unique directory atomically and removes it on
        // drop, covering both parallel tests and failed assertions.
        let root = tempfile::Builder::new()
            .prefix("atlas-git-exec-")
            .tempdir()
            .unwrap();
        GitCommand::new(root.path(), &["init", "-q", "-b", "main"])
            .run()
            .unwrap();
        root
    }

    #[test]
    fn run_success_and_typed_failure() {
        let repo = temp_repo();
        let out = GitCommand::new(repo.path(), &["status", "--porcelain"])
            .read_only()
            .run()
            .unwrap();
        assert_eq!(out.exit_code, 0);

        // Unknown ref → typed error, not a raw string.
        let err = GitCommand::new(repo.path(), &["log", "no-such-ref"])
            .run()
            .unwrap_err();
        assert_eq!(err.code, crate::GitErrorCode::UnknownRef);
        assert!(!err.raw_stderr.is_empty());
    }

    #[test]
    fn timeout_kills_and_returns_promptly() {
        let repo = temp_repo();
        // A shell alias whose grandchild outlives the killed git and holds the
        // pipes open — the case where joining the readers would hang.
        let started = Instant::now();
        let err = GitCommand::new(repo.path(), &["-c", "alias.slow=!sleep 10", "slow"])
            .timeout(Duration::from_millis(300))
            .run()
            .unwrap_err();
        assert_eq!(err.code, crate::GitErrorCode::NetworkError);
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "took {:?}",
            started.elapsed()
        );

        // Within the limit, a timed run behaves exactly like an untimed one.
        let out = GitCommand::new(repo.path(), &["status", "--porcelain"])
            .timeout(Duration::from_secs(30))
            .run()
            .unwrap();
        assert_eq!(out.exit_code, 0);
    }

    #[test]
    fn success_codes_contract() {
        let repo = temp_repo();
        // `git diff --check` on a clean tree exits 0; asking for an accepted
        // extra code must not break the success path.
        let out = GitCommand::new(repo.path(), &["diff", "--check"])
            .success_codes(&[0, 2])
            .run()
            .unwrap();
        assert_eq!(out.exit_code, 0);
    }

    #[test]
    fn streaming_forwards_lines_and_stdin() {
        let repo = temp_repo();
        std::fs::write(repo.path().join("f.txt"), "hello\n").unwrap();
        GitCommand::new(repo.path(), &["add", "f.txt"])
            .run()
            .unwrap();

        let sink = CollectSink(Mutex::new(Vec::new()));
        let out = GitCommand::new(repo.path(), &["commit", "-F", "-"])
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .stdin(b"streamed commit message\n".to_vec())
            .run_streaming(&sink)
            .unwrap();
        assert_eq!(out.exit_code, 0);
        let lines = sink.0.lock().unwrap();
        assert!(
            lines
                .iter()
                .any(|(_, l)| l.contains("streamed commit message")),
            "commit summary should stream through the sink: {lines:?}"
        );
    }

    /// A repo with one staged file and `hook` installed as its pre-commit.
    fn repo_with_pre_commit(hook: &str) -> tempfile::TempDir {
        let repo = temp_repo();
        std::fs::write(repo.path().join("f.txt"), "hello\n").unwrap();
        GitCommand::new(repo.path(), &["add", "f.txt"])
            .run()
            .unwrap();
        let hooks = repo.path().join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let path = hooks.join("pre-commit");
        std::fs::write(&path, hook).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        repo
    }

    fn streamed_commit(
        repo: &std::path::Path,
        sink: &CollectSink,
    ) -> Result<GitOutput, GitErrorPayload> {
        GitCommand::new(repo, &["commit", "-q", "-F", "-"])
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .stdin(b"msg\n".to_vec())
            .run_streaming(sink)
    }

    /// Hook output is not always UTF-8 (a Windows console codepage, a test
    /// printing a binary fixture). One such line must not end the stream:
    /// the reader used to stop there, closing the pipe under the hook.
    #[test]
    fn streaming_survives_non_utf8_output() {
        let repo = repo_with_pre_commit(
            "#!/bin/sh\nprintf 'caf\\351 \\377\\n'\ni=0\nwhile [ $i -lt 3000 ]; do echo \"after $i\"; i=$((i+1)); done\n",
        );
        let sink = CollectSink(Mutex::new(Vec::new()));
        let out = streamed_commit(repo.path(), &sink).unwrap();
        assert_eq!(out.exit_code, 0);
        let lines = sink.0.lock().unwrap();
        assert!(lines.iter().any(|(_, l)| l.starts_with("caf")), "{lines:?}");
        assert!(lines.iter().any(|(_, l)| l == "after 2999"));
        // git sends hook stdout to its own stderr.
        assert!(out.stderr.contains("after 2999"));
    }

    /// A hook that leaves a background process behind (a test runner's
    /// daemon, a watcher) hands it the pipes. Git is done; the operation must
    /// be too, not wait for that process to exit.
    #[test]
    fn streaming_returns_when_git_exits_despite_lingering_grandchild() {
        let repo =
            repo_with_pre_commit("#!/bin/sh\necho hook-ran\n(sleep 20; echo late) &\nexit 0\n");
        let sink = CollectSink(Mutex::new(Vec::new()));
        let started = Instant::now();
        let out = streamed_commit(repo.path(), &sink).unwrap();
        assert_eq!(out.exit_code, 0);
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "took {:?}",
            started.elapsed()
        );
        assert!(sink.0.lock().unwrap().iter().any(|(_, l)| l == "hook-ran"));
    }

    /// A timed run whose git exits while something it started still holds
    /// the pipes (a hook that left a process in the background) answers with
    /// what was read, not when that process exits.
    #[cfg(unix)]
    #[test]
    fn a_timed_run_returns_when_git_exits_despite_lingering_grandchild() {
        let repo = temp_repo();
        let started = Instant::now();
        let out = GitCommand::new(
            repo.path(),
            &[
                "-c",
                "alias.linger=!echo ran; (sleep 20; echo late) &",
                "linger",
            ],
        )
        .timeout(Duration::from_secs(30))
        .output()
        .unwrap();
        assert!(out.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("ran"));
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "took {:?}",
            started.elapsed()
        );
    }

    /// The stdin feeder is not waited on without a limit. A process git
    /// left behind can hold the read end of stdin and never read it, so a
    /// body larger than the pipe never finishes being written: git is done,
    /// and the run must be too. The program here exits without reading,
    /// leaving a child that holds that read end as descriptor 3 (a
    /// background job's own stdin is `/dev/null`).
    #[cfg(unix)]
    #[test]
    fn a_run_returns_when_git_exits_though_its_stdin_was_never_read() {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("fake-git");
        std::fs::write(
            &script,
            "exec 3<&0\nsleep 20 >/dev/null 2>&1 &\necho ran\nexit 0\n",
        )
        .unwrap();
        for limit in [None, Some(Duration::from_secs(60))] {
            let mut cmd = GitCommand::new(dir.path(), &[])
                .program("/bin/sh")
                .arg(&script)
                // Far more than a pipe holds, so the write cannot complete.
                .stdin(vec![b'x'; 4 * 1024 * 1024]);
            if let Some(limit) = limit {
                cmd = cmd.timeout(limit);
            }
            let started = Instant::now();
            let out = cmd.output().unwrap();
            assert!(out.success());
            assert_eq!(out.stdout, b"ran\n");
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "timeout {limit:?}: took {:?}",
                started.elapsed()
            );
        }
    }

    /// A folder that is gone is not "git is not installed": on Unix both are
    /// a `NotFound` from the spawn. (Windows reports a missing folder with
    /// its own error kind, which never read as git missing.)
    #[cfg(unix)]
    #[test]
    fn a_missing_folder_is_not_reported_as_git_missing() {
        let gone = tempfile::tempdir().unwrap().path().join("deleted-worktree");
        let err = GitCommand::new(&gone, &["status"]).output().unwrap_err();
        match err {
            GitRunError::Failed(message) => {
                assert!(message.contains("does not exist"), "{message}")
            }
            other => panic!("expected a failure naming the folder, got {other:?}"),
        }
    }

    /// Stage all on a big change set: well past Windows' 32,767-character
    /// command line when the paths go on argv.
    #[test]
    fn pathspecs_over_stdin_handle_huge_file_lists() {
        let repo = temp_repo();
        let dir = repo.path().join("a-fairly-long-directory-name-for-padding");
        std::fs::create_dir_all(&dir).unwrap();
        let mut files = Vec::new();
        for i in 0..2500 {
            let rel = format!("a-fairly-long-directory-name-for-padding/file with space {i}.txt");
            std::fs::write(repo.path().join(&rel), "x\n").unwrap();
            files.push(rel);
        }
        assert!(files.iter().map(|f| f.len() + 1).sum::<usize>() > 100_000);
        GitCommand::new(repo.path(), &["add"])
            .pathspecs(&files)
            .run()
            .unwrap();
        let staged = GitCommand::new(repo.path(), &["diff", "--cached", "--name-only"])
            .run()
            .unwrap();
        assert_eq!(staged.stdout.lines().count(), 2500);

        GitCommand::new(repo.path(), &["rm", "-q", "--cached", "--ignore-unmatch"])
            .pathspecs(&files[..10])
            .run()
            .unwrap();
        let staged = GitCommand::new(repo.path(), &["diff", "--cached", "--name-only"])
            .run()
            .unwrap();
        assert_eq!(staged.stdout.lines().count(), 2490);
    }

    #[test]
    fn tail_cap_keeps_newest() {
        let mut buf = String::new();
        for i in 0..20_000 {
            push_capped(&mut buf, &format!("line-{i} pad pad pad pad pad"));
        }
        assert!(buf.len() <= TAIL_CAP + 64);
        assert!(buf.contains("line-19999"));
        assert!(!buf.contains("line-0 "));
    }

    /// The cap used to slice the str at a byte offset, which panics inside a
    /// multi-byte character — the `✓` every passing test prints — and killed
    /// the operation once a hook had printed 256 KB.
    #[test]
    fn tail_cap_survives_multibyte_characters() {
        for pad in 0..4 {
            let mut buf = String::new();
            let prefix = "x".repeat(pad);
            for i in 0..10_000 {
                push_capped(
                    &mut buf,
                    &format!("{prefix}  ✓ suite › case {i} passed (1.2ms)"),
                );
            }
            assert!(buf.len() <= TAIL_CAP);
            assert!(buf.ends_with("case 9999 passed (1.2ms)\n"));
            assert!(buf.starts_with(&prefix));
        }
    }
}
