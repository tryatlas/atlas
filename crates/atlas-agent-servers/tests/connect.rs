//! Connect-path tests.
//!
//! These drive a real child process over real pipes. The fake agent is a small
//! python script rather than a mock transport, because what is under test is the
//! spawn-and-handshake path itself: the race between `initialize` and the child
//! dying is only meaningful against a process that can actually die.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{event_channel, AgentId, LoadError};
use atlas_agent_servers::*;

/// Answers `initialize` and then sits there. Writes its pid to `PID_FILE`
/// first when one is given, so a test can check whether it is still alive.
const FAKE_AGENT: &str = r#"
import sys, json, os
pid_file = PID_FILE
if pid_file:
    open(pid_file, "w").write(str(os.getpid()))
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        sys.stdout.write(json.dumps({
            "jsonrpc": "2.0",
            "id": msg["id"],
            "result": {
                "protocolVersion": PROTOCOL_VERSION,
                "agentCapabilities": {},
                "authMethods": [],
                "agentInfo": {"name": "fake-agent", "version": "9.9.9"},
            },
        }) + "\n")
        sys.stdout.flush()
"#;

/// `python3` from `PATH`, else from the usual install locations; `None` means
/// the python-backed tests skip.
///
/// Except under CI, where a missing interpreter is a failure: a runner without
/// python3 would otherwise report these tests green having run none of them.
fn python() -> Option<PathBuf> {
    let on_path = std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join("python3"))
            .find(|candidate| candidate.is_file())
    });
    let found = on_path.or_else(|| {
        [
            "/usr/bin/python3",
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
        ]
        .into_iter()
        .map(PathBuf::from)
        .find(|candidate| candidate.is_file())
    });
    if found.is_none() && std::env::var_os("CI").is_some_and(|ci| !ci.is_empty()) {
        panic!("python3 is not on PATH, and CI is set: these tests would skip rather than run");
    }
    found
}

fn thread_events() -> ThreadEventSink {
    Arc::new(
        |_agent: &atlas_acp_thread::AgentId, _session_id: &acp::SessionId| {
            let (tx, rx) = event_channel();
            // Nothing consumes thread events in this crate; keep the receiver alive
            // so sends do not fail for a reason unrelated to the test.
            Box::leak(Box::new(rx));
            tx
        },
    )
}

fn request_elicitation_events() -> RequestElicitationSink {
    Arc::new(|_agent_id: &AgentId| {
        let (tx, rx) = event_channel();
        Box::leak(Box::new(rx));
        tx
    })
}

fn command(path: &str, args: &[&str]) -> AgentServerCommand {
    AgentServerCommand {
        path: PathBuf::from(path),
        args: args.iter().map(std::string::ToString::to_string).collect(),
        env: Some(HashMap::new()),
    }
}

async fn connect(command: AgentServerCommand) -> anyhow::Result<AcpConnection> {
    AcpConnection::stdio(
        AgentId::new("fake"),
        command,
        None,
        AcpConnectionDefaults::default(),
        thread_events(),
        request_elicitation_events(),
        "atlas",
        "0.0.0-test".to_string(),
    )
    .await
}

fn fake_agent_command(protocol_version: u16) -> Option<AgentServerCommand> {
    fake_agent_command_with_pid_file(protocol_version, None)
}

fn fake_agent_command_with_pid_file(
    protocol_version: u16,
    pid_file: Option<&std::path::Path>,
) -> Option<AgentServerCommand> {
    let python = python()?;
    let script = FAKE_AGENT
        .replace("PROTOCOL_VERSION", &protocol_version.to_string())
        .replace(
            "PID_FILE",
            &match pid_file {
                Some(path) => format!("{:?}", path.display().to_string()),
                None => "None".to_string(),
            },
        );
    Some(AgentServerCommand {
        path: python,
        args: vec!["-c".to_string(), script],
        env: Some(HashMap::new()),
    })
}

/// The happy path: spawn, handshake, and take the agent at its word about who
/// it is.
#[tokio::test]
async fn a_successful_handshake_reports_the_agents_own_name_and_version() {
    let Some(command) = fake_agent_command(1) else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    let connection = connect(command).await.expect("handshake failed");

    use atlas_acp_thread::AgentConnection as _;
    assert_eq!(
        connection.telemetry_id().as_ref(),
        "fake-agent",
        "the agent's own name wins over the id we know it by"
    );
    assert_eq!(connection.agent_version().as_deref(), Some("9.9.9"));
}

/// The protocol-version guard: anything below v1 is rejected outright rather
/// than degraded to.
#[tokio::test]
async fn an_agent_below_protocol_v1_is_rejected() {
    let Some(command) = fake_agent_command(0) else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    let error = connect(command).await.expect_err("expected a rejection");
    let load_error = error
        .downcast_ref::<LoadError>()
        .expect("expected a LoadError");
    assert!(
        matches!(load_error, LoadError::Unsupported { .. }),
        "got {load_error:?}"
    );
}

/// The initialize-vs-exit race (`acp.rs:957-1021`). An agent that dies during
/// startup must surface as `Exited` with its status — before this, the connect
/// awaited a handle that would never arrive and the UI hung on "connecting".
#[tokio::test]
async fn an_agent_that_exits_immediately_reports_its_exit_status() {
    let error = connect(command("/bin/sh", &["-c", "exit 3"]))
        .await
        .expect_err("expected the connect to fail");

    let load_error = error
        .downcast_ref::<LoadError>()
        .expect("expected a LoadError, not a transport error");
    match load_error {
        LoadError::Exited { status, .. } => {
            assert_eq!(*status, Some(3), "the child's exit code must survive")
        }
        other => panic!("expected Exited, got {other:?}"),
    }
}

/// Same race, but the agent prints why before dying. The reason is on stderr and
/// nowhere else, so it has to reach the error.
#[tokio::test]
async fn a_dying_agent_reports_what_it_said_on_stderr() {
    let error = connect(command(
        "/bin/sh",
        &["-c", "echo 'cannot find module acp' >&2; exit 1"],
    ))
    .await
    .expect_err("expected the connect to fail");

    let load_error = error
        .downcast_ref::<LoadError>()
        .expect("expected a LoadError");
    match load_error {
        LoadError::Exited { stderr, .. } => assert!(
            stderr.contains("cannot find module acp"),
            "stderr did not reach the error: {stderr:?}"
        ),
        other => panic!("expected Exited, got {other:?}"),
    }
}

/// A binary that is not there at all fails at spawn rather than hanging.
#[tokio::test]
async fn a_missing_binary_fails_to_spawn() {
    let error = connect(command("/nonexistent/definitely-not-an-agent", &[]))
        .await
        .expect_err("expected the spawn to fail");

    assert!(
        error.to_string().contains("failed to spawn"),
        "unexpected error: {error}"
    );
}

/// A child that is alive but never answers `initialize` fails the connect
/// after [`INITIALIZE_TIMEOUT`] with a typed `TimedOut` naming the phase
/// (ADR-0008) — before the deadline, the tab sat on "connecting" forever.
///
/// On a paused clock: the runtime jumps to the next timer whenever it is idle,
/// so the real 60s deadline runs out in no wall time, and the elapsed time on
/// that clock says the connect gave up AT the deadline, not early.
#[tokio::test(start_paused = true)]
async fn an_agent_that_never_answers_initialize_times_out_at_the_deadline() {
    let started = tokio::time::Instant::now();
    let error = connect(command("/bin/sh", &["-c", "sleep 30"]))
        .await
        .expect_err("a silent agent must fail the connect, not park it");
    let elapsed = started.elapsed();

    let load_error = error
        .downcast_ref::<LoadError>()
        .expect("expected a LoadError the manager can carry");
    match load_error {
        LoadError::TimedOut { phase, after, .. } => {
            assert_eq!(
                phase.as_ref(),
                "initialize",
                "the hop that stalled is named"
            );
            assert_eq!(*after, INITIALIZE_TIMEOUT);
        }
        other => panic!("expected TimedOut, got {other:?}"),
    }
    assert!(
        elapsed >= INITIALIZE_TIMEOUT && elapsed < INITIALIZE_TIMEOUT * 2,
        "gave up after {elapsed:?}, not at the {INITIALIZE_TIMEOUT:?} deadline"
    );
}

