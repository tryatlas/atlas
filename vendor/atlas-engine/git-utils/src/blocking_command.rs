// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
use std::io;
use std::io::Read;
use std::io::Seek;
use std::process::Child;
use std::process::Command;
use std::process::Output;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;

struct ProcessTree {
    child: Child,
    #[cfg(windows)]
    _job: atlas_engine_utils_pty::JobObject,
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(unix)]
        let _ = atlas_engine_utils_pty::process_group::kill_process_group(self.child.id());
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Run Git from a blocking thread, bounding both its execution and output capture.
///
/// Files avoid pipe backpressure and do not wait for EOF from a transport helper
/// that inherited Git's output handles. The owned process group/job cleans up
/// helpers on every exit path, including a parent that exits before its helpers.
pub fn run_git_command_blocking(
    command: &mut Command,
    context: &str,
    timeout: Duration,
) -> Result<Output, String> {
    run(command, timeout).map_err(|error| format!("{context}: {error}"))
}

fn run(command: &mut Command, timeout: Duration) -> io::Result<Output> {
    let mut stdout = tempfile::tempfile()?;
    let mut stderr = tempfile::tempfile()?;
    command
        .stdin(Stdio::null())
        .stdout(stdout.try_clone()?)
        .stderr(stderr.try_clone()?);
    crate::no_console_window(command);
    atlas_engine_protocol::shell_environment::scrub_non_inheritable_env_vars(command);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    let job = {
        use std::os::windows::process::CommandExt;
        let job = atlas_engine_utils_pty::JobObject::create_without_breakaway()?;
        command.creation_flags(crate::CREATE_NO_WINDOW | 0x0000_0004); // CREATE_SUSPENDED
        job
    };
    let mut process = ProcessTree {
        child: command.spawn()?,
        #[cfg(windows)]
        _job: job,
    };
    #[cfg(windows)]
    process
        ._job
        .assign_and_resume_process_strict(process.child.id())?;
    let started = Instant::now();
    let status = loop {
        if let Some(status) = process.child.try_wait()? {
            break status;
        }
        if started.elapsed() >= timeout {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                format!("timed out after {}s", timeout.as_secs_f64()),
            ));
        }
        std::thread::sleep(
            Duration::from_millis(10).min(timeout.saturating_sub(started.elapsed())),
        );
    };
    drop(process);
    stdout.rewind()?;
    stderr.rewind()?;
    let mut output = Output {
        status,
        stdout: Vec::new(),
        stderr: Vec::new(),
    };
    stdout.read_to_end(&mut output.stdout)?;
    stderr.read_to_end(&mut output.stderr)?;
    Ok(output)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn transport_helpers_cannot_extend_the_timeout_or_hold_capture_open() {
        for script in ["sleep 5 & wait", "sleep 5 & printf done; exit 0"] {
            let started = Instant::now();
            let result = run_git_command_blocking(
                Command::new("/bin/sh").args(["-c", script]),
                "git fixture",
                Duration::from_millis(100),
            );
            assert!(started.elapsed() < Duration::from_secs(2), "{script}");
            if script.ends_with("wait") {
                assert!(result.unwrap_err().contains("timed out"));
            } else {
                assert_eq!(result.unwrap().stdout, b"done");
            }
        }
    }

    #[test]
    fn output_larger_than_a_pipe_buffer_does_not_deadlock() {
        let result = run_git_command_blocking(
            Command::new("/bin/sh").args(["-c", "head -c 1048576 /dev/zero"]),
            "git fixture",
            Duration::from_secs(3),
        )
        .unwrap();
        assert!(result.status.success());
        assert_eq!(result.stdout.len(), 1024 * 1024);
    }
}
