//! A scripted ACP agent: a scenario written in Rust, played by a real child
//! process over real pipes.
//!
//! ```ignore
//! let scenario = Scenario::new("slow_cancel").on(
//!     "session/prompt",
//!     Script::new()
//!         .agent_text("Working on it.")
//!         .wait_for("session/cancel")
//!         .repeat_for(Duration::from_secs(2), Duration::from_millis(100),
//!                     Script::new().agent_text(" still going"))
//!         .stop("cancelled"),
//! );
//! let Some(agent) = ScriptedAgent::new(&scenario) else { return }; // no python3
//! let connection = agent.connect().await?;
//! ```
//!
//! A [`Scenario`] is what the agent advertises at `initialize` and what it does
//! for each method the client calls; a [`Script`] is the "what it does", step
//! by step: `session/update`s, requests back to the client (whose answers the
//! script can refer to later), the response, pauses, raw bytes on stdout or
//! stderr. A method the scenario does not script gets a default: `initialize`
//! answers with the advertised capabilities, `session/new` with the scenario's
//! session id, `session/prompt` with `end_turn`, and every other request with
//! "method not found", as from an agent that does not implement it.
//!
//! Strings in a script may name values the agent only learns while it runs:
//! `${sessionId}` is the session the triggering request is about,
//! `${params.…}` is a field of that request (`${params.prompt.0}` is the first
//! prompt block), `${<name>.…}` is a field of the client's answer to a request
//! saved as `<name>`, and `${n}` counts the turns of a [`Script::repeat_for`].
//! A string that is nothing but one `${…}` is replaced by the value itself,
//! whatever its type; inside a longer string the value is spliced in as text.
//!
//! What the agent saw is read back from its log: [`ScriptedAgent::received`],
//! [`ScriptedAgent::requests`], [`ScriptedAgent::answers`],
//! [`ScriptedAgent::notes`].
//!
//! The player is `scripted_agent.py`, under `python3 -I`, the interpreter the
//! hand-written fakes in this crate's `tests/connect.rs` already need. Without
//! python3 [`ScriptedAgent::new`] answers `None` and the test skips — except
//! under CI, where that would report green having run nothing, so it panics.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use atlas_acp_thread::{
    event_channel, AcpThreadEvent, AgentId, ElicitationStoreEvent, EventStream,
};
use serde_json::{json, Map, Value};

use crate::connection::{
    AcpConnection, AcpConnectionDefaults, AgentServerCommand, RequestElicitationSink,
    ThreadEventSink,
};

/// The player, run with `python3 -I -c`.
const PLAYER: &str = include_str!("scripted_agent.py");

/// What one scripted agent advertises and does. See the module docs.
#[derive(Debug, Clone)]
pub struct Scenario {
    name: String,
    initialize: Value,
    session_id: String,
    new_session: Map<String, Value>,
    on: Map<String, Value>,
}

impl Scenario {
    /// An agent that speaks protocol v1, advertises no capabilities and no
    /// auth methods, and answers every method with its default. `name` is its
    /// `agentInfo.name`, and the id [`ScriptedAgent::connect`] knows it by.
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            initialize: json!({
                "protocolVersion": 1,
                "agentCapabilities": {},
                "authMethods": [],
                "agentInfo": { "name": name, "version": "1.0.0" },
            }),
            session_id: "session-1".to_string(),
            new_session: Map::new(),
            on: Map::new(),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// The session id the default `session/new` answers with.
    pub fn session_id_of_new_sessions(&self) -> &str {
        &self.session_id
    }

    pub fn protocol_version(mut self, version: u16) -> Self {
        self.initialize["protocolVersion"] = json!(version);
        self
    }

    /// The `agentCapabilities` of the `initialize` answer, whole.
    pub fn capabilities(mut self, capabilities: Value) -> Self {
        self.initialize["agentCapabilities"] = capabilities;
        self
    }

