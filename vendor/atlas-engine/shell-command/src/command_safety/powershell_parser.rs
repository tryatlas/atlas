// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::io::BufRead;
use std::io::BufReader;
use std::io::ErrorKind;
use std::io::Write;
use std::process::Child;
use std::process::ChildStdin;
use std::process::ChildStdout;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::sync::mpsc;
use std::time::{Duration, Instant};

const POWERSHELL_PARSER_SCRIPT: &str = include_str!("powershell_parser.ps1");

/// Cache one worker per executable. Each owns its parser's blocking pipes, so
/// a stalled executable cannot block another parser or hold the global cache.
/// Call this synchronous API from a blocking thread.
pub(super) fn parse_with_powershell_ast(executable: &str, script: &str) -> PowershellParseOutcome {
    static WORKERS: LazyLock<Mutex<HashMap<String, Arc<ParserWorker>>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));
    let worker = {
        let mut workers = WORKERS.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(worker) = workers.get(executable) {
            Arc::clone(worker)
        } else {
            let Ok(worker) = ParserWorker::spawn(executable.to_string()) else {
                return PowershellParseOutcome::Failed;
            };
            workers.insert(executable.to_string(), Arc::clone(&worker));
            worker
        }
    };
    worker.parse(script, Duration::from_secs(5))
}

struct ParseRequest {
    script: String,
    deadline: Instant,
    reply: mpsc::SyncSender<PowershellParseOutcome>,
}

struct ParserWorker {
    requests: mpsc::SyncSender<ParseRequest>,
    current_child: Arc<Mutex<Option<Arc<Mutex<Child>>>>>,
}

impl ParserWorker {
    fn spawn(executable: String) -> std::io::Result<Arc<Self>> {
        let (requests, receiver) = mpsc::sync_channel::<ParseRequest>(1);
        let current_child = Arc::new(Mutex::new(None));
        let child_for_worker = Arc::clone(&current_child);
        std::thread::Builder::new()
            .name("powershell-safety-parser".to_string())
            .spawn(move || {
                let mut parser: Option<PowershellParserProcess> = None;
                for request in receiver {
                    let mut outcome = PowershellParseOutcome::Failed;
                    for _ in 0..=1 {
                        if Instant::now() >= request.deadline {
                            break;
                        }
                        if parser.is_none() {
                            let Ok(process) = PowershellParserProcess::spawn(&executable) else {
                                break;
                            };
                            *child_for_worker
                                .lock()
                                .unwrap_or_else(PoisonError::into_inner) =
                                Some(Arc::clone(&process.child));
                            parser = Some(process);
                        }
                        if Instant::now() >= request.deadline {
                            parser.take();
                            *child_for_worker
                                .lock()
                                .unwrap_or_else(PoisonError::into_inner) = None;
                            break;
                        }
                        match parser
                            .as_mut()
                            .expect("parser was created")
                            .parse(&request.script)
                        {
                            Ok(parsed) => {
                                outcome = parsed;
                                break;
                            }
                            Err(_) => {
                                parser.take();
                                *child_for_worker
                                    .lock()
                                    .unwrap_or_else(PoisonError::into_inner) = None;
                            }
                        }
                    }
                    let _ = request.reply.send(outcome);
                }
            })?;
        Ok(Arc::new(Self {
            requests,
            current_child,
        }))
    }

    fn parse(&self, script: &str, timeout: Duration) -> PowershellParseOutcome {
        let (reply, response) = mpsc::sync_channel(1);
        let request = ParseRequest {
            script: script.to_string(),
            deadline: Instant::now() + timeout,
            reply,
        };
        if self.requests.try_send(request).is_err() {
            return PowershellParseOutcome::Failed;
        }
        match response.recv_timeout(timeout) {
            Ok(outcome) => outcome,
            Err(_) => {
                let child = self
                    .current_child
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .take();
                if let Some(child) = child {
                    kill_child(&mut child.lock().unwrap_or_else(PoisonError::into_inner));
                }
                PowershellParseOutcome::Failed
            }
        }
    }
}