/// Dropping the connection must take the agent process with it. Nothing else
/// holds a handle to kill it, so a leak here means an orphaned agent per
/// connection for the lifetime of the app.
#[tokio::test]
async fn dropping_the_connection_kills_the_agent_process() {
    let pid_file =
        std::env::temp_dir().join(format!("atlas-agent-servers-pid-{}", std::process::id()));
    let _ = std::fs::remove_file(&pid_file);

    let Some(command) = fake_agent_command_with_pid_file(1, Some(&pid_file)) else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    let connection = connect(command).await.expect("handshake failed");

    let pid: i32 = std::fs::read_to_string(&pid_file)
        .expect("agent did not report its pid")
        .trim()
        .parse()
        .expect("unparsable pid");
    assert!(process_is_alive(pid), "agent should be running");

    drop(connection);

    // The kill is asynchronous — the wait task has to be aborted and the child
    // dropped before the signal lands.
    for _ in 0..100 {
        if !process_is_alive(pid) {
            let _ = std::fs::remove_file(&pid_file);
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    let _ = std::fs::remove_file(&pid_file);
    panic!("agent process {pid} outlived its connection");
}

/// An agent that answers `initialize`, then handles SIGTERM as told: `trap`
/// writes `term` to MARK_FILE and exits, `ignore` carries on regardless.
const TERM_AGENT: &str = r#"
import sys, json, os, signal
def on_term(*_):
    open(MARK_FILE, "w").write("term")
    os._exit(0)
signal.signal(signal.SIGTERM, on_term if MODE == "trap" else signal.SIG_IGN)
open(PID_FILE, "w").write(str(os.getpid()))
for line in sys.stdin:
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": 1, "agentCapabilities": {}, "authMethods": []}}) + "\n")
        sys.stdout.flush()
while True:
    signal.pause()
"#;

/// Spawns [`TERM_AGENT`] in `mode`, waits for its pid, and drops the
/// connection: the pid and the mark file the agent writes on SIGTERM.
async fn drop_a_term_agent(mode: &str) -> Option<(i32, PathBuf)> {
    let dir = std::env::temp_dir().join(format!("atlas-term-agent-{mode}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create the agent's directory");
    let (pid_file, mark_file) = (dir.join("pid"), dir.join("mark"));
    let script = TERM_AGENT
        .replace(
            "MARK_FILE",
            &format!("{:?}", mark_file.display().to_string()),
        )
        .replace("PID_FILE", &format!("{:?}", pid_file.display().to_string()))
        .replace("MODE", &format!("{mode:?}"));
    let command = AgentServerCommand {
        path: python()?,
        args: vec!["-c".to_string(), script],
        env: Some(HashMap::new()),
    };
    let connection = connect(command).await.expect("handshake failed");
    let pid: i32 = std::fs::read_to_string(&pid_file)
        .expect("agent did not report its pid")
        .trim()
        .parse()
        .expect("unparsable pid");
    drop(connection);
    Some((pid, mark_file))
}

/// #91: an agent is asked to stop before it is made to — SIGTERM first, so
/// it can write out the session it was saving.
#[tokio::test]
async fn dropping_the_connection_sends_sigterm_first() {
    let Some((pid, mark_file)) = drop_a_term_agent("trap").await else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    for _ in 0..100 {
        if !process_is_alive(pid) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(
        std::fs::read_to_string(&mark_file).ok().as_deref(),
        Some("term"),
        "the agent heard SIGTERM before it died"
    );
    let _ = std::fs::remove_dir_all(mark_file.parent().expect("the agent's directory"));
}

/// #91: and one that ignores SIGTERM is killed anyway, after a short grace.
#[tokio::test]
async fn an_agent_that_ignores_sigterm_is_killed_after_the_grace() {
    let Some((pid, mark_file)) = drop_a_term_agent("ignore").await else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    let mut died = false;
    for _ in 0..200 {
        if !process_is_alive(pid) {
            died = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let _ = std::fs::remove_dir_all(mark_file.parent().expect("the agent's directory"));
    assert!(died, "agent {pid} ignored SIGTERM and outlived the grace");
}

/// `kill -0`: signal 0 checks for existence without delivering anything.
fn process_is_alive(pid: i32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// A fake agent that also answers `session/new`, with whatever config options
/// the test hands it. This is the shape model selection actually arrives in:
/// ACP has no `models` field, so an agent offering a choice of model says so
/// with a `category: "model"` select among its session config options.
const SESSION_AGENT: &str = r#"
import sys, json
CONFIG = CONFIG_OPTIONS
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        result = {
            "protocolVersion": 1,
            "agentCapabilities": {},
            "authMethods": [],
            "agentInfo": {"name": "fake-agent", "version": "9.9.9"},
        }
    elif method == "session/new":
        result = {"sessionId": "session-1", "configOptions": CONFIG}
    elif method == "session/set_config_option":
        # The request flattens its value: `{sessionId, configId, value}`.
        picked = msg["params"]["value"]
        for option in CONFIG:
            if option.get("category") == "model":
                option["currentValue"] = picked
        result = {"configOptions": CONFIG}
    else:
        continue
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result}) + "\n")
    sys.stdout.flush()
"#;

fn session_agent_command(config_options: serde_json::Value) -> Option<AgentServerCommand> {
    let python = python()?;
    let script = SESSION_AGENT.replace("CONFIG_OPTIONS", &config_options.to_string());
    Some(AgentServerCommand {
        path: python,
        args: vec!["-c".to_string(), script],
        env: Some(HashMap::new()),
    })
}

fn model_config_options() -> serde_json::Value {
    serde_json::json!([
        {
            "id": "model",
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": "sonnet",
            "options": [
                { "value": "sonnet", "name": "Sonnet" },
                { "value": "opus", "name": "Opus" },
            ],
        },
    ])
}

async fn session_on(
    config_options: serde_json::Value,
) -> Option<(Arc<AcpConnection>, acp::SessionId)> {
    let command = session_agent_command(config_options)?;
    let connection = Arc::new(connect(command).await.expect("handshake failed"));

    use atlas_acp_thread::AgentConnection as _;
    let cwd = std::env::temp_dir();
    let thread = connection
        .clone()
        .new_session(vec![cwd])
        .await
        .expect("session/new failed");
    let session_id = thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .session_id()
        .clone();
    // The thread must outlive this call: the session registry holds it weakly.
    Box::leak(Box::new(thread));
    Some((connection, session_id))
}

/// The regression itself. `AgentConnection::model_selector` defaults to `None`,
/// and `AcpConnection` did not override it — so `available_models` was empty for
/// EVERY external agent and the composer's model pill never rendered, whatever
/// the agent advertised.
#[tokio::test]
async fn an_agent_advertising_a_model_select_gets_a_model_selector() {
    let Some((connection, session_id)) = session_on(model_config_options()).await else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    use atlas_acp_thread::AgentConnection as _;
    let selector = connection
        .model_selector(&session_id)
        .expect("an agent advertising a model select must offer a model selector");

    let models = selector.list_models().await.expect("list_models failed");
    let atlas_acp_thread::AgentModelList::Flat(models) = models else {
        panic!("a select flattens into one list");
    };
    let ids: Vec<_> = models.iter().map(|model| model.id.as_str()).collect();
    assert_eq!(ids, vec!["sonnet", "opus"]);

    let selected = selector
        .selected_model()
        .await
        .expect("selected_model failed");
    assert_eq!(
        selected.id.as_str(),
        "sonnet",
        "a session nobody has picked in still has the model the agent defaulted to"
    );
}

/// Picking a model goes out as `session/set_config_option` on the model
/// option's id — there is no `session/set_model` in this protocol version — and
/// the response's list becomes the local view.
#[tokio::test]
async fn picking_a_model_sets_the_agents_model_config_option() {
    let Some((connection, session_id)) = session_on(model_config_options()).await else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    use atlas_acp_thread::AgentConnection as _;
    let selector = connection
        .model_selector(&session_id)
        .expect("a model selector");
    selector
        .select_model(atlas_acp_thread::AgentModelId::new("opus"))
        .await
        .expect("select_model failed");

    let selected = selector
        .selected_model()
        .await
        .expect("selected_model failed");
    assert_eq!(
        selected.id.as_str(),
        "opus",
        "the pick must reach the agent"
    );
}

/// The other half of the gate: no model select advertised, no model selector.
/// This is what keeps the pill hidden for an agent that does not offer one —
/// gated on the advertised category, never on which agent it is (ADR-0002).
#[tokio::test]
async fn an_agent_advertising_no_model_select_gets_no_model_selector() {
    let Some((connection, session_id)) = session_on(serde_json::json!([
        {
            "id": "thinking",
            "name": "Thinking",
            "category": "thought_level",
            "type": "select",
            "currentValue": "low",
            "options": [{ "value": "low", "name": "Low" }],
        },
    ]))
    .await
    else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    use atlas_acp_thread::AgentConnection as _;
    assert!(
        connection.model_selector(&session_id).is_none(),
        "an agent that advertises no model select must not get a model picker"
    );
    assert!(
        connection.session_config_options(&session_id).is_some(),
        "its other knobs still reach the composer"
    );
}

/// A fake agent for driving the inbound dispatch: on `session/prompt` it
/// announces a tool call, asks permission for it with a BARE update (id only —
/// legal: `title` is optional on updates), and then KEEPS TALKING while the
/// question is open. It ends the turn only once the permission answer arrives.
///
/// That last part is the point. An agent blocked on `session/request_permission`
/// still streams — other tool results, text, other sessions' work — and a
/// client that processes inbound messages inline stalls all of it behind the
/// open prompt.
const PERMISSION_AGENT: &str = r#"
import sys, json
def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()
def update(u):
    send({"jsonrpc": "2.0", "method": "session/update",
          "params": {"sessionId": "session-1", "update": u}})
prompt_id = None
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": 1, "agentCapabilities": {}, "authMethods": [],
            "agentInfo": {"name": "fake-agent", "version": "9.9.9"}}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"sessionId": "session-1"}})
    elif method == "session/prompt":
        prompt_id = msg["id"]
        update({"sessionUpdate": "tool_call", "toolCallId": "call-1",
                "title": "Run tests", "kind": "execute", "status": "pending"})
        send({"jsonrpc": "2.0", "id": 100, "method": "session/request_permission",
              "params": {"sessionId": "session-1",
                         "toolCall": {"toolCallId": "call-1"},
                         "options": [
                             {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                             {"optionId": "deny", "name": "Deny", "kind": "reject_once"}]}})
        update({"sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "still streaming"}})
    elif msg.get("id") == 100 and "result" in msg:
        send({"jsonrpc": "2.0", "id": prompt_id, "result": {"stopReason": "end_turn"}})
"#;

fn permission_agent_command() -> Option<AgentServerCommand> {
    Some(AgentServerCommand {
        path: python()?,
        args: vec!["-c".to_string(), PERMISSION_AGENT.to_string()],
        env: Some(HashMap::new()),
    })
}

/// The blocking regression (#28). Inbound messages are dispatched serially and
/// our handlers used to be awaited INLINE — so an open permission prompt
/// blocked every message behind it: no text, no tool results, and no way for
/// the cancellation to ever arrive. The handlers enqueue-and-return, and the
/// drain defers every long await; this pins that shape.
#[tokio::test]
async fn a_pending_permission_does_not_block_the_messages_behind_it() {
    use atlas_acp_thread::{AgentConnection as _, AgentThreadEntry, ToolCallStatus};

    let Some(command) = permission_agent_command() else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    let connection = Arc::new(connect(command).await.expect("handshake failed"));
    let thread = connection
        .clone()
        .new_session(vec![std::env::temp_dir()])
        .await
        .expect("session/new failed");
    let session_id = {
        let mut thread = thread
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // The turn opens before the prompt goes out, as `AgentManager::send`
        // opens it: a permission request is only ever raised inside one.
        thread.begin_turn();
        thread.session_id().clone()
    };

    let prompt = tokio::spawn(connection.clone().prompt(acp::PromptRequest::new(
        session_id,
        vec![acp::ContentBlock::from("run the tests")],
    )));

    // The chunk was sent AFTER the permission request. It must land while the
    // question is still open — that is the whole regression.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let (mut saw_chunk, mut saw_prompt) = (false, false);
    while std::time::Instant::now() < deadline && !(saw_chunk && saw_prompt) {
        {
            let thread = thread
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            for entry in thread.entries() {
                match entry {
                    AgentThreadEntry::AssistantMessage(message) => {
                        if message
                            .chunks
                            .iter()
                            .any(|chunk| chunk.block().to_text().contains("still streaming"))
                        {
                            saw_chunk = true;
                        }
                    }
                    AgentThreadEntry::ToolCall(call) => {
                        if matches!(call.status, ToolCallStatus::WaitingForConfirmation { .. }) {
                            saw_prompt = true;
                        }
                    }
                    _ => {}
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(
        saw_prompt,
        "the permission request must surface as an open prompt"
    );
    assert!(
        saw_chunk,
        "the chunk behind the open prompt must render while it is still open"
    );

    // Answer it; the agent then ends the turn.
    thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .authorize_tool_call(
            acp::ToolCallId::new("call-1"),
            atlas_acp_thread::SelectedPermissionOutcome::new(
                acp::PermissionOptionId::new("allow"),
                acp::PermissionOptionKind::AllowOnce,
            ),
        );

    let response = tokio::time::timeout(std::time::Duration::from_secs(5), prompt)
        .await
        .expect("the turn must end once the permission is answered")
        .expect("prompt task panicked")
        .expect("prompt failed");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);
}

/// A fake agent whose permission request crosses the user's Stop on the wire:
/// it announces a tool call, and asks permission for it only once the
/// `session/cancel` has reached it — the request it had in flight when the
/// client cancelled. It reports the answer it got as a text chunk, then ends
/// the turn as cancelled.
const LATE_PERMISSION_AGENT: &str = r#"
import sys, json
def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()
def update(u):
    send({"jsonrpc": "2.0", "method": "session/update",
          "params": {"sessionId": "session-1", "update": u}})
prompt_id = None
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": 1, "agentCapabilities": {}, "authMethods": [],
            "agentInfo": {"name": "fake-agent", "version": "9.9.9"}}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"sessionId": "session-1"}})
    elif method == "session/prompt":
        prompt_id = msg["id"]
        update({"sessionUpdate": "tool_call", "toolCallId": "call-1",
                "title": "rm -rf build", "kind": "execute", "status": "pending"})
    elif method == "session/cancel":
        send({"jsonrpc": "2.0", "id": 100, "method": "session/request_permission",
              "params": {"sessionId": "session-1",
                         "toolCall": {"toolCallId": "call-1"},
                         "options": [
                             {"optionId": "allow", "name": "Allow", "kind": "allow_once"},
                             {"optionId": "deny", "name": "Deny", "kind": "reject_once"}]}})
    elif msg.get("id") == 100 and "result" in msg:
        outcome = msg["result"]["outcome"]["outcome"]
        update({"sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "permission answered: " + outcome}})
        send({"jsonrpc": "2.0", "id": prompt_id, "result": {"stopReason": "cancelled"}})
"#;

/// #89. Stop cleared the turn and sent `session/cancel`, but a permission
/// request the agent had already sent arrived after it and was raised like any
/// other: a prompt for a turn that was over, which nobody was waiting on and a
/// later click would answer. ACP: once the client cancels the turn it MUST
/// answer every pending `session/request_permission` with `Cancelled` — so one
/// that arrives with no turn running is answered that way at once, and never
/// shown.
#[tokio::test]
async fn a_permission_request_crossing_stop_is_answered_cancelled_and_never_shown() {
    use atlas_acp_thread::{AgentConnection as _, AgentThreadEntry, ToolCallStatus};

    let Some(python) = python() else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    let command = AgentServerCommand {
        path: python,
        args: vec!["-c".to_string(), LATE_PERMISSION_AGENT.to_string()],
        env: Some(HashMap::new()),
    };
    let connection = Arc::new(connect(command).await.expect("handshake failed"));
    let thread = connection
        .clone()
        .new_session(vec![std::env::temp_dir()])
        .await
        .expect("session/new failed");
    let lock = || {
        thread
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    };
    let session_id = {
        let mut thread = lock();
        thread.begin_turn();
        thread.session_id().clone()
    };
    let prompt = tokio::spawn(connection.clone().prompt(acp::PromptRequest::new(
        session_id,
        vec![acp::ContentBlock::from("clean up")],
    )));

    // Stop once the agent is working on the call.
    let announced = |thread: &atlas_acp_thread::AcpThread| {
        thread
            .entries()
            .iter()
            .any(|entry| matches!(entry, AgentThreadEntry::ToolCall(_)))
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !announced(&lock()) {
        assert!(
            std::time::Instant::now() < deadline,
            "the tool call never arrived"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    lock().cancel();

    let answer = |thread: &atlas_acp_thread::AcpThread| -> Option<String> {
        thread.entries().iter().find_map(|entry| match entry {
            AgentThreadEntry::AssistantMessage(message) => message
                .chunks
                .iter()
                .map(|chunk| chunk.block().to_text().to_string())
                .find(|text| text.contains("permission answered")),
            _ => None,
        })
    };
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    let answered = loop {
        {
            let thread = lock();
            assert!(
                !thread.entries().iter().any(|entry| matches!(
                    entry,
                    AgentThreadEntry::ToolCall(call)
                        if matches!(call.status, ToolCallStatus::WaitingForConfirmation { .. })
                )),
                "a request that crossed Stop must never be raised as a prompt"
            );
            if let Some(text) = answer(&thread) {
                break text;
            }
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the agent was never answered: its request is waiting on a prompt nobody sees"
        );
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    };
    assert_eq!(answered, "permission answered: cancelled");

    let response = tokio::time::timeout(std::time::Duration::from_secs(5), prompt)
        .await
        .expect("the turn must end")
        .expect("prompt task panicked")
        .expect("prompt failed");
    assert_eq!(response.stop_reason, acp::StopReason::Cancelled);
}

/// A fake agent that runs its command ITSELF and embeds the terminal in
/// tool-call meta — the `terminal_info` / `terminal_output` / `terminal_exit`
/// extension Atlas advertises in its client capabilities. No `terminal/create`
/// is ever called: the id is the agent's own, and everything about the
/// terminal arrives through `session/update` meta.
const EMBEDDED_TERMINAL_AGENT: &str = r#"
import sys, json
def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()
def update(u):
    send({"jsonrpc": "2.0", "method": "session/update",
          "params": {"sessionId": "session-1", "update": u}})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": 1, "agentCapabilities": {}, "authMethods": [],
            "agentInfo": {"name": "fake-agent", "version": "9.9.9"}}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"sessionId": "session-1"}})
    elif method == "session/prompt":
        update({"sessionUpdate": "tool_call", "toolCallId": "call-1",
                "title": "cargo test", "kind": "execute", "status": "in_progress",
                "content": [{"type": "terminal", "terminalId": "emb-1"}],
                "_meta": {"terminal_info": {"terminal_id": "emb-1", "cwd": "/tmp"}}})
        update({"sessionUpdate": "tool_call_update", "toolCallId": "call-1",
                "_meta": {"terminal_output": {"terminal_id": "emb-1",
                                              "data": "hello from the embedded terminal"}}})
        update({"sessionUpdate": "tool_call_update", "toolCallId": "call-1",
                "status": "completed",
                "_meta": {"terminal_exit": {"terminal_id": "emb-1", "exit_code": 0}}})
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"stopReason": "end_turn"}})
"#;