    /// The `authMethods` of the `initialize` answer, whole.
    pub fn auth_methods(mut self, methods: Value) -> Self {
        self.initialize["authMethods"] = methods;
        self
    }

    /// The session id the default `session/new` answers with
    /// (`"session-1"` unless set).
    pub fn session_id(mut self, id: &str) -> Self {
        self.session_id = id.to_string();
        self
    }

    /// More fields for the default `session/new` answer — `modes`,
    /// `configOptions` — merged beside its `sessionId`.
    pub fn new_session_fields(mut self, fields: Value) -> Self {
        if let Value::Object(fields) = fields {
            self.new_session.extend(fields);
        }
        self
    }

    /// What the agent does on every call of `method`.
    pub fn on(mut self, method: &str, script: Script) -> Self {
        self.on
            .insert(method.to_string(), Value::Array(script.steps));
        self
    }

    /// What the agent does on each call of `method` in turn: the first script
    /// for the first call, and so on, the last one for every call after.
    pub fn on_calls(mut self, method: &str, scripts: Vec<Script>) -> Self {
        let calls: Vec<Value> = scripts
            .into_iter()
            .map(|script| Value::Array(script.steps))
            .collect();
        self.on
            .insert(method.to_string(), json!({ "calls": calls }));
        self
    }

    /// Answer every call of `method` with `result`.
    pub fn answer(self, method: &str, result: Value) -> Self {
        self.on(method, Script::new().respond(result))
    }

    /// The scenario as the player reads it.
    pub fn to_json(&self) -> Value {
        json!({
            "name": self.name,
            "initialize": self.initialize,
            "session_id": self.session_id,
            "new_session": self.new_session,
            "on": self.on,
        })
    }
}

/// What the agent does for one call, in order. See the module docs.
#[derive(Debug, Clone, Default)]
pub struct Script {
    steps: Vec<Value>,
}

impl Script {
    pub fn new() -> Self {
        Self::default()
    }

    fn step(mut self, step: Value) -> Self {
        self.steps.push(step);
        self
    }

    /// A `session/update` for the session the call is about.
    pub fn update(self, update: Value) -> Self {
        self.step(json!({ "update": update }))
    }

    /// A `session/update` for a session other than the one the call is about.
    pub fn update_session(self, session_id: &str, update: Value) -> Self {
        self.step(json!({ "update": update, "session": session_id }))
    }

