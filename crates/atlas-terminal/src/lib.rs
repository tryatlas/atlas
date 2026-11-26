pub mod command;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;
use uuid::Uuid;

pub struct TerminalSession {
    /// Kept alive (rather than dropped after taking the writer/reader) so
    /// `resize` can drive `MasterPty::resize` — the previous build dropped
    /// the pair and resize was a silent no-op, leaving columns clipped after
    /// a pane resize.
    master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    /// Input queue for the session's writer thread. A write to the PTY master
    /// BLOCKS once the slave's input queue is full (a raw-mode app that stops
    /// reading fills it after ~1 KiB on macOS), so writes never happen on the
    /// caller's thread: one thread per session owns the writer and drains this
    /// queue in order. A stuck app then parks only that thread — never a tokio
    /// worker, and never while the manager lock is held, which would wedge
    /// every other terminal's resize and close behind it.
    input: std::sync::mpsc::Sender<Vec<u8>>,
    /// PID of the spawned login shell. Used by `cwd` to resolve relative file
    /// paths clicked in the terminal against the shell's live directory.
    pid: Option<u32>,
    initial_cwd: String,
    killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    /// Last size pushed to the PTY, so a resize storm (N terminals × 60 fps
    /// during a drag) costs one ioctl per CHANGE, not per call.
    size: Mutex<(u16, u16)>,
    _reader_handle: std::thread::JoinHandle<()>,
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        // Closing a tab ends everything running in it. Signalling the shell
        // alone is not enough: portable-pty's killer sends SIGHUP to the shell
        // pid only, and a foreground job that ignores the hangup (or a shell
        // that does not forward it) keeps running, holds the slave open, and
        // so also keeps the reader thread parked in `read` forever.
        #[cfg(unix)]
        {
            let foreground = self
                .master
                .lock()
                .ok()
                .and_then(|slot| slot.as_ref().and_then(|m| m.process_group_leader()));
            // The shell is a session and process-group leader (portable-pty
            // runs `setsid`), so its pid is also its group's id.
            let shell = self.pid.and_then(|pid| libc::pid_t::try_from(pid).ok());
            let groups: Vec<libc::pid_t> = [foreground, shell]
                .into_iter()
                .flatten()
                .filter(|pgid| *pgid > 1)
                .fold(Vec::new(), |mut acc, pgid| {
                    if !acc.contains(&pgid) {
                        acc.push(pgid);
                    }
                    acc
                });
            for pgid in &groups {
                // SAFETY: plain signal sends to process groups this session
                // started; a group that is already gone yields ESRCH.
                unsafe { libc::killpg(*pgid, libc::SIGHUP) };
            }
            if !groups.is_empty() {
                // Whatever ignored the hangup is killed outright after a short
                // grace, on its own thread so close never blocks on it.
                std::thread::spawn(move || {
                    std::thread::sleep(KILL_GRACE);
                    for pgid in groups {
                        // SAFETY: as above.
                        unsafe { libc::killpg(pgid, libc::SIGKILL) };
                    }
                });
            }
        }
        let _ = self.killer.kill();
    }
}

/// How long a closed terminal's processes get to exit on SIGHUP before they
/// are killed outright.
#[cfg(unix)]
const KILL_GRACE: std::time::Duration = std::time::Duration::from_millis(1500);

/// Whether `next` differs from `last` — the resize dedup predicate.
pub(crate) fn needs_resize(last: (u16, u16), next: (u16, u16)) -> bool {
    last != next
}