/// The omission behind #29: Atlas advertises the embedded-terminal meta
/// extension but never consumed it, so a tool call carrying one hard-failed
/// its upsert — a stuck or missing tool call, no output, and (through the same
/// error) dropped permission requests and starved shell attribution.
#[tokio::test]
async fn an_embedded_terminal_in_tool_call_meta_is_created_and_streams() {
    use atlas_acp_thread::{AgentConnection as _, AgentThreadEntry, ToolCallStatus};

    let Some(python) = python() else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    let command = AgentServerCommand {
        path: python,
        args: vec!["-c".to_string(), EMBEDDED_TERMINAL_AGENT.to_string()],
        env: Some(HashMap::new()),
    };
    let connection = Arc::new(connect(command).await.expect("handshake failed"));
    let thread = connection
        .clone()
        .new_session(vec![std::env::temp_dir()])
        .await
        .expect("session/new failed");
    let session_id = thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .session_id()
        .clone();

    let response = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        connection.clone().prompt(acp::PromptRequest::new(
            session_id,
            vec![acp::ContentBlock::from("run the tests")],
        )),
    )
    .await
    .expect("the turn must end")
    .expect("prompt failed");
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);

    let thread = thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let call = thread
        .entries()
        .iter()
        .find_map(|entry| match entry {
            AgentThreadEntry::ToolCall(call) if call.id.0.as_ref() == "call-1" => Some(call),
            _ => None,
        })
        .expect("the tool call must exist — its embedded terminal must not fail the upsert");
    assert!(
        matches!(call.status, ToolCallStatus::Completed),
        "status must have followed the updates, got {:?}",
        call.status
    );

    let output = thread
        .terminal_output(&acp::TerminalId::new("emb-1"))
        .expect("the embedded terminal must exist in the registry");
    assert!(
        output.contains("hello from the embedded terminal"),
        "meta output must stream into the terminal: {output:?}"
    );
    let terminal = thread
        .terminal(&acp::TerminalId::new("emb-1"))
        .expect("registered");
    assert_eq!(
        terminal
            .current_output()
            .exit_status
            .and_then(|s| s.exit_code),
        Some(0),
        "the meta exit must land"
    );
}