    /// An `agent_message_chunk` of text, with no `messageId`.
    pub fn agent_text(self, text: &str) -> Self {
        self.update(json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": text },
        }))
    }

    /// An `agent_message_chunk` of text belonging to message `message_id`.
    pub fn agent_text_in(self, message_id: &str, text: &str) -> Self {
        self.update(json!({
            "sessionUpdate": "agent_message_chunk",
            "messageId": message_id,
            "content": { "type": "text", "text": text },
        }))
    }

    /// A request to the client — `session/request_permission`, `fs/*`,
    /// `terminal/*` — waited on. The answer is saved as `save_as`, so later
    /// steps can name its fields (`${save_as.terminalId}`); an error answer is
    /// saved whole, under `error`.
    pub fn request(self, method: &str, params: Value, save_as: &str) -> Self {
        self.step(json!({
            "request": { "method": method, "params": params },
            "save": save_as,
        }))
    }

    /// Any message, written as given (`jsonrpc` is filled in).
    pub fn send(self, message: Value) -> Self {
        self.step(json!({ "send": message }))
    }

    /// Answer the call with `result`.
    pub fn respond(self, result: Value) -> Self {
        self.step(json!({ "respond": result }))
    }

    /// Answer the call with a JSON-RPC error.
    pub fn respond_error(self, code: i64, message: &str) -> Self {
        self.step(json!({ "respond_error": { "code": code, "message": message } }))
    }

    /// Answer a `session/prompt` with this stop reason.
    pub fn stop(self, reason: &str) -> Self {
        self.respond(json!({ "stopReason": reason }))
    }

    /// Answer a `session/prompt` with `end_turn`.
    pub fn end_turn(self) -> Self {
        self.stop("end_turn")
    }

    pub fn sleep(self, duration: Duration) -> Self {
        self.step(json!({ "sleep_ms": duration.as_millis() as u64 }))
    }

    /// Park until the client sends `method` (a request or a notification)
    /// after the call this script is running for began.
    pub fn wait_for(self, method: &str) -> Self {
        self.step(json!({ "wait_for": method }))
    }

    /// Run `script` every `every` until `total` has passed. `${n}` in it is
    /// the round, from 0.
    pub fn repeat_for(self, total: Duration, every: Duration, script: Script) -> Self {
        self.step(json!({
            "repeat": script.steps,
            "for_ms": total.as_millis() as u64,
            "every_ms": every.as_millis() as u64,
        }))
    }

    /// Write every message (and raw stdout bytes) of `script` in ONE write,
    /// so the client reads them out of the pipe together.
    pub fn in_one_write(self, script: Script) -> Self {
        self.step(json!({ "together": script.steps }))
    }

    /// Raw bytes on stdout, as they are — a line that is not JSON, or not
    /// UTF-8. Ends no line by itself.
    pub fn stdout_bytes(self, bytes: &[u8]) -> Self {
        self.step(json!({ "stdout_hex": hex(bytes) }))
    }

    /// One line of text on stderr.
    pub fn stderr_line(self, text: &str) -> Self {
        self.step(json!({ "stderr": text }))
    }

    /// Raw bytes on stderr. Ends no line by itself.
    pub fn stderr_bytes(self, bytes: &[u8]) -> Self {
        self.step(json!({ "stderr_hex": hex(bytes) }))
    }

    /// Close stdout and carry on living: the transport is dead, the process
    /// is not.
    pub fn close_stdout(self) -> Self {
        self.step(json!({ "close_stdout": true }))
    }

    /// A marker in the agent's log, to tell where a script had got to.
    pub fn mark(self, label: &str) -> Self {
        self.step(json!({ "mark": label }))
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// One scenario, ready to be spawned, and what it saw once it was.
///
/// Nothing runs until a client spawns [`Self::command`] — through
/// [`Self::connect`], or through a manager whose catalog resolves the agent to
/// it. Each spawn plays the scenario afresh and appends to the same log.
///
/// Its files live in a temporary directory removed on drop, unless the test is
/// panicking: then the directory is kept and its path printed, so the wire log
/// of a failed run can be read.
pub struct ScriptedAgent {
    name: String,
    dir: PathBuf,
    log: PathBuf,
    command: AgentServerCommand,
}

impl ScriptedAgent {
    /// `None` when there is no python3 to play it with.
    pub fn new(scenario: &Scenario) -> Option<Self> {
        let python = python()?;
        let dir = std::env::temp_dir().join(format!(
            "atlas-scripted-agent-{}-{}",
            scenario.name,
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).expect("create the scripted agent's directory");
        let scenario_file = dir.join("scenario.json");
        let json = serde_json::to_vec_pretty(&scenario.to_json()).expect("a scenario is JSON");
        std::fs::write(&scenario_file, json).expect("write the scenario");
        let log = dir.join("wire.jsonl");
        let command = AgentServerCommand {
            path: python,
            args: vec![
                "-I".to_string(),
                "-c".to_string(),
                PLAYER.to_string(),
                scenario_file.display().to_string(),
                log.display().to_string(),
            ],
            env: Some(HashMap::new()),
        };
        Some(Self {
            name: scenario.name.clone(),
            dir,
            log,
            command,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    /// The command that plays the scenario, as a catalog would resolve it.
    pub fn command(&self) -> AgentServerCommand {
        self.command.clone()
    }

    /// The agent's log: one JSON object per line (see `scripted_agent.py`).
    pub fn log_path(&self) -> &Path {
        &self.log
    }

    /// Every entry in the log so far, oldest first.
    pub fn log(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            // The last line can be half-written while the agent runs.
            .filter_map(|line| serde_json::from_str(line).ok())
            .collect()
    }

    /// Every message the client sent, in the order the agent read them.
    pub fn received(&self) -> Vec<Value> {
        self.log()
            .into_iter()
            .filter_map(|mut entry| entry.get_mut("in").map(Value::take))
            .collect()
    }

    /// The methods of every request and notification the client sent, in
    /// order.
    pub fn received_methods(&self) -> Vec<String> {
        self.received()
            .iter()
            .filter_map(|message| message["method"].as_str().map(str::to_string))
            .collect()
    }

    /// The `params` of every request or notification of `method` the client
    /// sent, in order.
    pub fn requests(&self, method: &str) -> Vec<Value> {
        self.received()
            .into_iter()
            .filter(|message| message["method"] == method)
            .map(|mut message| message["params"].take())
            .collect()
    }

    /// The client's answers (`{"result": …}` or `{"error": …}`, whole) to
    /// every request of `method` the agent made, in order.
    pub fn answers(&self, method: &str) -> Vec<Value> {
        self.log()
            .into_iter()
            .filter_map(|mut entry| entry.get_mut("answer").map(Value::take))
            .filter(|answer| answer["method"] == method)
            .map(|mut answer| answer["response"].take())
            .collect()
    }

    /// What went wrong inside the agent: a stderr write that failed, a script
    /// step that could not run, a request nobody answered.
    pub fn notes(&self) -> Vec<Value> {
        self.log()
            .into_iter()
            .filter(|entry| entry.get("note").is_some())
            .collect()
    }

    /// Waits until the client has sent `method`, and answers its params.
    pub async fn wait_for_request(&self, method: &str, timeout: Duration) -> Option<Value> {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if let Some(params) = self.requests(method).into_iter().next() {
                return Some(params);
            }
            if tokio::time::Instant::now() >= deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Spawn the agent and complete the handshake, its thread events kept but
    /// read by nobody.
    pub async fn connect(&self) -> anyhow::Result<AcpConnection> {
        self.connect_with(kept_thread_events()).await
    }

    /// Spawn the agent and complete the handshake, its sessions' thread events
    /// going to `thread_events` — a projector's, say.
    pub async fn connect_with(
        &self,
        thread_events: ThreadEventSink,
    ) -> anyhow::Result<AcpConnection> {
        AcpConnection::stdio(
            AgentId::new(self.name.as_str()),
            self.command(),
            None,
            AcpConnectionDefaults::default(),
            thread_events,
            kept_elicitation_events(),
            "atlas-test",
            "0.0.0-test".to_string(),
        )
        .await
    }
}

impl Drop for ScriptedAgent {
    fn drop(&mut self) {
        if std::thread::panicking() {
            eprintln!(
                "scripted agent `{}`: wire log kept at {}",
                self.name,
                self.log.display()
            );
            return;
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// A thread-event sink whose receivers live as long as the sink, so a send
/// never fails for a reason unrelated to the test.
pub fn kept_thread_events() -> ThreadEventSink {
    let kept: Arc<Mutex<Vec<EventStream<AcpThreadEvent>>>> = Arc::default();
    Arc::new(move |_agent, _session_id| {
        let (tx, rx) = event_channel();
        kept.lock().unwrap_or_else(PoisonError::into_inner).push(rx);
        tx
    })
}

fn kept_elicitation_events() -> RequestElicitationSink {
    let kept: Arc<Mutex<Vec<EventStream<ElicitationStoreEvent>>>> = Arc::default();
    Arc::new(move |_agent_id| {
        let (tx, rx) = event_channel();
        kept.lock().unwrap_or_else(PoisonError::into_inner).push(rx);
        tx
    })
}

/// `python3` from `PATH`, else from the usual install locations; `None` means
/// the scripted-agent tests skip.
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
