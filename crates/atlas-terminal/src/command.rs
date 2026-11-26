//! One-shot command terminals — the engine behind ACP's `terminal/*` methods
//! (P1.2, `plans/atlas-acp-parity-loop.md`).
//!
//! This is a different animal from [`crate::TerminalManager`], which exists to
//! back the *interactive* terminal pane: that one spawns `$SHELL -l`, streams
//! every byte to the UI over an mpsc channel, and never ends. ACP instead asks
//! the client to run one specific `command` + `args`, retain a bounded window of
//! its output, and report an exit status — a command runner. Trying to express
//! that on top of the interactive manager would mean writing a command into a
//! login shell's stdin and guessing where its output ended, so the two share
//! `portable_pty` and nothing else.
//!
//! A PTY (rather than plain pipes) is deliberate: the agent runs build tools and
//! test runners, and those switch to terse, un-coloured output when they detect
//! they are not attached to a terminal. Running them on a PTY is what makes the
//! captured output match what the user would have seen in their own shell.

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, CommandBuilder, ExitStatus, PtySize};

/// Bytes retained when the agent does not specify `outputByteLimit`.
///
/// The ACP field is optional, and an unbounded buffer is not an option: a
/// runaway `yes` or a chatty watch process would grow it until the host is
/// killed. 1 MiB comfortably holds a full test-suite run while bounding the
/// worst case.
pub const DEFAULT_OUTPUT_BYTE_LIMIT: u64 = 1024 * 1024;

/// PTY geometry for agent-run commands. Nothing renders this, but the width
/// still matters: tools wrap their output to `$COLUMNS`, and the 80-column
/// default would hard-wrap paths and diffs in the text the agent reads back.
const PTY_COLS: u16 = 120;
const PTY_ROWS: u16 = 30;

/// How a finished command ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandExit {
    /// `None` when the process was terminated by a signal.
    pub exit_code: Option<u32>,
    /// Signal name (e.g. `SIGKILL`) when killed, else `None`.
    pub signal: Option<String>,
}

/// A bounded, UTF-8-safe window over a command's output.
///
/// ACP requires truncation from the **beginning** — the most recent output is
/// what matters to an agent reading a failure — and requires that the retained
/// bytes stay a valid string. Both are easy to get subtly wrong, so they live
/// here behind tests rather than at the call site.
///
/// Public because a PTY is not the only thing that accumulates a command's
/// output: a DISPLAY-ONLY terminal (one the agent runs itself, streaming its
/// output to us as `session/update` meta) has no `CommandTerminal` at all, and
/// `atlas-acp-thread` buffers those bytes directly. That buffer needs the same
/// cap and the same boundary walk, and reimplementing either is how they drift.
#[derive(Debug)]
pub struct OutputBuffer {
    /// The decoded window. Held as text rather than bytes so a reader can
    /// borrow it: flattening a terminal into a tool call's result happens on
    /// every output chunk, and decoding the whole buffer each time is what made
    /// that cost quadratic in what the command had printed (ATL-219).
    text: String,
    /// Bytes of `text` that have been dropped from the window but not yet from
    /// the allocation. Always on a character boundary.
    ///
    /// Truncation used to `drain(..cut)` on every overflowing push, which moves
    /// the whole retained window — up to the limit, a megabyte by default —
    /// for the sake of the few bytes that overflowed. A command that printed
    /// past the limit then paid a megabyte-sized memmove per chunk for the rest
    /// of its life. Advancing an offset instead costs nothing, and the real
    /// compaction happens once the dead prefix has grown past the live window,
    /// so its cost is paid once per `limit` bytes rather than once per chunk.
    head: usize,
    /// Bytes dropped from the front over the buffer's whole life. With `len`
    /// this places the window in the command's total output: a reader that
    /// remembers how far into that stream it last read can be served the bytes
    /// since, even after the front has gone — see `end` and
    /// `AcpTerminal::output_appended`.
    dropped: usize,
    /// Trailing bytes that may be the start of a character whose remaining
    /// bytes have not arrived yet. Decoding them now would put a replacement
    /// char in the window that the next chunk would have completed.
    pending: Vec<u8>,
    limit: usize,
    truncated: bool,
}

impl OutputBuffer {
    pub fn new(limit: u64) -> Self {
        Self {
            text: String::new(),
            head: 0,
            dropped: 0,
            pending: Vec::new(),
            // Saturating: `u64::MAX` from a careless agent must clamp, not wrap
            // to a tiny buffer on 32-bit.
            limit: usize::try_from(limit).unwrap_or(usize::MAX),
            truncated: false,
        }
    }