/// Handshakes, opens a session, then goes silent on `session/prompt` — and
/// ignores `session/cancel` too, which is the whole point. A wedged agent is
/// alive (so nothing detects an exit) and unresponsive (so nothing on the wire
/// resolves the turn).
const WEDGED_AGENT: &str = r#"
import sys, json
def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": 1, "agentCapabilities": {}, "authMethods": [],
            "agentInfo": {"name": "wedged-agent", "version": "9.9.9"}}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"sessionId": "session-1"}})
    # session/prompt and session/cancel deliberately get no answer.
"#;

fn wedged_agent_command() -> Option<AgentServerCommand> {
    Some(AgentServerCommand {
        path: python()?,
        args: vec!["-c".to_string(), WEDGED_AGENT.to_string()],
        env: Some(HashMap::new()),
    })
}

/// The cancel grace the wedged-agent tests run with, in place of the real
/// seconds-long one. Every bound below is stated in multiples of it, so the
/// tests say the same thing whatever the production constant is.
const TEST_CANCEL_GRACE: std::time::Duration = std::time::Duration::from_millis(500);

/// A session on the wedged agent, with the cancel grace shortened. The thread
/// is returned because the session registry holds it only weakly.
async fn wedged_session() -> Option<(
    Arc<AcpConnection>,
    acp::SessionId,
    atlas_acp_thread::AcpThreadHandle,
)> {
    use atlas_acp_thread::AgentConnection as _;

    let connection = Arc::new(
        connect(wedged_agent_command()?)
            .await
            .expect("handshake failed"),
    );
    connection.set_deadlines(ConnectionDeadlines {
        cancel_grace: TEST_CANCEL_GRACE,
    });
    let thread = connection
        .clone()
        .new_session(vec![std::env::temp_dir()])
        .await
        .expect("session/new failed");
    let session_id = thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .session_id()
        .clone();
    Some((connection, session_id, thread))
}