pub(crate) fn try_parse_powershell_ast_commands(
    executable: &str,
    script: &str,
) -> Option<Vec<Vec<String>>> {
    match parse_with_powershell_ast(executable, script) {
        PowershellParseOutcome::Commands(commands) => Some(commands),
        PowershellParseOutcome::Unsupported | PowershellParseOutcome::Failed => None,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum PowershellParseOutcome {
    Commands(Vec<Vec<String>>),
    Unsupported,
    Failed,
}

fn encode_powershell_base64(script: &str) -> String {
    let mut utf16 = Vec::with_capacity(script.len() * 2);
    for unit in script.encode_utf16() {
        utf16.extend_from_slice(&unit.to_le_bytes());
    }
    BASE64_STANDARD.encode(utf16)
}

fn encoded_parser_script() -> &'static str {
    static ENCODED: LazyLock<String> =
        LazyLock::new(|| encode_powershell_base64(POWERSHELL_PARSER_SCRIPT));
    &ENCODED
}

struct PowershellParserProcess {
    child: Arc<Mutex<Child>>,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    // Request ids are monotonic within one child process so the caller can detect protocol
    // desynchronization if stdout is contaminated or the child is unexpectedly replaced.
    next_request_id: u64,
}

impl PowershellParserProcess {
    fn spawn(executable: &str) -> std::io::Result<Self> {
        let mut command = Command::new(executable);
        command
            .env_clear()
            .envs(atlas_engine_protocol::shell_environment::host_environment())
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-EncodedCommand",
                encoded_parser_script(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        atlas_engine_protocol::shell_environment::scrub_non_inheritable_env_vars(&mut command);
        // Atlas: CREATE_NO_WINDOW — the parser is a long-lived piped child of
        // the GUI host and must not open a console window.
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            command.creation_flags(0x0800_0000);
        }
        let mut child = command.spawn()?;
        let stdin = match take_child_stdin(&mut child) {
            Ok(stdin) => stdin,
            Err(error) => {
                kill_child(&mut child);
                return Err(error);
            }
        };
        let stdout = match take_child_stdout(&mut child) {
            Ok(stdout) => stdout,
            Err(error) => {
                kill_child(&mut child);
                return Err(error);
            }
        };
        Ok(Self {
            child: Arc::new(Mutex::new(child)),
            stdin,
            stdout,
            next_request_id: 0,
        })
    }

    fn parse(&mut self, script: &str) -> std::io::Result<PowershellParseOutcome> {
        let request = PowershellParserRequest {
            id: self.next_request_id,
            payload: encode_powershell_base64(script),
        };
        self.next_request_id = self.next_request_id.wrapping_add(1);
        let mut request_json = serialize_request(&request)?;
        request_json.push('\n');
        self.stdin.write_all(request_json.as_bytes())?;
        self.stdin.flush()?;

        let mut response_line = String::new();
        if self.stdout.read_line(&mut response_line)? == 0 {
            return Err(std::io::Error::new(
                ErrorKind::UnexpectedEof,
                "PowerShell parser closed stdout",
            ));
        }

        let response = deserialize_response(&response_line)?;
        // Requests are serialized today; the id still catches protocol desyncs if stdout is
        // contaminated or the child process is unexpectedly replaced mid-request. That turns an
        // ambiguous parser result into a hard failure so the caller can discard the cached child.
        if response.id != request.id {
            return Err(std::io::Error::new(
                ErrorKind::InvalidData,
                format!(
                    "PowerShell parser returned response id {} for request {}",
                    response.id, request.id
                ),
            ));
        }

        Ok(response.into_outcome())
    }
}

impl Drop for PowershellParserProcess {
    fn drop(&mut self) {
        kill_child(&mut self.child.lock().unwrap_or_else(PoisonError::into_inner));
    }
}

fn take_child_stdin(child: &mut Child) -> std::io::Result<ChildStdin> {
    child.stdin.take().ok_or_else(|| {
        std::io::Error::new(
            ErrorKind::BrokenPipe,
            "PowerShell parser child did not expose stdin",
        )
    })
}

fn take_child_stdout(child: &mut Child) -> std::io::Result<BufReader<ChildStdout>> {
    child.stdout.take().map(BufReader::new).ok_or_else(|| {
        std::io::Error::new(
            ErrorKind::BrokenPipe,
            "PowerShell parser child did not expose stdout",
        )
    })
}

fn serialize_request(request: &PowershellParserRequest) -> std::io::Result<String> {
    serde_json::to_string(request).map_err(|error| {
        std::io::Error::new(
            ErrorKind::InvalidData,
            format!("failed to serialize PowerShell parser request: {error}"),
        )
    })
}

fn deserialize_response(response_line: &str) -> std::io::Result<PowershellParserResponse> {
    serde_json::from_str(response_line).map_err(|error| {
        std::io::Error::new(
            ErrorKind::InvalidData,
            format!("failed to parse PowerShell parser response: {error}"),
        )
    })
}

#[derive(Serialize)]
struct PowershellParserRequest {
    id: u64,
    payload: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PowershellParserResponse {
    id: u64,
    status: String,
    commands: Option<Vec<Vec<String>>>,
}

impl PowershellParserResponse {
    fn into_outcome(self) -> PowershellParseOutcome {
        match self.status.as_str() {
            "ok" => self
                .commands
                .filter(|commands| {
                    !commands.is_empty()
                        && commands
                            .iter()
                            .all(|cmd| !cmd.is_empty() && cmd.iter().all(|word| !word.is_empty()))
                })
                .map(PowershellParseOutcome::Commands)
                .unwrap_or(PowershellParseOutcome::Unsupported),
            "unsupported" => PowershellParseOutcome::Unsupported,
            _ => PowershellParseOutcome::Failed,
        }
    }
}

fn kill_child(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(all(test, unix))]
#[test]
fn a_stalled_parser_has_a_deadline_and_does_not_block_another_executable() {
    use std::os::unix::fs::PermissionsExt;
    let path = std::env::temp_dir().join(format!("atlas-parser-stall-{}.sh", std::process::id()));
    let mut script = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .unwrap();
    script.write_all(b"#!/bin/sh\nexec sleep 60\n").unwrap();
    script
        .set_permissions(std::fs::Permissions::from_mode(0o700))
        .unwrap();
    drop(script);
    let worker = ParserWorker::spawn(path.to_str().unwrap().to_string()).unwrap();
    let started = Instant::now();
    assert_eq!(
        worker.parse("Get-Content file", Duration::from_millis(100)),
        PowershellParseOutcome::Failed
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(
        parse_with_powershell_ast("/does/not/exist/powershell", "ignored"),
        PowershellParseOutcome::Failed
    );
    std::fs::remove_file(path).unwrap();
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use crate::powershell::try_find_powershell_executable_blocking;
    use pretty_assertions::assert_eq;

    #[test]
    fn parser_process_handles_multiple_requests() {
        let Some(powershell) = try_find_powershell_executable_blocking() else {
            return;
        };
        let powershell = powershell.as_path().to_str().unwrap();
        let mut parser = PowershellParserProcess::spawn(powershell).unwrap();

        let first = parser.parse("Get-Content 'foo bar'").unwrap();
        assert_eq!(
            first,
            PowershellParseOutcome::Commands(vec![vec![
                "Get-Content".to_string(),
                "foo bar".to_string(),
            ]]),
        );

        let second = parser.parse("Write-Output foo | Measure-Object").unwrap();
        assert_eq!(
            second,
            PowershellParseOutcome::Commands(vec![
                vec!["Write-Output".to_string(), "foo".to_string()],
                vec!["Measure-Object".to_string()],
            ]),
        );
    }

    #[test]
    fn parser_process_rejects_stop_parsing_forms() {
        let Some(powershell) = try_find_powershell_executable_blocking() else {
            return;
        };
        let powershell = powershell.as_path().to_str().unwrap();
        let mut parser = PowershellParserProcess::spawn(powershell).unwrap();

        let parsed = parser
            .parse("git log --% HEAD --output=atlas_engine_poc.txt")
            .unwrap();
        assert_eq!(parsed, PowershellParseOutcome::Unsupported);
    }

    #[test]
    fn parser_process_rejects_param_blocks() {
        let Some(powershell) = try_find_powershell_executable_blocking() else {
            return;
        };
        let powershell = powershell.as_path().to_str().unwrap();
        let mut parser = PowershellParserProcess::spawn(powershell).unwrap();

        let parsed = parser
            .parse("param([string]$path = (Get-Location)) Write-Output test")
            .unwrap();
        assert_eq!(parsed, PowershellParseOutcome::Unsupported);
    }

    #[test]
    fn parser_process_rejects_named_blocks() {
        let Some(powershell) = try_find_powershell_executable_blocking() else {
            return;
        };
        let powershell = powershell.as_path().to_str().unwrap();
        let mut parser = PowershellParserProcess::spawn(powershell).unwrap();

        let parsed = parser
            .parse(
                "begin { Set-Content atlas_engine_poc.txt pwned } end { Get-Content Cargo.toml }",
            )
            .unwrap();
        assert_eq!(parsed, PowershellParseOutcome::Unsupported);
    }

    #[test]
    fn parser_process_rejects_using_statements() {
        let Some(powershell) = try_find_powershell_executable_blocking() else {
            return;
        };
        let powershell = powershell.as_path().to_str().unwrap();
        let mut parser = PowershellParserProcess::spawn(powershell).unwrap();

        let parsed = parser
            .parse("using module ./atlas_engine_poc.psm1\nGet-Content Cargo.toml")
            .unwrap();
        assert_eq!(parsed, PowershellParseOutcome::Unsupported);
    }

    #[test]
    fn parser_process_rejects_trap_blocks() {
        let Some(powershell) = try_find_powershell_executable_blocking() else {
            return;
        };
        let powershell = powershell.as_path().to_str().unwrap();
        let mut parser = PowershellParserProcess::spawn(powershell).unwrap();

        let parsed = parser
            .parse(
                "trap { Set-Content atlas_engine_poc.txt pwned; continue } Get-Content missing -ErrorAction Stop",
            )
            .unwrap();
        assert_eq!(parsed, PowershellParseOutcome::Unsupported);
    }
}