pub struct TerminalManager {
    sessions: HashMap<String, TerminalSession>,
    zsh_integration: Option<ZshIntegration>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TerminalOutput {
    pub id: String,
    pub data: Vec<u8>,
}

impl Default for TerminalManager {
    fn default() -> Self {
        Self::new()
    }
}

impl TerminalManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
            zsh_integration: None,
        }
    }

    pub fn create_session(
        &mut self,
        cols: u16,
        rows: u16,
        cwd: Option<&str>,
        // BOUNDED. When the consumer falls behind, `blocking_send` parks this
        // session's reader thread, the kernel tty queue fills, and the child's
        // write() stalls — real flow control instead of unbounded buffering
        // (the same backpressure shape Ghostty's fixed ring of read buffers
        // produces). Nothing is ever dropped.
        sender: mpsc::Sender<TerminalOutput>,
    ) -> anyhow::Result<String> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let shell = detect_shell();
        let mut cmd = CommandBuilder::new(&shell);
        cmd.env_clear();
        for (key, value) in atlas_process::host_environment() {
            cmd.env(key, value);
        }
        // Login shell — sources the user's profile so PATH etc. are correct.
        // PowerShell has no `-l`: it loads the user's profile by default.
        if !cfg!(windows) {
            cmd.arg("-l");
        }
        let initial_cwd = cwd
            .map(str::to_owned)
            .or_else(|| {
                std::env::current_dir()
                    .ok()
                    .map(|path| path.to_string_lossy().into_owned())
            })
            .unwrap_or_default();
        if !initial_cwd.is_empty() {
            cmd.cwd(&initial_cwd);
        }
        #[cfg(windows)]
        if shell.to_ascii_lowercase().ends_with("powershell.exe")
            || shell.to_ascii_lowercase().ends_with("pwsh.exe")
        {
            cmd.arg("-NoExit");
            cmd.arg("-Command");
            cmd.arg("$global:__atlas_original_prompt = (Get-Command prompt).ScriptBlock; function global:prompt { [Console]::Write([char]27 + ']7;' + ([uri]$ExecutionContext.SessionState.Path.CurrentFileSystemLocation.Path).AbsoluteUri + [char]7); & $global:__atlas_original_prompt }");
        }

        // Set TERM for proper terminal behavior.
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        // Ensure a UTF-8 locale even if the user's profile doesn't set one,
        // so box-drawing / multi-byte glyphs render correctly.
        if std::env::var_os("LANG").is_none() {
            cmd.env("LANG", "en_US.UTF-8");
        }

        // Shell integration: for zsh (the macOS default) point ZDOTDIR at a
        // generated dir whose rc files chain to the user's config and add
        // OSC 133 / OSC 7 / command hooks. That lets the frontend tell when
        // a command runs and how it ended (busy state, notifications) + cwd.
        // Non-zsh shells run plain (no busy state or command notifications).
        if shell.ends_with("zsh") {
            if self.zsh_integration.is_none() {
                self.zsh_integration = ZshIntegration::create().ok();
            }
            if let Some(integration) = &self.zsh_integration {
                let dir = &integration.dir;
                let user_zdotdir = std::env::var("ZDOTDIR")
                    .ok()
                    .filter(|s| !s.is_empty())
                    .or_else(|| std::env::var("HOME").ok())
                    .unwrap_or_default();
                cmd.env("ATLAS_USER_ZDOTDIR", user_zdotdir);
                cmd.env("ZDOTDIR", dir.to_string_lossy().to_string());
            }
        }

        let mut child = pair.slave.spawn_command(cmd)?;
        let pid = child.process_id();
        let killer = child.clone_killer();
        drop(pair.slave); // drop slave so reads on master detect EOF

        let mut writer = pair.master.take_writer()?;
        let mut reader = pair.master.try_clone_reader()?;
        // Retain the master so resize works for the session's lifetime.
        let master = Arc::new(Mutex::new(Some(pair.master)));
        // ConPTY keeps its output pipe open while the pseudoconsole lives,
        // even after the shell has exited. Wait independently of the reader
        // and close it from this worker, while the reader drains final output.
        #[cfg(windows)]
        let exit_master = Arc::downgrade(&master);
        std::thread::spawn(move || {
            let _ = child.wait();
            #[cfg(windows)]
            if let Some(master) = exit_master.upgrade() {
                let owned = master.lock().ok().and_then(|mut slot| slot.take());
                drop(owned);
            }
        });

        let id = Uuid::new_v4().to_string();
        let session_id = id.clone();

        let reader_handle = std::thread::spawn(move || {
            // 64 KiB reads — fewer syscalls / channel sends on high-throughput
            // output (builds, `cat` of large files). The buffer is allocated
            // per read and MOVED into the message: the previous reuse-then-
            // `to_vec()` shape copied every byte once here before the batcher
            // copied it again. One allocation per read is the cheaper trade.
            loop {
                let mut buf = vec![0u8; 65536];
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        buf.truncate(n);
                        let output = TerminalOutput {
                            id: session_id.clone(),
                            data: buf,
                        };
                        if sender.blocking_send(output).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        // Ends when the session drops its sender (close), or when a write
        // fails because the shell is gone.
        let (input, input_rx) = std::sync::mpsc::channel::<Vec<u8>>();
        std::thread::spawn(move || {
            for data in input_rx {
                if writer.write_all(&data).is_err() || writer.flush().is_err() {
                    break;
                }
            }
        });

        self.sessions.insert(
            id.clone(),
            TerminalSession {
                master,
                input,
                pid,
                initial_cwd,
                killer,
                size: Mutex::new((cols, rows)),
                _reader_handle: reader_handle,
            },
        );

        Ok(id)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> anyhow::Result<()> {
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("Terminal session not found: {id}"))?;
        // Queued, not written: see `TerminalSession::input`. Order is kept —
        // one queue, one writer thread.
        session
            .input
            .send(data.to_vec())
            .map_err(|_| anyhow::anyhow!("Terminal session input closed: {id}"))?;
        Ok(())
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> anyhow::Result<()> {
        // A 2×1 is what a fit against a hidden 0×0 box produces; it is never a
        // size anyone wants their shell wrapped to.
        if cols < 2 || rows < 1 {
            anyhow::bail!("invalid terminal size {cols}x{rows}");
        }
        let session = self
            .sessions
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("Terminal session not found: {id}"))?;
        {
            let mut last = session
                .size
                .lock()
                .map_err(|_| anyhow::anyhow!("terminal size mutex poisoned"))?;
            if !needs_resize(*last, (cols, rows)) {
                return Ok(());
            }
            *last = (cols, rows);
        }
        let master = session
            .master
            .lock()
            .map_err(|_| anyhow::anyhow!("terminal master mutex poisoned"))?;
        master
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Terminal session exited: {id}"))?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })?;
        Ok(())
    }

    pub fn close(&mut self, id: &str) {
        drop(self.take_session(id));
    }

    /// Remove ownership under the manager lock, then drop the returned session
    /// on a blocking worker. Closing ConPTY can wait for its reader to drain.
    pub fn take_session(&mut self, id: &str) -> Option<TerminalSession> {
        self.sessions.remove(id)
    }

    /// Starting directory for platforms that cannot query another process's
    /// cwd. Shell OSC 7 reports take precedence when the UI has one.
    pub fn cwd_hint(&self, id: &str) -> Option<String> {
        let cwd = &self.sessions.get(id)?.initial_cwd;
        (!cwd.is_empty()).then(|| cwd.clone())
    }

    /// PID of the session's login shell (for `cwd_of_pid`).
    pub fn pid(&self, id: &str) -> Option<u32> {
        self.sessions.get(id)?.pid
    }
}

/// The live working directory of a shell pid, used to resolve relative file
/// paths clicked in the terminal. Linux reads the `/proc/<pid>/cwd` symlink;
/// macOS shells out to `lsof` (no `/proc`). BLOCKING (lsof) — call off-thread.
pub fn cwd_of_pid(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{pid}/cwd"))
            .ok()
            .map(|p| p.to_string_lossy().into_owned())
    }
    #[cfg(target_os = "macos")]
    {
        // `lsof -a -d cwd -p <pid> -Fn` prints `n<path>` for the cwd fd.
        let out = std::process::Command::new("lsof")
            .args(["-a", "-d", "cwd", "-p", &pid.to_string(), "-Fn"])
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout);
        s.lines()
            .find_map(|l| l.strip_prefix('n').map(std::string::ToString::to_string))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        None
    }
}