/// ATL-232. `cancel` is a notification — no response, no obligation — so an
/// agent that ignores it left the prompt future pending forever and the only
/// way out was quitting Atlas. The turn now resolves locally once the agent has
/// had its grace period to answer for itself — and not before.
///
/// Deliberately a real child process over real pipes: the defect is that
/// nothing in the stack owns a clock, and a mock transport would supply the
/// very thing whose absence is under test.
#[tokio::test]
async fn a_cancel_the_agent_ignores_still_ends_the_turn() {
    use atlas_acp_thread::AgentConnection as _;

    let Some((connection, session_id, _thread)) = wedged_session().await else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    let prompt = tokio::spawn(connection.clone().prompt(acp::PromptRequest::new(
        session_id.clone(),
        vec![acp::ContentBlock::from("do something slow")],
    )));

    // Let the prompt actually reach the wire, so this exercises "cancel during
    // a live turn" rather than "cancel before the request went out".
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    assert!(!prompt.is_finished(), "the agent was supposed to go silent");

    let cancelled_at = std::time::Instant::now();
    connection.cancel(&session_id);

    let response = tokio::time::timeout(TEST_CANCEL_GRACE * 10, prompt)
        .await
        .expect("the turn outlived its cancel grace — this is the ATL-232 hang")
        .expect("prompt task panicked")
        .expect("a cancelled turn is a normal stop, not an error");
    let waited = cancelled_at.elapsed();

    assert_eq!(
        response.stop_reason,
        acp::StopReason::Cancelled,
        "a locally-resolved cancel must still read as cancelled"
    );
    assert!(
        waited >= TEST_CANCEL_GRACE,
        "the turn was resolved after {waited:?}, before the agent's \
         {TEST_CANCEL_GRACE:?} grace to answer for itself ran out"
    );
}

/// Pressing Stop twice is what a user does when nothing appears to happen, and
/// the composer leaves the button live while a stop is pending. Every press
/// must be harmless — and none may restart the clock.
#[tokio::test]
async fn cancelling_repeatedly_is_harmless() {
    use atlas_acp_thread::AgentConnection as _;

    let Some((connection, session_id, _thread)) = wedged_session().await else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    let prompt = tokio::spawn(connection.clone().prompt(acp::PromptRequest::new(
        session_id.clone(),
        vec![acp::ContentBlock::from("do something slow")],
    )));
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    // Presses keep coming for four graces, so they land both before and after
    // the turn ends. A press that restarted the clock would hold the turn open
    // until a grace after the LAST one; the first press's grace must end it.
    let first_press = std::time::Instant::now();
    let presser = tokio::spawn({
        let connection = connection.clone();
        let session_id = session_id.clone();
        async move {
            while first_press.elapsed() < TEST_CANCEL_GRACE * 4 {
                connection.cancel(&session_id);
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
    });

    let response = tokio::time::timeout(TEST_CANCEL_GRACE * 10, prompt)
        .await
        .expect("repeated cancels must not postpone the deadline")
        .expect("prompt task panicked")
        .expect("a cancelled turn is a normal stop, not an error");
    let waited = first_press.elapsed();
    assert_eq!(response.stop_reason, acp::StopReason::Cancelled);
    assert!(
        waited < TEST_CANCEL_GRACE * 3,
        "the turn ended {waited:?} after the first press — later presses \
         pushed the {TEST_CANCEL_GRACE:?} deadline back"
    );

    // Cancelling a turn that already ended must not panic or wedge anything.
    presser
        .await
        .expect("a cancel after the turn ended panicked");
    connection.cancel(&session_id);
}

/// The grace period only starts when the user asks to stop. A turn nobody
/// cancelled must not be capped by it, or every legitimate long turn dies at
/// the deadline — the exact failure a flat request timeout would have caused.
#[tokio::test]
async fn an_uncancelled_turn_is_not_capped_by_the_grace_period() {
    use atlas_acp_thread::AgentConnection as _;

    let Some((connection, session_id, _thread)) = wedged_session().await else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    let prompt = tokio::spawn(connection.clone().prompt(acp::PromptRequest::new(
        session_id,
        vec![acp::ContentBlock::from("a turn that takes a while")],
    )));

    // Well past the grace period, with no cancel sent.
    tokio::time::sleep(TEST_CANCEL_GRACE * 4).await;
    assert!(
        !prompt.is_finished(),
        "an uncancelled turn was resolved by the cancel deadline — the clock \
         must not start until the user asks to stop"
    );
    prompt.abort();
}

// ------------------------------------------------------------------ fs/* gaps
//
// ATL-233's containment check and ATL-236's coverage list meet here. The check
// itself has unit tests; what had never been exercised was the path an agent
// actually takes to reach it — a real `fs/write_text_file` request, over a real
// pipe, against a session whose granted roots the test chose.

/// Asks the client to write and then read a path OUTSIDE the granted root, and
/// records what it was told. Reporting through a file because the outcome is
/// the agent's, not the thread's: what is under test is what the agent was
/// allowed to do, which no amount of reading our own state can answer.
const FS_ESCAPE_AGENT: &str = r#"
import sys, json
outside = OUTSIDE
result_file = RESULT_FILE
pending = {}
outcome = {}
def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()
prompt_id = None
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": 1, "agentCapabilities": {}, "authMethods": [],
            "agentInfo": {"name": "fs-escape-agent", "version": "9.9.9"}}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"sessionId": "session-1"}})
    elif method == "session/prompt":
        prompt_id = msg["id"]
        pending[300] = "write"
        send({"jsonrpc": "2.0", "id": 300, "method": "fs/write_text_file",
              "params": {"sessionId": "session-1", "path": outside,
                         "content": "written by the agent, outside the project root\n"}})
    elif msg.get("id") in pending:
        which = pending.pop(msg["id"])
        outcome[which] = "error" if "error" in msg else "ok"
        if which == "write":
            pending[301] = "read"
            send({"jsonrpc": "2.0", "id": 301, "method": "fs/read_text_file",
                  "params": {"sessionId": "session-1", "path": outside}})
        else:
            open(result_file, "w").write(json.dumps(outcome))
            send({"jsonrpc": "2.0", "id": prompt_id, "result": {"stopReason": "end_turn"}})