    pub fn push(&mut self, chunk: &[u8]) {
        self.pending.extend_from_slice(chunk);
        let hold = incomplete_tail_len(&self.pending);
        let split = self.pending.len() - hold;
        if split > 0 {
            self.text
                .push_str(&String::from_utf8_lossy(&self.pending[..split]));
            self.pending.drain(..split);
        }
        let live = self.text.len() - self.head;
        if live <= self.limit {
            return;
        }
        self.truncated = true;
        // Drop from the front, then walk forward to the next character
        // boundary. Slicing on a raw byte offset would cut a multi-byte
        // character in half and every later read would show a replacement char
        // at the head of the window.
        let mut cut = self.head + (live - self.limit);
        while cut < self.text.len() && !self.text.is_char_boundary(cut) {
            cut += 1;
        }
        self.dropped += cut - self.head;
        self.head = cut;
        // Reclaim once the dead prefix outweighs what it is keeping alive. The
        // window this leaves is byte-for-byte the one an immediate drain would
        // have left — only the allocation behind it differs — so the buffer
        // still holds exactly the last `limit` bytes however the writes were
        // chunked.
        if self.head > self.limit {
            self.text.drain(..self.head);
            self.head = 0;
            // `drain` keeps the capacity, which had grown to hold the dead
            // prefix too — up to twice the limit, per terminal, for the life of
            // the thread. Hand the excess back; the window itself is unchanged.
            self.text.shrink_to(self.limit.saturating_mul(2));
        }
    }

    /// The retained window.
    ///
    /// Lossy by necessity — a command may emit genuinely non-UTF-8 bytes (a
    /// binary blob, a latin-1 log) and ACP's `output` field is a string, so
    /// there is nothing else to return. The boundary walk in [`Self::push`]
    /// means truncation itself never manufactures a replacement character;
    /// anything here came from the child.
    ///
    /// A partially-arrived character at the very end is not shown until the
    /// rest of it lands. That is a character appearing one chunk late rather
    /// than a replacement char that later vanishes, and it is why the window
    /// can be decoded once on write instead of on every read.
    pub fn text(&self) -> &str {
        // `head` is advanced only to a character boundary.
        &self.text[self.head..]
    }

    /// Whether anything has been dropped from the front. Sticky: once a buffer
    /// has truncated, no later read can honestly claim a complete capture.
    pub fn truncated(&self) -> bool {
        self.truncated
    }

    pub fn is_empty(&self) -> bool {
        self.text.len() == self.head
    }

    /// Retained bytes. Used to account for a buffer's cost from outside.
    pub fn len(&self) -> usize {
        self.text.len() - self.head
    }

    /// Bytes dropped from the front so far — where the window starts in the
    /// command's total output.
    pub fn dropped(&self) -> usize {
        self.dropped
    }

    /// Record that output was lost before it reached this buffer, so a reader
    /// cannot mistake what it holds for a complete capture. Sticky, as
    /// truncation by the limit is.
    pub fn mark_truncated(&mut self) {
        self.truncated = true;
    }

    /// Where the window ends in the command's total output: every byte ever
    /// pushed, dropped or retained.
    pub fn end(&self) -> usize {
        self.dropped + self.len()
    }
}

/// How many trailing bytes are the start of a character that has not fully
/// arrived, and so must not be decoded yet.
///
/// A UTF-8 character is at most four bytes, so only the last three can be
/// waiting on more. Anything that is not a lead byte in that window — a stray
/// continuation byte, an invalid byte — is genuinely malformed and is decoded
/// now, so a corrupt stream cannot wedge the buffer.
fn incomplete_tail_len(bytes: &[u8]) -> usize {
    let len = bytes.len();
    for back in 1..=3.min(len) {
        let byte = bytes[len - back];
        if byte & 0b1100_0000 == 0b1000_0000 {
            continue;
        }
        let needed = match byte {
            0x00..=0x7f => 1,
            0xc0..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf7 => 4,
            // Not a lead byte at all: malformed, and no amount of waiting
            // makes it valid.
            _ => return 0,
        };
        return if back < needed { back } else { 0 };
    }
    0
}

/// Shared state for one running (or finished) command.
#[derive(Debug)]
struct Inner {
    output: Mutex<OutputBuffer>,
    exit: Mutex<Option<CommandExit>>,
    /// How the child ended in the kernel's own words, read the moment it ended
    /// and before anything reaped it (`release_slave_after_exit`, unix only).
    /// The reader thread records this as the exit when it is there: the status
    /// portable-pty hands back cannot name a signal — see `exit_from`.
    ended: Mutex<Option<CommandExit>>,
    /// Signalled once when the child exits, so `wait_for_exit` can park instead
    /// of polling.
    exit_notify: tokio::sync::Notify,
    /// Signalled every time the reader thread appends, and once more at exit,
    /// so a watcher can follow the output without polling.
    output_notify: tokio::sync::Notify,
}

/// A single command running on a PTY.
pub struct CommandTerminal {
    inner: Arc<Inner>,
    /// Kept so `kill` can signal the child. `portable_pty`'s `Child` needs
    /// `&mut` to kill, hence the mutex.
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
}

impl std::fmt::Debug for CommandTerminal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CommandTerminal")
            .field("exited", &self.exit_status().is_some())
            .finish_non_exhaustive()
    }
}