fn detect_shell() -> String {
    // No $SHELL on Windows (a Git Bash parent can leak a POSIX path into it).
    // Windows PowerShell ships with every supported release.
    if cfg!(windows) {
        return "powershell.exe".to_string();
    }
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else if std::path::Path::new("/bin/bash").exists() {
                "/bin/bash".to_string()
            } else {
                "/bin/sh".to_string()
            }
        })
}

// ── zsh shell integration ──────────────────────────────────────────────────
//
// Each rc file chains to the user's real config (under ATLAS_USER_ZDOTDIR),
// preserving ZDOTDIR across the source so plugins/configs that read it still
// work. `.zshrc` additionally installs precmd/preexec hooks that emit:
//   OSC 133 ; D ; <exit>   previous command ended (exit code)
//   OSC 133 ; A            new prompt
//   OSC 7   ; file://…      cwd
//   OSC 133 ; C            command output begins
//   OSC 6973 ; C ; <cmd>   the command text (Atlas-private OSC)

const ZSHENV: &str = r#"ATLAS_SELF="$ZDOTDIR"
ZDOTDIR="$ATLAS_USER_ZDOTDIR"
[ -f "$ATLAS_USER_ZDOTDIR/.zshenv" ] && source "$ATLAS_USER_ZDOTDIR/.zshenv"
ZDOTDIR="$ATLAS_SELF"
"#;

const ZPROFILE: &str = r#"ATLAS_SELF="$ZDOTDIR"
ZDOTDIR="$ATLAS_USER_ZDOTDIR"
[ -f "$ATLAS_USER_ZDOTDIR/.zprofile" ] && source "$ATLAS_USER_ZDOTDIR/.zprofile"
ZDOTDIR="$ATLAS_SELF"
"#;

const ZLOGIN: &str = r#"ATLAS_SELF="$ZDOTDIR"
ZDOTDIR="$ATLAS_USER_ZDOTDIR"
[ -f "$ATLAS_USER_ZDOTDIR/.zlogin" ] && source "$ATLAS_USER_ZDOTDIR/.zlogin"
ZDOTDIR="$ATLAS_SELF"
"#;

const ZSHRC: &str = r#"ATLAS_SELF="$ZDOTDIR"
ZDOTDIR="$ATLAS_USER_ZDOTDIR"
[ -f "$ATLAS_USER_ZDOTDIR/.zshrc" ] && source "$ATLAS_USER_ZDOTDIR/.zshrc"