"#;

fn fs_escape_agent_command(
    outside: &std::path::Path,
    result_file: &std::path::Path,
) -> Option<AgentServerCommand> {
    let script = FS_ESCAPE_AGENT
        .replace("OUTSIDE", &format!("{:?}", outside.display().to_string()))
        .replace(
            "RESULT_FILE",
            &format!("{:?}", result_file.display().to_string()),
        );
    Some(AgentServerCommand {
        path: python()?,
        args: vec!["-c".to_string(), script],
        env: Some(HashMap::new()),
    })
}

/// ATL-233. The agent is a child process with the user's own privileges, so
/// this is not a privilege boundary — it is the backstop for a model steered by
/// repository content, and the containment a self-sandboxing agent delegated to
/// us. `create_dir_all` running before the write is the concrete half: a
/// refused write must not leave a directory tree behind as a side effect.
#[tokio::test]
async fn an_agent_cannot_write_outside_the_sessions_granted_directories() {
    use atlas_acp_thread::AgentConnection as _;

    let base = std::env::temp_dir().join(format!(
        "atlas-fs-escape-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let granted = base.join("project");
    let escaped = base.join("NOT-the-project/deep/nested/escaped.txt");
    let result_file = base.join("outcome.json");
    std::fs::create_dir_all(&granted).expect("create the granted root");

    let Some(command) = fs_escape_agent_command(&escaped, &result_file) else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    let connection = Arc::new(connect(command).await.expect("handshake failed"));
    let thread = connection
        .clone()
        .new_session(vec![granted.clone()])
        .await
        .expect("session/new failed");
    let session_id = thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .session_id()
        .clone();

    connection
        .clone()
        .prompt(acp::PromptRequest::new(
            session_id,
            vec![acp::ContentBlock::from("go outside")],
        ))
        .await
        .expect("the turn itself should end normally");

    let outcome: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&result_file).expect("agent wrote no outcome"),
    )
    .expect("outcome is json");

    assert_eq!(
        outcome["write"], "error",
        "the write was serviced rather than refused: {outcome}"
    );
    assert_eq!(
        outcome["read"], "error",
        "the read was serviced rather than refused: {outcome}"
    );
    assert!(
        !escaped.exists(),
        "a refused write still put a file on disk at {}",
        escaped.display()
    );
    assert!(
        !escaped.parent().expect("a parent").exists(),
        "a refused write still created directories outside the root"
    );
    assert!(
        !base.join("NOT-the-project").exists(),
        "create_dir_all ran before the containment check"
    );

    let _ = std::fs::remove_dir_all(&base);
}

// ------------------------------------------------------- client methods, scripted
//
// The `terminal/*` and `fs/*` requests an agent makes of Atlas. The installed
// Claude and Codex adapters run their commands themselves (`terminal_info`
// meta), so these paths are what every OTHER agent takes — and nothing but a
// real request over a real pipe exercises the handlers end to end.

/// Plays the agent side of the client methods from a script. On
/// `session/prompt` it sends each step in order — a request to the client, or a
/// `session/update` — waits for each request's answer, then writes every answer
/// (`null` for an update) to a file and ends the turn. A step's `save` names a
/// field of its result that later steps can refer to as `"$name"`.
const CLIENT_REQUESTS_AGENT: &str = r#"
import sys, json
steps = json.load(open(STEPS_FILE))
result_file = RESULT_FILE
saved = {}
outcomes = []
prompt_id = None
at = 0
def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()
def fill(value):
    if isinstance(value, str) and value.startswith("$"):
        return saved.get(value[1:], value)
    if isinstance(value, dict):
        return {key: fill(item) for key, item in value.items()}
    if isinstance(value, list):
        return [fill(item) for item in value]
    return value
def advance():
    global at
    while at < len(steps) and "update" in steps[at]:
        send({"jsonrpc": "2.0", "method": "session/update",
              "params": {"sessionId": "session-1", "update": fill(steps[at]["update"])}})
        outcomes.append(None)
        at += 1
    if at == len(steps):
        open(result_file, "w").write(json.dumps(outcomes))
        send({"jsonrpc": "2.0", "id": prompt_id, "result": {"stopReason": "end_turn"}})
        return
    params = fill(steps[at]["params"])
    params["sessionId"] = "session-1"
    send({"jsonrpc": "2.0", "id": 1000 + at, "method": steps[at]["method"], "params": params})
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": 1, "agentCapabilities": {}, "authMethods": [],
            "agentInfo": {"name": "client-requests-agent", "version": "9.9.9"}}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"sessionId": "session-1"}})
    elif method == "session/prompt":
        prompt_id = msg["id"]
        advance()
    elif method is None and msg.get("id") == 1000 + at:
        outcomes.append({key: msg[key] for key in ("result", "error") if key in msg})
        save = steps[at].get("save")
        if save and "result" in msg:
            saved[save] = msg["result"][save]
        at += 1
        advance()
"#;