impl CommandTerminal {
    /// Spawn `command` with `args` on a PTY and start draining its output.
    ///
    /// Returns as soon as the child is running — output accumulates on a reader
    /// thread, so a long build does not block the ACP connection.
    pub fn spawn(
        command: &str,
        args: &[String],
        env: &[(String, String)],
        cwd: Option<&std::path::Path>,
        output_byte_limit: u64,
    ) -> anyhow::Result<Self> {
        let pair = native_pty_system().openpty(PtySize {
            rows: PTY_ROWS,
            cols: PTY_COLS,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(command);
        cmd.env_clear();
        for (key, value) in atlas_process::host_environment() {
            cmd.env(key, value);
        }
        for arg in args {
            cmd.arg(arg);
        }
        for (k, v) in env {
            cmd.env(k, v);
        }
        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }

        let child = pair.slave.spawn_command(cmd)?;
        let inner = Arc::new(Inner {
            output: Mutex::new(OutputBuffer::new(output_byte_limit)),
            exit: Mutex::new(None),
            ended: Mutex::new(None),
            exit_notify: tokio::sync::Notify::new(),
            output_notify: tokio::sync::Notify::new(),
        });
        // Our copy of the slave must close, or the master read never sees EOF
        // and `wait_for_exit` hangs forever after the command finishes — but
        // only once the command has exited, not now. The same wait reads how
        // it ended. See the function.
        release_slave_after_exit(pair.slave, child.process_id(), inner.clone());

        let mut reader = pair.master.try_clone_reader()?;
        let child = Arc::new(Mutex::new(child));
        #[cfg(unix)]
        let retained_master = pair.master;
        #[cfg(not(unix))]
        {
            let retained_master = pair.master;
            let exit_child = child.clone();
            let exit_inner = inner.clone();
            std::thread::spawn(move || {
                loop {
                    let status = exit_child
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .try_wait();
                    match status {
                        Ok(Some(status)) => {
                            *exit_inner
                                .ended
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner) =
                                Some(exit_from(Some(status)));
                            break;
                        }
                        Err(_) => break,
                        Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
                    }
                }
                // ClosePseudoConsole must run while a separate reader drains
                // output. Keeping it until here also prevents spawn() from
                // destroying the command's console before it has run.
                drop(retained_master);
            });
        }

        // Reader thread: blocking reads off the PTY master until EOF, which
        // arrives when the child exits and the last slave fd closes.
        let reader_inner = inner.clone();
        let reader_child = child.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut out) = reader_inner.output.lock() {
                            out.push(&buf[..n]);
                        }
                        reader_inner.output_notify.notify_waiters();
                    }
                }
            }
            // Close the master before reaping. If the loop ended on a read
            // error rather than EOF, the child may still be in its exit,
            // blocked until its tty output is read; with the master closed
            // that wait ends, and the reap below cannot deadlock against it.
            drop(reader);
            #[cfg(unix)]
            drop(retained_master);
            // EOF — reap the child so the exit status is real rather than
            // inferred from the pipe closing. The exit is recorded before the
            // child's lock is let go: `kill` signals the pid only while it
            // holds that lock and finds no exit recorded, and once the child
            // is reaped the pid may belong to another process.
            let mut child = reader_child
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let status = child.wait().ok();
            // Always there by now on unix: EOF waits on the slave copy that
            // `release_slave_after_exit` closes only after reading it.
            let ended = reader_inner
                .ended
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .take();
            if let Ok(mut slot) = reader_inner.exit.lock() {
                *slot = Some(ended.unwrap_or_else(|| exit_from(status)));
            }
            drop(child);
            reader_inner.exit_notify.notify_waiters();
            // Wake output watchers too: the last append before EOF may have
            // landed while nobody was registered, and this is their signal to
            // read it and stop.
            reader_inner.output_notify.notify_waiters();
        });

        Ok(Self { inner, child })
    }

    /// Output retained so far, and whether anything was dropped from the front.
    pub fn output(&self) -> (String, bool) {
        match self.inner.output.lock() {
            Ok(out) => (out.text().to_string(), out.truncated),
            Err(_) => (String::new(), false),
        }
    }

    /// Run `f` over the output buffer itself, without copying it. The buffer
    /// knows how much it has dropped, so `f` can serve a tail against an
    /// offset into the command's total output whether or not the front is
    /// gone.
    pub fn with_output_buffer<R>(&self, f: impl FnOnce(&OutputBuffer) -> R) -> R {
        let out = self
            .inner
            .output
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        f(&out)
    }

    /// Run `f` over the retained output without copying it.
    ///
    /// `None` when the buffer has dropped its front, because a caller holding a
    /// byte offset into an earlier read can no longer trust that the offset
    /// names the same position. Such a caller re-reads the whole window through
    /// [`Self::output`]; this exists so the case where nothing was dropped —
    /// the common one — costs a lock and nothing else (ATL-219).
    pub fn with_untruncated_output<R>(&self, f: impl FnOnce(&str) -> R) -> Option<R> {
        let out = self
            .inner
            .output
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        (!out.truncated).then(|| f(out.text()))
    }

    /// `Some` once the command has exited.
    pub fn exit_status(&self) -> Option<CommandExit> {
        self.inner.exit.lock().ok().and_then(|s| s.clone())
    }

    /// Park until the command appends output, or exits.
    ///
    /// Deliberately carries no payload and no cursor: a watcher re-reads the
    /// whole retained buffer, so notifications COALESCE — a command printing in
    /// a tight loop wakes its watcher as often as it happens to be registered,
    /// not once per write. That is the behaviour wanted; the alternative is a
    /// wake per byte for output nobody has rendered yet.
    ///
    /// Returns immediately once the command has exited, so a watcher loop that
    /// checks `exit_status` terminates rather than parking forever.
    ///
    /// See [`Self::wait_for_exit`] for why `enable()` and not a bare `await`.
    ///
    /// Interest is registered at the FIRST POLL, not when this is called, and
    /// an append with nobody registered wakes nobody. A watcher therefore polls
    /// the future once, then reads the buffer, then awaits it; reading first
    /// leaves a gap in which output lands and is never reported.
    pub async fn output_changed(&self) {
        let notified = self.inner.output_notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.exit_status().is_some() {
            return;
        }
        notified.await;
    }

    /// Park until the command exits, then return how it ended.
    ///
    /// `enable()` is what actually registers interest. A `Notified` future
    /// created but not yet polled is NOT in the notify list, so
    /// `notify_waiters()` firing between construction and the first `await`
    /// would reach nobody — and since the reader thread signals exit exactly
    /// once, the waiter would then park forever on a command that has already
    /// finished. `tokio::pin!` + `enable()` moves that registration ahead of
    /// the status check, which is the whole point of checking after it.
    pub async fn wait_for_exit(&self) -> CommandExit {
        loop {
            let notified = self.inner.exit_notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(status) = self.exit_status() {
                return status;
            }
            notified.await;
            if let Some(status) = self.exit_status() {
                return status;
            }
        }
    }

    /// Kill the command. Idempotent — killing an already-exited command is a
    /// no-op, not an error, because the agent's kill can always race the
    /// process finishing on its own.
    pub fn kill(&self) -> anyhow::Result<()> {
        // Held for the whole kill. The reader thread reaps under this lock and
        // records the exit before letting go of it, so while it is held an
        // exit not yet recorded means the child is not reaped: the pid is
        // still this command's to signal.
        let mut child = self
            .child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if self.exit_status().is_some() {
            return Ok(());
        }
        #[cfg(unix)]
        if let Some(pid) = child.process_id() {
            // Hang up now; the grace period and the SIGKILL that may follow
            // run on their own thread. Callers kill from inside the ACP
            // dispatch drain with the thread or registry lock held, and the
            // grace sleeps (up to 200 ms per terminal) used to run there.
            hang_up(pid);
            drop(child);
            let child = self.child.clone();
            let inner = self.inner.clone();
            std::thread::spawn(move || escalate_kill(pid, &child, &inner));
            return Ok(());
        }
        let _ = child.kill();
        Ok(())
    }
}