# Atlas shell integration (OSC 133 prompt markers + cwd + command text).
autoload -Uz add-zsh-hook 2>/dev/null
_atlas_precmd() {
  local _atlas_exit=$?
  printf '\033]133;D;%s\007' "$_atlas_exit"
  printf '\033]133;A\007'
  printf '\033]7;file://%s%s\007' "${HOST}" "${PWD}"
}
_atlas_preexec() {
  # Emit the command text (6973) BEFORE the output-start marker (133;C) so the
  # parser has the command in hand when it opens the block — otherwise the very
  # first block opens with an empty header (off-by-one vs the previous command).
  printf '\033]6973;C;%s\007' "$1"
  printf '\033]133;C\007'
}
add-zsh-hook precmd _atlas_precmd 2>/dev/null
add-zsh-hook preexec _atlas_preexec 2>/dev/null

# Hand the interactive session the user's ZDOTDIR.
ZDOTDIR="$ATLAS_USER_ZDOTDIR"
"#;

/// A fresh, private startup directory owned for the manager's lifetime. An
/// existing directory (including the old predictable name) is never reused.
struct ZshIntegration {
    dir: std::path::PathBuf,
}

impl ZshIntegration {
    fn create() -> std::io::Result<Self> {
        let dir = std::env::temp_dir().join(format!("atlas-zsh-{}", Uuid::new_v4()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
        }
        #[cfg(not(unix))]
        std::fs::create_dir(&dir)?;
        let owned = Self { dir };
        for (name, body) in [
            (".zshenv", ZSHENV),
            (".zprofile", ZPROFILE),
            (".zlogin", ZLOGIN),
            (".zshrc", ZSHRC),
        ] {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(owned.dir.join(name))?;
            file.write_all(body.as_bytes())?;
        }
        Ok(owned)
    }
}

impl Drop for ZshIntegration {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(test)]
mod resize_tests {
    use super::needs_resize;

    #[test]
    fn shell_integration_is_private_unique_and_removed_with_owner() {
        let first = super::ZshIntegration::create().unwrap();
        let second = super::ZshIntegration::create().unwrap();
        assert_ne!(first.dir, second.dir);
        assert_eq!(
            std::fs::read_to_string(first.dir.join(".zshrc")).unwrap(),
            super::ZSHRC
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&first.dir).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        let path = first.dir.clone();
        drop(first);
        assert!(!path.exists());
        assert!(second.dir.exists());
    }

    #[test]
    fn resize_dedups() {
        assert!(!needs_resize((120, 40), (120, 40)));
        assert!(needs_resize((120, 40), (121, 40)));
        assert!(needs_resize((120, 40), (120, 39)));
    }
}

#[cfg(all(test, unix))]
mod close_tests {
    use super::TerminalManager;
    use std::time::{Duration, Instant};

    fn alive(pid: libc::pid_t) -> bool {
        // SAFETY: signal 0 only probes for existence.
        if unsafe { libc::kill(pid, 0) } != 0 {
            return false;
        }
        // A zombie has ended; it is only waiting for its parent to reap it.
        #[cfg(target_os = "linux")]
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            if let Some(state) = stat
                .rsplit(')')
                .next()
                .and_then(|s| s.split_whitespace().next())
            {
                return state != "Z";
            }
        }
        true
    }

    /// R1: closing a terminal tab must end what runs in it, including a
    /// foreground job that ignores the hangup (a dev server keeps its port).
    #[tokio::test(flavor = "multi_thread")]
    async fn closing_a_session_kills_a_job_that_ignores_the_hangup() {
        let dir = std::env::temp_dir().join(format!("atlas-term-close-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let pid_file = dir.join("pid");
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        tokio::spawn(async move { while rx.recv().await.is_some() {} });
        let mut manager = TerminalManager::new();
        let id = manager
            .create_session(80, 24, Some(dir.to_str().unwrap()), tx)
            .expect("spawn shell");
        let line = format!(
            "/bin/sh -c 'trap \"\" HUP; echo $$ > {}; exec sleep 300'\n",
            pid_file.display()
        );
        manager.write(&id, line.as_bytes()).unwrap();

        let deadline = Instant::now() + Duration::from_secs(20);
        let pid: libc::pid_t = loop {
            if let Some(pid) = std::fs::read_to_string(&pid_file)
                .ok()
                .and_then(|s| s.trim().parse().ok())
            {
                break pid;
            }
            assert!(Instant::now() < deadline, "the job never started");
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        assert!(alive(pid));

        manager.close(&id);

        let deadline = Instant::now() + Duration::from_secs(10);
        while alive(pid) {
            assert!(
                Instant::now() < deadline,
                "pid {pid} still running after its terminal closed"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