/// A fresh directory for one scripted run, and the session folder inside it.
fn scripted_dirs(name: &str) -> (PathBuf, PathBuf) {
    let base = std::env::temp_dir().join(format!(
        "atlas-{name}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let project = base.join("project");
    std::fs::create_dir_all(&project).expect("create the session folder");
    (base, project)
}

/// Run `steps` in a session whose one folder is `project`, answering Allow to
/// every permission Atlas asks for along the way (`terminal/create` asks
/// before it spawns), and return what each step was answered, with the thread.
/// `None` when there is no python3 to play the agent.
async fn run_client_requests(
    base: &std::path::Path,
    project: &std::path::Path,
    steps: &serde_json::Value,
) -> Option<(Vec<serde_json::Value>, atlas_acp_thread::AcpThreadHandle)> {
    run_client_requests_with_turn(base, project, steps, true).await
}

async fn run_client_requests_with_turn(
    base: &std::path::Path,
    project: &std::path::Path,
    steps: &serde_json::Value,
    begin_turn: bool,
) -> Option<(Vec<serde_json::Value>, atlas_acp_thread::AcpThreadHandle)> {
    use atlas_acp_thread::{AgentConnection as _, AgentThreadEntry, ToolCallStatus};

    let steps_file = base.join("steps.json");
    let result_file = base.join("outcomes.json");
    std::fs::write(&steps_file, steps.to_string()).expect("write the script");
    let script = CLIENT_REQUESTS_AGENT
        .replace(
            "STEPS_FILE",
            &format!("{:?}", steps_file.display().to_string()),
        )
        .replace(
            "RESULT_FILE",
            &format!("{:?}", result_file.display().to_string()),
        );
    let command = AgentServerCommand {
        path: python()?,
        args: vec!["-c".to_string(), script],
        env: Some(HashMap::new()),
    };

    let connection = Arc::new(connect(command).await.expect("handshake failed"));
    let thread = connection
        .clone()
        .new_session(vec![project.to_path_buf()])
        .await
        .expect("session/new failed");
    let session_id = thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .session_id()
        .clone();
    if begin_turn {
        // The real host opens the turn before invoking session/prompt.
        thread.lock().unwrap().begin_turn();
    }

    let approver = tokio::spawn({
        let thread = thread.clone();
        async move {
            loop {
                let waiting: Vec<acp::ToolCallId> = thread
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .entries()
                    .iter()
                    .filter_map(|entry| match entry {
                        AgentThreadEntry::ToolCall(call)
                            if matches!(
                                call.status,
                                ToolCallStatus::WaitingForConfirmation { .. }
                            ) =>
                        {
                            Some(call.id.clone())
                        }
                        _ => None,
                    })
                    .collect();
                for id in waiting {
                    thread
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .authorize_tool_call(
                            id,
                            atlas_acp_thread::SelectedPermissionOutcome::new(
                                acp::PermissionOptionId::new("allow_once"),
                                acp::PermissionOptionKind::AllowOnce,
                            ),
                        );
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
        }
    });

    let response = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        connection.clone().prompt(acp::PromptRequest::new(
            session_id,
            vec![acp::ContentBlock::from("run the script")],
        )),
    )
    .await
    .expect("the scripted turn never ended")
    .expect("prompt failed");
    approver.abort();
    assert_eq!(response.stop_reason, acp::StopReason::EndTurn);

    let outcomes: Vec<serde_json::Value> = serde_json::from_str(
        &std::fs::read_to_string(&result_file).expect("the agent wrote no outcomes"),
    )
    .expect("outcomes are json");
    Some((outcomes, thread))
}

#[tokio::test]
async fn a_terminal_request_crossing_stop_neither_asks_nor_spawns() {
    let (base, project) = scripted_dirs("terminal-after-stop");
    let marker = project.join("must-not-exist");
    let steps = serde_json::json!([{
        "method": "terminal/create",
        "params": {"command": "sh", "args": ["-c", format!("touch '{}'", marker.display())]},
    }]);
    let Some((outcomes, thread)) =
        run_client_requests_with_turn(&base, &project, &steps, false).await
    else {
        return;
    };
    assert!(outcomes[0].get("error").is_some(), "{outcomes:?}");
    assert!(
        thread.lock().unwrap().entries().is_empty(),
        "an idle session was asked to approve"
    );
    assert!(!marker.exists());
    let _ = std::fs::remove_dir_all(base);
}

/// What `pwd` printed, from a `terminal/output` answer.
fn printed(outcome: &serde_json::Value) -> String {
    outcome["result"]["output"]
        .as_str()
        .unwrap_or_else(|| panic!("not a terminal/output answer: {outcome}"))
        .trim()
        .to_string()
}

/// #29. ACP's `cwd` is optional, and portable-pty starts a command with no
/// directory in `$HOME` — so an agent that left it out ran its command in the
/// user's home, outside every folder the session was granted. No `cwd` means
/// the session's own folder.
#[tokio::test]
async fn a_client_terminal_without_a_cwd_runs_in_the_sessions_folder() {
    let (base, project) = scripted_dirs("terminal-cwd");
    let steps = serde_json::json!([
        {"method": "terminal/create", "save": "terminalId",
         "params": {"command": "/bin/sh", "args": ["-c", "pwd"]}},
        {"method": "terminal/wait_for_exit", "params": {"terminalId": "$terminalId"}},
        {"method": "terminal/output", "params": {"terminalId": "$terminalId"}},
        {"method": "terminal/release", "params": {"terminalId": "$terminalId"}},
    ]);
    let Some((outcomes, _thread)) = run_client_requests(&base, &project, &steps).await else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    let expected = project.canonicalize().expect("the session folder exists");
    assert_eq!(
        printed(&outcomes[2]),
        expected.display().to_string(),
        "a terminal/create without a cwd ran somewhere other than the session's folder"
    );

    let _ = std::fs::remove_dir_all(&base);
}

/// #29. portable-pty also falls back to `$HOME` when the directory it is given
/// does not exist, and the containment check passes a path that does not exist
/// yet (it was written for a write's target). The agent is told, instead.
#[tokio::test]
async fn a_client_terminal_in_a_folder_that_does_not_exist_is_refused() {
    let (base, project) = scripted_dirs("terminal-cwd-missing");
    let steps = serde_json::json!([
        {"method": "terminal/create",
         "params": {"command": "/bin/sh", "args": ["-c", "pwd"],
                    "cwd": project.join("missing").display().to_string()}},
    ]);
    let Some((outcomes, _thread)) = run_client_requests(&base, &project, &steps).await else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    assert_eq!(
        outcomes[0]["error"]["code"], -32602,
        "a cwd that does not exist must be refused as invalid params: {}",
        outcomes[0]
    );

    let _ = std::fs::remove_dir_all(&base);
}

/// #29. ACP: the `cwd` "must be an absolute path". A relative one used to be
/// resolved against Atlas's OWN working directory, which means nothing to the
/// agent.
#[tokio::test]
async fn a_client_terminal_with_a_relative_cwd_is_refused() {
    let (base, project) = scripted_dirs("terminal-cwd-relative");
    let steps = serde_json::json!([
        {"method": "terminal/create",
         "params": {"command": "/bin/sh", "args": ["-c", "pwd"], "cwd": "project"}},
    ]);
    let Some((outcomes, _thread)) = run_client_requests(&base, &project, &steps).await else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    assert_eq!(
        outcomes[0]["error"]["code"], -32602,
        "a relative cwd must be refused as invalid params: {}",
        outcomes[0]
    );

    let _ = std::fs::remove_dir_all(&base);
}

/// #27. ACP: after `terminal/release` "the TerminalId can no longer be used
/// with other terminal/* methods, but tool calls that already contain it,
/// continue to display its output". Release dropped the terminal outright, so
/// the tool call showing it re-projected with no output at all — the command's
/// output vanished from the transcript the moment the agent was done with it.
#[tokio::test]
async fn a_released_terminal_still_shows_its_output_in_its_tool_call() {
    let (base, project) = scripted_dirs("terminal-release");
    let steps = serde_json::json!([
        {"method": "terminal/create", "save": "terminalId",
         "params": {"command": "/bin/sh", "args": ["-c", "echo kept after release"]}},
        {"update": {"sessionUpdate": "tool_call", "toolCallId": "call-1",
                    "title": "echo", "kind": "execute", "status": "in_progress",
                    "content": [{"type": "terminal", "terminalId": "$terminalId"}]}},
        {"method": "terminal/wait_for_exit", "params": {"terminalId": "$terminalId"}},
        {"method": "terminal/release", "params": {"terminalId": "$terminalId"}},
        {"method": "terminal/output", "params": {"terminalId": "$terminalId"}},
        {"update": {"sessionUpdate": "tool_call_update", "toolCallId": "call-1",
                    "status": "completed"}},
    ]);
    let Some((outcomes, thread)) = run_client_requests(&base, &project, &steps).await else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    let terminal_id = acp::TerminalId::new(
        outcomes[0]["result"]["terminalId"]
            .as_str()
            .unwrap_or_else(|| panic!("terminal/create failed: {}", outcomes[0])),
    );
    assert!(
        outcomes[3].get("result").is_some(),
        "terminal/release failed: {}",
        outcomes[3]
    );
    assert!(
        outcomes[4].get("error").is_some(),
        "a released terminal must be unknown to terminal/*: {}",
        outcomes[4]
    );

    let thread = thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    assert!(
        thread.terminal(&terminal_id).is_none(),
        "a released id must not name a terminal for the terminal/* handlers"
    );
    let shown = thread.terminal_output(&terminal_id);
    assert!(
        shown
            .as_deref()
            .is_some_and(|output| output.contains("kept after release")),
        "the tool call lost the released terminal's output: {shown:?}"
    );

    let _ = std::fs::remove_dir_all(&base);
}

/// #31. A command the agent killed is reported as killed, with the signal
/// that did it — not as one that exited with code 1, which reads as a command
/// that ran and failed.
#[tokio::test]
async fn a_killed_client_terminal_reports_the_signal() {
    let (base, project) = scripted_dirs("terminal-kill");
    let steps = serde_json::json!([
        {"method": "terminal/create", "save": "terminalId",
         "params": {"command": "/bin/sh", "args": ["-c", "exec sleep 30"]}},
        {"method": "terminal/kill", "params": {"terminalId": "$terminalId"}},
        {"method": "terminal/wait_for_exit", "params": {"terminalId": "$terminalId"}},
        {"method": "terminal/release", "params": {"terminalId": "$terminalId"}},
    ]);
    let Some((outcomes, _thread)) = run_client_requests(&base, &project, &steps).await else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    let exit = &outcomes[2]["result"];
    assert_eq!(
        exit["signal"], "SIGHUP",
        "the signal that ended the command: {}",
        outcomes[2]
    );
    assert!(
        exit["exitCode"].is_null(),
        "a command a signal ended has no exit code: {}",
        outcomes[2]
    );

    let _ = std::fs::remove_dir_all(&base);
}

/// ATL-236 gap 1. Every fake agent in this suite emits well-formed JSON, and
/// the only malformed-input test sat at the debug-log layer — a helper, not the
/// transport. A garbage line from a real agent must be survivable: agents print
/// stray output, and losing the connection over one line loses the session.
#[tokio::test]
async fn a_garbage_line_from_the_agent_does_not_kill_the_connection() {
    let script = r#"
import sys, json
def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()
sys.stdout.write("this is not json at all\n")
sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    if msg.get("method") == "initialize":
        sys.stdout.write("{ not valid json either\n")
        sys.stdout.flush()
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": 1, "agentCapabilities": {}, "authMethods": [],
            "agentInfo": {"name": "noisy-agent", "version": "9.9.9"}}})
    elif msg.get("method") == "session/new":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"sessionId": "session-1"}})