/// Close the parent's copy of the PTY slave once the command has exited, not
/// straight after spawning it.
///
/// Dropping it at once makes the command's own exit the slave's LAST close, and
/// on macOS that close can discard output still queued for the master: a
/// command that writes and exits at once (`echo hi`) has its `write` succeed
/// and exits 0, and the reader gets EOF having read nothing. It takes
/// concurrent PTY spawns to trigger — a parallel test run, or an agent running
/// two commands — and never happens alone, where the exiting session leader
/// blocks until its tty has been read. Holding a copy until the command is
/// gone means its close is never the last one, so its output stays queued
/// until the reader takes it, and EOF arrives when this copy closes.
///
/// `WNOWAIT` leaves the child unreaped: the reader thread still reaps it after
/// EOF. Descendants that keep the slave open still hold EOF off, as before.
///
/// That makes this wait the one place that sees the child's own account of how
/// it ended before anything reaps it, and the only account that can name a
/// signal (#31), so it is kept in `inner.ended` for the reader to record. It is
/// always there in time: EOF cannot arrive before the slave copy closes below.
#[cfg(unix)]
fn release_slave_after_exit(
    slave: Box<dyn portable_pty::SlavePty + Send>,
    pid: Option<u32>,
    inner: Arc<Inner>,
) {
    let Some(pid) = pid else {
        drop(slave);
        return;
    };
    std::thread::spawn(move || {
        loop {
            // SAFETY: an all-zero `siginfo_t` is a valid out-parameter, and
            // `waitid` writes nothing else.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let rc =
                unsafe { libc::waitid(libc::P_PID, pid, &mut info, libc::WEXITED | libc::WNOWAIT) };
            if rc == 0 {
                if let Some(exit) = exit_from_siginfo(&info) {
                    *inner
                        .ended
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(exit);
                }
                break;
            }
            // Anything but an interrupted wait means the child is gone, with
            // nothing left to read: reaped already, which only the reader
            // thread does, and only after a read error rather than EOF.
            if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
                break;
            }
        }
        drop(slave);
    });
}