"#;
    let Some(python) = python() else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    let command = AgentServerCommand {
        path: python,
        args: vec!["-c".to_string(), script.to_string()],
        env: Some(HashMap::new()),
    };

    use atlas_acp_thread::AgentConnection as _;
    let connection = Arc::new(
        tokio::time::timeout(std::time::Duration::from_secs(10), connect(command))
            .await
            .expect("a garbage line stalled the handshake")
            .expect("a garbage line killed the handshake"),
    );
    assert_eq!(connection.telemetry_id().as_ref(), "noisy-agent");

    connection
        .clone()
        .new_session(vec![std::env::temp_dir()])
        .await
        .expect("the connection must still be usable after the garbage");
}

/// ATL-236 gap 2. Start-up death and drop-kill were covered; dying *mid-turn*
/// was not. The prompt must fail rather than hang — the agent is gone, so
/// nothing will ever answer it.
#[tokio::test]
async fn an_agent_that_dies_mid_prompt_fails_the_turn_rather_than_hanging() {
    use atlas_acp_thread::AgentConnection as _;

    let script = r#"
import sys, json, os
def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {
            "protocolVersion": 1, "agentCapabilities": {}, "authMethods": [],
            "agentInfo": {"name": "dying-agent", "version": "9.9.9"}}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": msg["id"], "result": {"sessionId": "session-1"}})
    elif method == "session/prompt":
        sys.stderr.write("agent crashed mid-turn\n")
        sys.stderr.flush()
        os._exit(7)
"#;
    let Some(python) = python() else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    let command = AgentServerCommand {
        path: python,
        args: vec!["-c".to_string(), script.to_string()],
        env: Some(HashMap::new()),
    };

    let connection = Arc::new(connect(command).await.expect("handshake failed"));
    let thread = connection
        .clone()
        .new_session(vec![std::env::temp_dir()])
        .await
        .expect("session/new failed");
    let session_id = thread
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .session_id()
        .clone();

    let result = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        connection.clone().prompt(acp::PromptRequest::new(
            session_id,
            vec![acp::ContentBlock::from("crash please")],
        )),
    )
    .await
    .expect("a dead agent left the prompt pending");

    assert!(
        result.is_err(),
        "an agent that died mid-turn reported success: {result:?}"
    );
}

/// ATL-236 gap 4, aimed at the machinery this change introduced: the cancel
/// deadline is a `watch` channel read from one task and fired from another,
/// and everything else in this suite drives it from a single thread.
///
/// Scope, stated honestly because the obvious reading is wrong: this does NOT
/// prove that a cancel landing between the waiter being taken and the request
/// being written is seen. `prompt(...)` is `spawn`'s argument, so the waiter
/// is taken on this task before the canceller is spawned — that ordering is
/// deterministic and would hold on a current-thread runtime too. What that
/// property actually rests on is the `subscribe()` snapshot, pinned directly
/// in `a_cancel_belongs_to_the_turns_it_interrupted` (tests/units.rs).
///
/// What this adds is real concurrency around the deadline: several tasks
/// firing the signal while another awaits it, on four worker threads.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cancel_racing_the_prompt_is_still_seen() {
    use atlas_acp_thread::AgentConnection as _;

    let Some((connection, session_id, _thread)) = wedged_session().await else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };

    // No sleep between the two: the cancel is meant to land in the window
    // between the prompt being created and its request being written.
    let prompt = tokio::spawn(connection.clone().prompt(acp::PromptRequest::new(
        session_id.clone(),
        vec![acp::ContentBlock::from("race me")],
    )));
    let canceller = tokio::spawn({
        let connection = connection.clone();
        let session_id = session_id.clone();
        async move {
            for _ in 0..3 {
                connection.cancel(&session_id);
                tokio::task::yield_now().await;
            }
        }
    });

    canceller.await.expect("canceller panicked");
    let response = tokio::time::timeout(TEST_CANCEL_GRACE * 10, prompt)
        .await
        .expect("a cancel racing the prompt was dropped, and the turn hung")
        .expect("prompt task panicked")
        .expect("a cancelled turn is a normal stop, not an error");
    assert_eq!(response.stop_reason, acp::StopReason::Cancelled);
}

/// The other half of the stuck start: the agent answers `initialize` and
/// then never answers `session/new`. The fake agent is exactly that — it
/// completes the handshake and sits — so the bind path's own deadline for
/// the hop is what this pins, at its value, with the phase named.
/// The clock is paused only AFTER the handshake: a paused runtime treats
/// waiting on the child's stdout as idle and jumps straight to the initialize
/// deadline, before a real python process can answer. Once connected, the
/// child will never write again, so from there the jump is to the right timer.
#[tokio::test]
async fn an_agent_that_never_answers_session_new_times_out_at_the_deadline() {
    let Some(command) = fake_agent_command(1) else {
        eprintln!("skipping: no python3 on this machine");
        return;
    };
    use atlas_acp_thread::AgentConnection as _;
    let connection = Arc::new(connect(command).await.expect("the handshake completes"));

    tokio::time::pause();
    let started = tokio::time::Instant::now();
    let error = match connection.new_session(vec![std::env::temp_dir()]).await {
        Ok(_) => panic!("a session/new nobody answers must fail, not park the bind"),
        Err(error) => error,
    };
    let elapsed = started.elapsed();

    let load_error = error
        .downcast_ref::<LoadError>()
        .expect("expected a LoadError the manager can carry");
    match load_error {
        LoadError::TimedOut { phase, after, .. } => {
            assert_eq!(
                phase.as_ref(),
                "session/new",
                "the hop that stalled is named"
            );
            assert_eq!(after.to_owned(), REQUEST_TIMEOUT);
        }
        other => panic!("expected TimedOut, got {other:?}"),
    }
    assert!(
        elapsed >= REQUEST_TIMEOUT && elapsed < REQUEST_TIMEOUT * 2,
        "gave up after {elapsed:?}, not at the {REQUEST_TIMEOUT:?} deadline"
    );
}