/// Windows' ConPTY has no slave fd for an exiting child to close last, and a
/// Windows process ends with an exit code, never a signal.
#[cfg(not(unix))]
fn release_slave_after_exit(
    slave: Box<dyn portable_pty::SlavePty + Send>,
    _pid: Option<u32>,
    _inner: Arc<Inner>,
) {
    drop(slave);
}

/// How a child ended, from what `waitid` reported for it.
#[cfg(unix)]
fn exit_from_siginfo(info: &libc::siginfo_t) -> Option<CommandExit> {
    // SAFETY: `waitid` succeeded, so `info` describes a child that changed
    // state, which is what `si_status` is defined for.
    let status = unsafe { info.si_status() };
    match info.si_code {
        libc::CLD_EXITED => Some(CommandExit {
            exit_code: u32::try_from(status).ok(),
            signal: None,
        }),
        libc::CLD_KILLED | libc::CLD_DUMPED => Some(CommandExit {
            exit_code: None,
            signal: Some(signal_name(status)),
        }),
        // `WEXITED` asks for endings only; anything else is not one.
        _ => None,
    }
}

/// A signal's conventional name, which is what ACP's `signal` carries
/// (`SIGKILL`). The number, for one with no portable name.
#[cfg(unix)]
fn signal_name(signal: libc::c_int) -> String {
    let name = match signal {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGTRAP => "SIGTRAP",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGUSR1 => "SIGUSR1",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGUSR2 => "SIGUSR2",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGALRM => "SIGALRM",
        libc::SIGTERM => "SIGTERM",
        libc::SIGXCPU => "SIGXCPU",
        libc::SIGXFSZ => "SIGXFSZ",
        libc::SIGVTALRM => "SIGVTALRM",
        libc::SIGPROF => "SIGPROF",
        libc::SIGIO => "SIGIO",
        libc::SIGSYS => "SIGSYS",
        other => return other.to_string(),
    };
    name.to_string()
}

/// The first half of what portable-pty's kill does: hang up.
///
/// The caller holds the child's lock and has seen no exit recorded, so `pid`
/// is not reaped and still names this command.
#[cfg(unix)]
fn hang_up(pid: u32) {
    let Ok(target) = libc::pid_t::try_from(pid) else {
        return;
    };
    // SAFETY: a plain signal send to our own unreaped child.
    unsafe { libc::kill(target, libc::SIGHUP) };
}

/// The second half: give the command a moment to go, then kill it outright —
/// without reaping the child, and without blocking whoever asked for the kill.
///
/// portable-pty's grace loop polls with `try_wait`, which reaps the child the
/// moment it is gone, and a reaped child can no longer be asked how it ended:
/// `release_slave_after_exit` then read nothing, and the agent was told its
/// killed command had exited with code 1 (#31). Polled with `WNOWAIT` here, the
/// child stays for that wait to read and for the reader thread to reap.
///
/// Sleeps with no lock held. Each check takes the child's lock and looks for a
/// recorded exit first: the reader thread reaps only under that lock and
/// records the exit before letting go, so while it is held an exit not yet
/// recorded means `pid` is unreaped and cannot have been reused.
#[cfg(unix)]
fn escalate_kill(
    pid: u32,
    child: &Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    inner: &Inner,
) {
    let Ok(target) = libc::pid_t::try_from(pid) else {
        return;
    };
    let gone = || {
        inner
            .exit
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
            || has_exited(pid)
    };
    for _ in 0..4 {
        std::thread::sleep(std::time::Duration::from_millis(50));
        let _held = child
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if gone() {
            return;
        }
    }
    let _held = child
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if !gone() {
        // SAFETY: as in `hang_up`; the lock is held and no exit is recorded.
        unsafe { libc::kill(target, libc::SIGKILL) };
    }
}

/// Whether `pid` has ended, asked without reaping it.
#[cfg(unix)]
fn has_exited(pid: u32) -> bool {
    // SAFETY: as in `release_slave_after_exit`.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let rc = unsafe {
        libc::waitid(
            libc::P_PID,
            pid,
            &mut info,
            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
        )
    };
    if rc == 0 {
        // `WNOHANG` with nothing to report succeeds and leaves `si_pid` zero.
        // SAFETY: `waitid` succeeded.
        return unsafe { info.si_pid() } != 0;
    }
    // No child left to wait for is no child left to signal either.
    std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted
}

/// The exit as portable-pty reports it, for when the kernel's own account is
/// missing: always on Windows, where a process ends with a code and never a
/// signal, and on unix only if the child was reaped before it could be read.
/// portable-pty keeps a signal only as `strsignal`'s description, privately,
/// and reports it as exit code 1, so a signal cannot be told from here.
fn exit_from(status: Option<ExitStatus>) -> CommandExit {
    match status {
        Some(s) => {
            let code = s.exit_code();
            CommandExit {
                exit_code: Some(code),
                signal: None,
            }
        }
        // Reaping failed (already reaped, or the platform lost it). Reporting
        // "exited, code unknown" beats claiming success.
        None => CommandExit {
            exit_code: None,
            signal: None,
        },
    }
}

/// Terminals owned by one host, keyed by the id handed back to the agent.
///
/// Every terminal remembers the session that created it so teardown can kill
/// the orphans: ACP expects `terminal/release`, but an agent that crashes or a
/// session the user closes mid-build would otherwise leave the child process
/// running with nothing left to reap it.
#[derive(Default)]
pub struct CommandTerminals {
    inner: Mutex<HashMap<String, Entry>>,
}

struct Entry {
    terminal: Arc<CommandTerminal>,
    session_id: String,
}

impl CommandTerminals {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a terminal under `session_id`; returns its id.
    pub fn insert(&self, session_id: &str, terminal: CommandTerminal) -> String {
        let id = format!("term_{}", uuid::Uuid::new_v4());
        if let Ok(mut map) = self.inner.lock() {
            map.insert(
                id.clone(),
                Entry {
                    terminal: Arc::new(terminal),
                    session_id: session_id.to_string(),
                },
            );
        }
        id
    }

    #[must_use]
    pub fn get(&self, id: &str) -> Option<Arc<CommandTerminal>> {
        self.inner.lock().ok()?.get(id).map(|e| e.terminal.clone())
    }

    /// Drop a terminal, killing it if it is still running.
    ///
    /// ACP's `terminal/release` says the client may reclaim resources; a
    /// still-running child must be killed rather than orphaned, since after
    /// release nobody holds a handle to reap it.
    pub fn release(&self, id: &str) -> bool {
        let Ok(mut map) = self.inner.lock() else {
            return false;
        };
        match map.remove(id) {
            Some(entry) => {
                let _ = entry.terminal.kill();
                true
            }
            None => false,
        }
    }

    /// Release every terminal belonging to `session_id`. Called on session
    /// teardown so a closed tab cannot leave a build running forever.
    pub fn release_session(&self, session_id: &str) -> usize {
        let Ok(mut map) = self.inner.lock() else {
            return 0;
        };
        let doomed: Vec<String> = map
            .iter()
            .filter(|(_, e)| e.session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect();
        for id in &doomed {
            if let Some(entry) = map.remove(id) {
                let _ = entry.terminal.kill();
            }
        }
        doomed.len()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.inner.lock().map(|m| m.len()).unwrap_or(0)
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::Future;
    use std::task::Poll;

    fn run(command: &str, args: &[&str]) -> CommandTerminal {
        let args: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
        CommandTerminal::spawn(command, &args, &[], None, DEFAULT_OUTPUT_BYTE_LIMIT).expect("spawn")
    }

    #[tokio::test]
    async fn captures_output_and_a_zero_exit_code() {
        let term = run("/bin/echo", &["hello acp"]);
        let exit = term.wait_for_exit().await;
        assert_eq!(exit.exit_code, Some(0));
        let (output, truncated) = term.output();
        assert!(output.contains("hello acp"), "got {output:?}");
        assert!(!truncated);
    }

    #[tokio::test]
    async fn reports_a_nonzero_exit_code() {
        let term = run("/bin/sh", &["-c", "exit 3"]);
        assert_eq!(term.wait_for_exit().await.exit_code, Some(3));
    }

    /// A command that finishes before `wait_for_exit` is called must not hang —
    /// the notification has already fired by then, so the status has to be
    /// re-checked rather than waited on blindly.
    #[tokio::test]
    async fn waiting_on_an_already_finished_command_returns_immediately() {
        let term = run("/bin/echo", &["fast"]);
        let _ = term.wait_for_exit().await;
        let again =
            tokio::time::timeout(std::time::Duration::from_secs(5), term.wait_for_exit()).await;
        assert!(again.is_ok(), "second wait must not block");
    }

    #[tokio::test]
    async fn kill_terminates_a_long_running_command() {
        let term = run("/bin/sh", &["-c", "sleep 30"]);
        term.kill().expect("kill");
        let exit = tokio::time::timeout(std::time::Duration::from_secs(10), term.wait_for_exit())
            .await
            .expect("killed command must exit promptly");
        assert_ne!(exit.exit_code, Some(0), "a killed command did not succeed");
    }

    /// Park until `term` has printed `marker`.
    #[cfg(unix)]
    async fn printed(term: &CommandTerminal, marker: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let changed = term.output_changed();
                tokio::pin!(changed);
                std::future::poll_fn(|cx| Poll::Ready(changed.as_mut().poll(cx).is_ready())).await;
                if term.output().0.contains(marker) {
                    return;
                }
                changed.await;
            }
        })
        .await
        .unwrap_or_else(|_| panic!("the command never printed {marker:?}"));
    }

    /// #31. A command a signal ended has no exit code; it has the signal. The
    /// agent reads this back as how its command ended, and "exit 1" says the
    /// command ran and failed, which a command that was killed did not.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_killed_command_reports_the_signal_that_ended_it() {
        let term = run("/bin/sh", &["-c", "exec sleep 30"]);
        term.kill().expect("kill");
        let exit = tokio::time::timeout(std::time::Duration::from_secs(10), term.wait_for_exit())
            .await
            .expect("killed command must exit promptly");
        assert_eq!(
            exit,
            CommandExit {
                exit_code: None,
                signal: Some("SIGHUP".to_string()),
            }
        );
    }

    /// A signal nobody here sent is still the answer: the kernel says how the
    /// child ended, whoever ended it.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_ended_by_its_own_signal_reports_it() {
        let term = run("/bin/sh", &["-c", "kill -TERM $$"]);
        let exit = tokio::time::timeout(std::time::Duration::from_secs(10), term.wait_for_exit())
            .await
            .expect("the command must end");
        assert_eq!(
            exit,
            CommandExit {
                exit_code: None,
                signal: Some("SIGTERM".to_string()),
            }
        );
    }

    /// Kill hangs up first and gives the command a moment; one that ignores the
    /// hangup is then killed outright — and reported as killed by THAT signal.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_command_that_ignores_the_hangup_is_reported_killed() {
        let term = run("/bin/sh", &["-c", "trap '' HUP; echo ready; exec sleep 30"]);
        printed(&term, "ready").await;
        term.kill().expect("kill");
        let exit = tokio::time::timeout(std::time::Duration::from_secs(10), term.wait_for_exit())
            .await
            .expect("killed command must exit promptly");
        assert_eq!(
            exit,
            CommandExit {
                exit_code: None,
                signal: Some("SIGKILL".to_string()),
            }
        );
    }

    /// R4: kill is called with the AcpThread or registry lock held, inside the
    /// ACP dispatch drain. It must hang up and return, not sit out the grace
    /// period (it used to sleep up to 200 ms there per terminal).
    #[cfg(unix)]
    #[tokio::test]
    async fn kill_returns_without_waiting_out_the_grace_period() {
        let term = run("/bin/sh", &["-c", "trap '' HUP; echo ready; exec sleep 30"]);
        printed(&term, "ready").await;
        let started = std::time::Instant::now();
        term.kill().expect("kill");
        let took = started.elapsed();
        assert!(
            took < std::time::Duration::from_millis(40),
            "kill blocked its caller for {took:?}"
        );
        let exit = tokio::time::timeout(std::time::Duration::from_secs(10), term.wait_for_exit())
            .await
            .expect("the escalation must still kill it");
        assert_eq!(exit.signal.as_deref(), Some("SIGKILL"));
    }

    /// And a command that exits on its own still has its code, and no signal.
    #[tokio::test]
    async fn an_exit_code_is_not_mistaken_for_a_signal() {
        let term = run("/bin/sh", &["-c", "exit 1"]);
        assert_eq!(
            term.wait_for_exit().await,
            CommandExit {
                exit_code: Some(1),
                signal: None,
            }
        );
    }

    #[tokio::test]
    async fn killing_an_already_exited_command_is_not_an_error() {
        let term = run("/bin/echo", &["done"]);
        let _ = term.wait_for_exit().await;
        assert!(
            term.kill().is_ok(),
            "kill races the process finishing on its own; that is normal"
        );
    }

    #[tokio::test]
    async fn env_and_cwd_reach_the_child() {
        let dir = std::env::temp_dir();
        let term = CommandTerminal::spawn(
            "/bin/sh",
            &["-c".into(), "printf %s \"$ATLAS_TEST_VAR\"; pwd".into()],
            &[("ATLAS_TEST_VAR".to_string(), "marker".to_string())],
            Some(&dir),
            DEFAULT_OUTPUT_BYTE_LIMIT,
        )
        .expect("spawn");
        term.wait_for_exit().await;
        let (output, _) = term.output();
        assert!(output.contains("marker"), "env not passed: {output:?}");
    }

    #[test]
    fn the_buffer_keeps_the_most_recent_bytes_not_the_first() {
        let mut buf = OutputBuffer::new(5);
        buf.push(b"abcdefghij");
        assert_eq!(buf.text(), "fghij", "ACP truncates from the beginning");
        assert!(buf.truncated);
    }

    #[test]
    fn an_under_limit_buffer_is_not_marked_truncated() {
        let mut buf = OutputBuffer::new(64);
        buf.push(b"short");
        assert_eq!(buf.text(), "short");
        assert!(!buf.truncated);
    }

    /// The spec requires truncation to land on a character boundary. Cutting
    /// mid-character would put a replacement char at the head of every
    /// subsequent read.
    #[test]
    fn truncation_never_splits_a_multibyte_character() {
        // 'é' is 2 bytes, '→' is 3, '🙂' is 4 — a limit that lands inside each.
        for limit in 1..=12 {
            let mut buf = OutputBuffer::new(limit as u64);
            buf.push("aé→🙂bc".as_bytes());
            let text = buf.text();
            assert!(
                !text.contains('\u{FFFD}'),
                "limit {limit} split a character: {text:?}"
            );
        }
    }

    /// The buffer decodes on write so a reader can borrow the window instead of
    /// rebuilding it (ATL-219). That only holds up if a character split across
    /// two reads still arrives whole — a PTY read boundary lands wherever the
    /// kernel put it, not where a character ends.
    #[test]
    fn a_character_split_across_two_pushes_is_not_mangled() {
        let smiley = "🙂".as_bytes();
        for split in 1..smiley.len() {
            let mut buf = OutputBuffer::new(64);
            buf.push(&smiley[..split]);
            assert!(
                !buf.text().contains('\u{FFFD}'),
                "split at {split} decoded a partial character early: {:?}",
                buf.text()
            );
            buf.push(&smiley[split..]);
            assert_eq!(buf.text(), "🙂", "split at {split} lost the character");
        }
    }

    /// The hold-back is bounded: bytes that cannot be the start of any
    /// character are decoded now, so a corrupt stream cannot wedge the buffer
    /// into never showing anything again.
    #[test]
    fn malformed_trailing_bytes_do_not_wedge_the_buffer() {
        let mut buf = OutputBuffer::new(64);
        buf.push(&[b'o', b'k', 0xff]);
        assert!(
            buf.text().starts_with("ok"),
            "a stray byte held back everything after it: {:?}",
            buf.text()
        );
        assert_eq!(buf.text().chars().count(), 3);
    }

    /// The window is still exactly the last `limit` bytes once the buffer has
    /// been truncating for a long time — the deferred compaction must not let
    /// the dead prefix leak into a read, or shorten what a read returns.
    #[test]
    fn a_long_running_buffer_still_holds_exactly_the_last_window() {
        let limit = 64;
        let mut buf = OutputBuffer::new(limit as u64);
        let mut all = String::new();
        // Far past the point where the dead prefix is compacted away.
        for i in 0..2_000 {
            let chunk = format!("{i:04}");
            buf.push(chunk.as_bytes());
            all.push_str(&chunk);
        }
        assert_eq!(buf.len(), limit, "the window stays at the limit");
        assert_eq!(
            buf.text(),
            &all[all.len() - limit..],
            "and is the tail of everything written",
        );
        assert!(buf.truncated());
    }

    #[test]
    fn incremental_pushes_truncate_the_same_as_one_big_push() {
        let mut incremental = OutputBuffer::new(4);
        for byte in b"abcdefgh" {
            incremental.push(&[*byte]);
        }
        let mut bulk = OutputBuffer::new(4);
        bulk.push(b"abcdefgh");
        assert_eq!(incremental.text(), bulk.text());
        assert_eq!(incremental.text(), "efgh");
    }

    #[tokio::test]
    async fn releasing_a_session_kills_its_terminals_and_leaves_others_alone() {
        let terminals = CommandTerminals::new();
        let mine = terminals.insert("session-a", run("/bin/sh", &["-c", "sleep 30"]));
        let theirs = terminals.insert("session-b", run("/bin/sh", &["-c", "sleep 30"]));

        assert_eq!(terminals.release_session("session-a"), 1);
        assert!(terminals.get(&mine).is_none(), "session-a's is gone");
        let survivor = terminals.get(&theirs).expect("session-b's survives");

        // Clean up the survivor so the test leaves no stray process.
        assert!(terminals.release(&theirs));
        let _ = survivor.wait_for_exit().await;
    }

    #[test]
    fn releasing_an_unknown_terminal_reports_false_rather_than_panicking() {
        let terminals = CommandTerminals::new();
        assert!(!terminals.release("term_does_not_exist"));
    }

    /// The signal a watcher follows to stream a running command's output into
    /// the UI. Without it the output only moves when something unrelated
    /// happens to re-read the buffer.
    #[tokio::test]
    async fn output_changed_wakes_while_the_command_is_still_running() {
        // Prints, then stays alive: a watcher must be woken by the print, not
        // left parked until the process ends.
        let term = run("/bin/sh", &["-c", "echo first; sleep 30"]);
        let woke = tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                // Register, then read, then park — the order a real watcher
                // (`follow_terminal_output`) uses. Awaiting first and reading
                // after lost the `echo` whenever it landed before the first
                // poll: `notify_waiters` keeps no permit, and the command then
                // runs quiet for 30s.
                let changed = term.output_changed();
                tokio::pin!(changed);
                let exited =
                    std::future::poll_fn(|cx| Poll::Ready(changed.as_mut().poll(cx).is_ready()))
                        .await;
                if term.output().0.contains("first") {
                    return;
                }
                assert!(!exited, "the command exited before printing");
                changed.await;
            }
        })
        .await;
        let _ = term.kill();
        assert!(woke.is_ok(), "output_changed never woke for a live command");
    }

    /// A watcher loop is written as `loop { output_changed().await; ...; if
    /// exited { break } }`. If the await parked forever once the command was
    /// gone, that loop would leak a task per terminal for the life of the app.
    #[tokio::test]
    async fn output_changed_returns_at_once_once_the_command_has_exited() {
        let term = run("/bin/echo", &["done"]);
        let _ = term.wait_for_exit().await;
        let returned =
            tokio::time::timeout(std::time::Duration::from_secs(5), term.output_changed()).await;
        assert!(
            returned.is_ok(),
            "a finished command must not park its watcher"
        );
    }
}
