//! One scripted [`AgentConnection`] for every crate's tests.
//!
//! Behind the `test-support` feature, which consumers turn on under
//! `[dev-dependencies]` only: a build without it does not compile this file.
//!
//! This is the only test implementation of the trait in the tree, so that a
//! new trait method is one edit here (none, if it has a default body) instead
//! of an edit to every test file that needs a connection. A test that needs
//! something this cannot express extends it here when a second test needs the
//! same thing; until then it wraps this fake rather than writing a fresh
//! `impl AgentConnection`.
//!
//! Two halves over one script:
//!
//! - [`FakeConnection`] is what the code under test holds.
//! - [`FakeHandle`] is what the test holds: it reads back what the connection
//!   was asked to do, and drives it (release a held turn, answer one by hand,
//!   push a `session/update`, end the connection).
//!
//! The handle holds neither a connection nor a thread strongly, so a test can
//! still watch a connection being dropped ([`FakeHandle::live_connections`]).
//! [`FakeHandle::connection`] mints another connection over the same script,
//! which is what a reconnect to the same agent looks like.
//!
//! Capabilities are whatever the builder was told and nothing else. The agent
//! id is a parameter with no meaning to the fake: no behaviour here depends on
//! which agent it claims to be.

use std::any::Any;
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};

use agent_client_protocol::schema::v1 as acp;
use anyhow::{anyhow, Result};
use futures::future::BoxFuture;
use futures::FutureExt;
use tokio::sync::{oneshot, watch, Notify};

use crate::{
    event_channel, AcpThread, AcpThreadEvent, AcpThreadHandle, AgentConnection, AgentId,
    AgentModelCatalogue, AgentModelSelector, AgentSessionConfigOptions, AgentSessionEffort,
    AgentSessionFork, AgentSessionList, AgentSessionListRequest, AgentSessionListResponse,
    EventSink, EventStream,
};

/// Where a session's thread reports, by its agent and session id: the shape
/// of the sink a host hands a connection at connect.
pub type FakeThreadEvents =
    Arc<dyn Fn(&AgentId, &acp::SessionId) -> EventSink<AcpThreadEvent> + Send + Sync>;

/// Runs against a thread the fake has just loaded, before the load answers.
type LoadHook = Arc<dyn Fn(&AcpThreadHandle) + Send + Sync>;

/// One request the connection received, in the order it arrived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FakeCall {
    NewSession,
    LoadSession(String),
    ResumeSession(String),
    CloseSession(String),
    DeleteSession(String),
    /// A prompt, with its content flattened to text.
    Prompt {
        session_id: String,
        text: String,
    },
    Cancel(String),
    Fork(String),
    SetEffort(Option<String>),
}

impl FakeCall {
    /// The trait method this call arrived through.
    pub fn name(&self) -> &'static str {
        match self {
            Self::NewSession => "new_session",
            Self::LoadSession(_) => "load_session",
            Self::ResumeSession(_) => "resume_session",
            Self::CloseSession(_) => "close_session",
            Self::DeleteSession(_) => "delete_session",
            Self::Prompt { .. } => "prompt",
            Self::Cancel(_) => "cancel",
            Self::Fork(_) => "fork",
            Self::SetEffort(_) => "set_effort",
        }
    }
}

/// What a prompt does when no answer was queued for it by hand.
#[derive(Clone)]
enum Turn {
    /// Ends at once with `EndTurn`.
    Ends,
    /// Fails at once with this message.
    Fails(String),
    /// Runs until [`FakeHandle::release_prompt`], or a cancel.
    Held,
}

#[derive(Clone)]
struct Script {
    agent: AgentId,
    version: Option<Arc<str>>,
    session_id: Option<String>,
    new_session_error: Option<String>,
    load: bool,
    resume: bool,
    loads_rebind: bool,
    forgotten: Option<String>,
    on_load: Option<LoadHook>,
    hold_opens: bool,
    hold_authenticate: bool,
    turn: Turn,
    fork: Option<String>,
    effort: bool,
    session_list: bool,
    session_delete: bool,
    model_selector: Option<Arc<dyn AgentModelSelector>>,
    model_catalogue: Option<Arc<dyn AgentModelCatalogue>>,
    config_options: Option<Arc<dyn AgentSessionConfigOptions>>,
}

struct Shared {
    script: Script,
    calls: Mutex<Vec<FakeCall>>,
    live: AtomicUsize,
    sessions_opened: AtomicUsize,
    /// Answers the test delivers by hand, taken in order ahead of the script.
    answers: Mutex<VecDeque<oneshot::Receiver<Result<acp::StopReason>>>>,
    /// A `Notify` because a release that arrives before the turn parks must
    /// still let that turn through: `notify_one` keeps one permit.
    release: Notify,
    release_open: Notify,
    closes: AtomicBool,
    /// Bumped by `cancel_authentication`; a held `authenticate` ends on it.
    auth_cancel: watch::Sender<u64>,
    thread_events: Mutex<Option<FakeThreadEvents>>,
    /// The streams of sessions opened with no sink of the host's, kept so the
    /// thread's sends land somewhere and a test can read them.
    streams: Mutex<HashMap<acp::SessionId, EventStream<AcpThreadEvent>>>,
    /// Weak: a thread owns its connection, and the handle must not keep either
    /// alive.
    threads: Mutex<HashMap<acp::SessionId, Weak<Mutex<AcpThread>>>>,
    exited: watch::Sender<bool>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Shared {
    fn record(&self, call: FakeCall) {
        lock(&self.calls).push(call);
    }
}

// ------------------------------------------------------------------- builder

/// Builds a [`FakeConnection`]. With nothing set it is an agent called
/// `"fake"` that opens a session per `new_session`, ends every turn at once,
/// and advertises no optional capability.
pub struct FakeConnectionBuilder {
    script: Script,
    closes: bool,
}

impl FakeConnectionBuilder {
    /// The id the connection reports. It selects no behaviour.
    pub fn agent(mut self, id: &str) -> Self {
        self.script.agent = AgentId::new(id);
        self
    }

    pub fn version(mut self, version: &str) -> Self {
        self.script.version = Some(version.into());
        self
    }

    /// Every `new_session` answers to this id. Unset, each session gets
    /// `session-<agent>-<n>`.
    pub fn session_id(mut self, id: &str) -> Self {
        self.script.session_id = Some(id.to_string());
        self
    }

    /// `new_session` fails with this message.
    pub fn fail_new_session(mut self, message: &str) -> Self {
        self.script.new_session_error = Some(message.to_string());
        self
    }

    /// Advertise `session/load`. A load answers under the id it was asked for.
    pub fn supports_load(mut self) -> Self {
        self.script.load = true;
        self
    }

    /// Advertise `session/resume`.
    pub fn supports_resume(mut self) -> Self {
        self.script.resume = true;
        self
    }

    /// A load ignores the id it was asked for and answers under the
    /// connection's own [`Self::session_id`]: an agent that no longer knows
    /// the stored session and starts a fresh one in its place.
    pub fn loads_rebind(mut self) -> Self {
        self.script.loads_rebind = true;
        self
    }

    /// Load and resume fail with this message: the agent forgot the session.
    pub fn forgets_sessions(mut self, message: &str) -> Self {
        self.script.forgotten = Some(message.to_string());
        self
    }

    /// Runs on each loaded thread before the load answers, which is where a
    /// real agent replays the conversation.
    pub fn on_load(mut self, hook: impl Fn(&AcpThreadHandle) + Send + Sync + 'static) -> Self {
        self.script.on_load = Some(Arc::new(hook));
        self
    }

    /// Every new, loaded or resumed session stays opening until
    /// [`FakeHandle::release_open`], so a test can act while a bind is in
    /// flight.
    pub fn hold_opens(mut self) -> Self {
        self.script.hold_opens = true;
        self
    }

    /// Every `authenticate` stays in flight until `cancel_authentication`,
    /// and then fails: a sign-in the user has not finished.
    pub fn hold_authenticate(mut self) -> Self {
        self.script.hold_authenticate = true;
        self
    }

    /// Every turn runs until [`FakeHandle::release_prompt`] or a cancel.
    pub fn hold_prompts(mut self) -> Self {
        self.script.turn = Turn::Held;
        self
    }

    /// Every turn fails with this message.
    pub fn fail_prompts(mut self, message: &str) -> Self {
        self.script.turn = Turn::Fails(message.to_string());
        self
    }

    /// Advertise `session/close`. [`FakeHandle::closes`] has what was closed.
    pub fn supports_close(mut self) -> Self {
        self.closes = true;
        self
    }

    /// Advertise fork. Every fork answers with this new session id.
    pub fn supports_fork(mut self, forked_session_id: &str) -> Self {
        self.script.fork = Some(forked_session_id.to_string());
        self
    }

    /// Offer a per-session effort control. [`FakeHandle::efforts`] has every
    /// level it was handed.
    pub fn supports_effort(mut self) -> Self {
        self.script.effort = true;
        self
    }

    /// Advertise `session/list`: an empty list that cannot delete.
    pub fn supports_session_list(mut self) -> Self {
        self.script.session_list = true;
        self
    }

    /// The session list can delete. Without [`Self::supports_session_list`]
    /// there is no list object to ask, as with a real agent.
    pub fn supports_session_delete(mut self) -> Self {
        self.script.session_delete = true;
        self
    }

    pub fn model_selector(mut self, selector: Arc<dyn AgentModelSelector>) -> Self {
        self.script.model_selector = Some(selector);
        self
    }

    pub fn model_catalogue(mut self, catalogue: Arc<dyn AgentModelCatalogue>) -> Self {
        self.script.model_catalogue = Some(catalogue);
        self
    }

    /// Every session's config options are these.
    pub fn config_options(mut self, options: Arc<dyn AgentSessionConfigOptions>) -> Self {
        self.script.config_options = Some(options);
        self
    }

    pub fn build(self) -> (Arc<FakeConnection>, FakeHandle) {
        let handle = self.handle();
        (handle.connection(), handle)
    }

    /// The handle alone, for a test whose connections are minted later (by a
    /// fake server, at connect).
    pub fn handle(self) -> FakeHandle {
        FakeHandle {
            shared: Arc::new(Shared {
                script: self.script,
                calls: Mutex::default(),
                live: AtomicUsize::new(0),
                sessions_opened: AtomicUsize::new(0),
                answers: Mutex::default(),
                release: Notify::new(),
                release_open: Notify::new(),
                closes: AtomicBool::new(self.closes),
                auth_cancel: watch::channel(0).0,
                thread_events: Mutex::default(),
                streams: Mutex::default(),
                threads: Mutex::default(),
                exited: watch::channel(false).0,
            }),
        }
    }
}

// -------------------------------------------------------------------- handle

/// The test's side of a [`FakeConnection`].
#[derive(Clone)]
pub struct FakeHandle {
    shared: Arc<Shared>,
}

impl FakeHandle {
    /// Another connection over the same script and the same recorded state.
    pub fn connection(&self) -> Arc<FakeConnection> {
        self.shared.live.fetch_add(1, Ordering::SeqCst);
        Arc::new(FakeConnection {
            shared: self.shared.clone(),
        })
    }

    pub fn agent_id(&self) -> AgentId {
        self.shared.script.agent.clone()
    }

    // ---------------------------------------------------------- inspection

    pub fn calls(&self) -> Vec<FakeCall> {
        lock(&self.shared.calls).clone()
    }

    /// [`Self::calls`] as the trait method names, in order.
    pub fn call_names(&self) -> Vec<&'static str> {
        self.calls().iter().map(FakeCall::name).collect()
    }

    /// The text of every prompt received, in order.
    pub fn prompts(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .filter_map(|call| match call {
                FakeCall::Prompt { text, .. } => Some(text),
                _ => None,
            })
            .collect()
    }

    pub fn prompts_started(&self) -> usize {
        self.prompts().len()
    }

    pub fn cancels(&self) -> usize {
        self.calls()
            .iter()
            .filter(|call| matches!(call, FakeCall::Cancel(_)))
            .count()
    }

    /// Every session id the connection was asked to close, in order.
    pub fn closes(&self) -> Vec<String> {
        self.calls()
            .into_iter()
            .filter_map(|call| match call {
                FakeCall::CloseSession(id) => Some(id),
                _ => None,
            })
            .collect()
    }

    /// Every effort level a session's control was handed, in order.
    pub fn efforts(&self) -> Vec<Option<String>> {
        self.calls()
            .into_iter()
            .filter_map(|call| match call {
                FakeCall::SetEffort(level) => Some(level),
                _ => None,
            })
            .collect()
    }

    /// Connections handed out and not yet dropped.
    pub fn live_connections(&self) -> usize {
        self.shared.live.load(Ordering::SeqCst)
    }

    /// The thread of a session this fake opened, while something still holds
    /// it.
    pub fn thread(&self, session_id: &acp::SessionId) -> Option<AcpThreadHandle> {
        lock(&self.shared.threads).get(session_id)?.upgrade()
    }

    /// Everything a session's thread has announced since the last call. Empty
    /// for a session that reports to a host's sink
    /// ([`Self::set_thread_events`]): those events went to the host.
    pub fn drain_events(&self, session_id: &acp::SessionId) -> Vec<AcpThreadEvent> {
        let mut streams = lock(&self.shared.streams);
        let Some(stream) = streams.get_mut(session_id) else {
            return Vec::new();
        };
        let mut drained = Vec::new();
        while let Ok(event) = stream.try_recv() {
            drained.push(event);
        }
        drained
    }

    // ------------------------------------------------------------- driving

    /// Let one held turn end. Kept if no turn is parked yet, so a release
    /// cannot lose the race with the turn it is for.
    pub fn release_prompt(&self) {
        self.shared.release.notify_one();
    }

    /// Let one held open finish: the one parked longest. Kept if none is
    /// parked yet.
    pub fn release_open(&self) {
        self.shared.release_open.notify_one();
    }

    /// Let the most recently held open finish, ahead of the ones parked
    /// before it: an agent answering two opens out of order.
    pub fn release_newest_open(&self) {
        self.shared.release_open.notify_last();
    }

    /// Queue an answer the test delivers by hand: the returned sender ends the
    /// prompt it is paired with, in queue order, whatever the script says.
    pub fn queue_prompt(&self) -> oneshot::Sender<Result<acp::StopReason>> {
        let (tx, rx) = oneshot::channel();
        lock(&self.shared.answers).push_back(rx);
        tx
    }

    /// Deliver a `session/update` to a session's thread, as the agent would.
    pub fn push_update(
        &self,
        session_id: &acp::SessionId,
        update: acp::SessionUpdate,
    ) -> Result<()> {
        let thread = self
            .thread(session_id)
            .ok_or_else(|| anyhow!("the fake has no open session {session_id}"))?;
        let outcome = lock(&thread).handle_session_update(update);
        outcome.map_err(|error| anyhow!("the thread refused the update: {error}"))
    }

    /// The agent's process is gone: every connection's `exited` resolves.
    pub fn drop_connection(&self) {
        self.shared.exited.send_replace(true);
    }

    /// Start advertising `session/close`, on live connections too.
    pub fn advertise_close(&self) {
        self.shared.closes.store(true, Ordering::SeqCst);
    }

    /// Report sessions opened from now on to this sink instead of keeping
    /// their streams: what a fake server does with the sink a host hands it
    /// at connect.
    pub fn set_thread_events(&self, events: FakeThreadEvents) {
        *lock(&self.shared.thread_events) = Some(events);
    }
}

// ---------------------------------------------------------------- connection

/// The scripted connection. Built by [`FakeConnection::builder`].
pub struct FakeConnection {
    shared: Arc<Shared>,
}

impl FakeConnection {
    pub fn builder() -> FakeConnectionBuilder {
        FakeConnectionBuilder {
            script: Script {
                agent: AgentId::new("fake"),
                version: None,
                session_id: None,
                new_session_error: None,
                load: false,
                resume: false,
                loads_rebind: false,
                forgotten: None,
                on_load: None,
                hold_opens: false,
                hold_authenticate: false,
                turn: Turn::Ends,
                fork: None,
                effort: false,
                session_list: false,
                session_delete: false,
                model_selector: None,
                config_options: None,
                model_catalogue: None,
            },
            closes: false,
        }
    }

    /// A thread on this connection that no request opened, for a test that
    /// drives the thread itself. Reports where any other session would.
    pub fn open_thread(
        self: &Arc<Self>,
        session_id: acp::SessionId,
        work_dirs: Vec<PathBuf>,
    ) -> AcpThreadHandle {
        let sink = match lock(&self.shared.thread_events).clone() {
            Some(events) => events(&self.agent_id(), &session_id),
            None => {
                let (sink, stream) = event_channel();
                lock(&self.shared.streams).insert(session_id.clone(), stream);
                sink
            }
        };
        let thread: AcpThreadHandle = Arc::new(Mutex::new(AcpThread::new(
            session_id.clone(),
            self.clone() as Arc<dyn AgentConnection>,
            work_dirs,
            None,
            sink,
        )));
        lock(&self.shared.threads).insert(session_id, Arc::downgrade(&thread));
        thread
    }

    /// Opens a session's thread once any scripted hold lets it through. The
    /// thread is made after the hold, as a real agent's answer would be.
    fn open(
        self: Arc<Self>,
        session_id: acp::SessionId,
        work_dirs: Vec<PathBuf>,
        loaded: bool,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        async move {
            if self.shared.script.hold_opens {
                self.shared.release_open.notified().await;
            }
            let thread = self.open_thread(session_id, work_dirs);
            if let (true, Some(hook)) = (loaded, &self.shared.script.on_load) {
                hook(&thread);
            }
            Ok(thread)
        }
        .boxed()
    }

    fn new_session_id(&self) -> acp::SessionId {
        let nth = self.shared.sessions_opened.fetch_add(1, Ordering::SeqCst);
        match &self.shared.script.session_id {
            Some(fixed) => acp::SessionId::new(fixed.clone()),
            None => acp::SessionId::new(format!("session-{}-{nth}", self.shared.script.agent)),
        }
    }
}

impl Drop for FakeConnection {
    fn drop(&mut self) {
        self.shared.live.fetch_sub(1, Ordering::SeqCst);
    }
}

impl AgentConnection for FakeConnection {
    fn agent_id(&self) -> AgentId {
        self.shared.script.agent.clone()
    }

    fn telemetry_id(&self) -> Arc<str> {
        self.shared.script.agent.0.clone()
    }

    fn agent_version(&self) -> Option<Arc<str>> {
        self.shared.script.version.clone()
    }

    fn new_session(
        self: Arc<Self>,
        work_dirs: Vec<PathBuf>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        self.shared.record(FakeCall::NewSession);
        if let Some(message) = self.shared.script.new_session_error.clone() {
            return async move { Err(anyhow!(message)) }.boxed();
        }
        let session_id = self.new_session_id();
        self.open(session_id, work_dirs, false)
    }

    fn exited(self: Arc<Self>) -> BoxFuture<'static, ()> {
        let mut exited = self.shared.exited.subscribe();
        async move {
            // An error means the script itself is gone, which is not an exit.
            if exited.wait_for(|gone| *gone).await.is_err() {
                std::future::pending::<()>().await;
            }
        }
        .boxed()
    }

    fn supports_load_session(&self) -> bool {
        self.shared.script.load
    }

    fn load_session(
        self: Arc<Self>,
        session_id: acp::SessionId,
        work_dirs: Vec<PathBuf>,
        _title: Option<Arc<str>>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        self.shared
            .record(FakeCall::LoadSession(session_id.to_string()));
        if let Some(message) = self.shared.script.forgotten.clone() {
            return async move { Err(anyhow!(message)) }.boxed();
        }
        let session_id = if self.shared.script.loads_rebind {
            self.new_session_id()
        } else {
            session_id
        };
        self.open(session_id, work_dirs, true)
    }

    fn supports_close_session(&self) -> bool {
        self.shared.closes.load(Ordering::SeqCst)
    }

    fn close_session(
        self: Arc<Self>,
        session_id: acp::SessionId,
    ) -> BoxFuture<'static, Result<()>> {
        if !self.supports_close_session() {
            return async { Err(anyhow!("Closing sessions is not supported")) }.boxed();
        }
        self.shared
            .record(FakeCall::CloseSession(session_id.to_string()));
        async { Ok(()) }.boxed()
    }

    fn supports_resume_session(&self) -> bool {
        self.shared.script.resume
    }

    fn resume_session(
        self: Arc<Self>,
        session_id: acp::SessionId,
        work_dirs: Vec<PathBuf>,
        _title: Option<Arc<str>>,
    ) -> BoxFuture<'static, Result<AcpThreadHandle>> {
        self.shared
            .record(FakeCall::ResumeSession(session_id.to_string()));
        if let Some(message) = self.shared.script.forgotten.clone() {
            return async move { Err(anyhow!(message)) }.boxed();
        }
        self.open(session_id, work_dirs, false)
    }

    fn auth_methods(&self) -> &[acp::AuthMethod] {
        &[]
    }

    fn authenticate(&self, _method: acp::AuthMethodId) -> BoxFuture<'static, Result<()>> {
        if !self.shared.script.hold_authenticate {
            return async { Ok(()) }.boxed();
        }
        let mut cancelled = self.shared.auth_cancel.subscribe();
        cancelled.mark_unchanged();
        async move {
            let _ = cancelled.changed().await;
            Err(anyhow!("the sign-in was cancelled"))
        }
        .boxed()
    }

    fn cancel_authentication(&self) {
        self.shared
            .auth_cancel
            .send_modify(|generation| *generation += 1);
    }

    fn prompt(
        &self,
        params: acp::PromptRequest,
    ) -> BoxFuture<'static, Result<acp::PromptResponse>> {
        self.shared.record(FakeCall::Prompt {
            session_id: params.session_id.to_string(),
            text: crate::prompt::flatten_text(&params.prompt),
        });
        let answer = lock(&self.shared.answers).pop_front();
        let shared = self.shared.clone();
        async move {
            if let Some(answer) = answer {
                return match answer.await {
                    Ok(result) => result.map(acp::PromptResponse::new),
                    Err(_) => Err(anyhow!("the test dropped this turn's answer")),
                };
            }
            match &shared.script.turn {
                Turn::Ends => {}
                Turn::Fails(message) => return Err(anyhow!(message.clone())),
                Turn::Held => shared.release.notified().await,
            }
            Ok(acp::PromptResponse::new(acp::StopReason::EndTurn))
        }
        .boxed()
    }

    fn cancel(&self, session_id: &acp::SessionId) {
        self.shared.record(FakeCall::Cancel(session_id.to_string()));
        if matches!(self.shared.script.turn, Turn::Held) {
            self.shared.release.notify_one();
        }
    }

    fn model_selector(&self, _session_id: &acp::SessionId) -> Option<Arc<dyn AgentModelSelector>> {
        self.shared.script.model_selector.clone()
    }

    fn session_config_options(
        &self,
        _session_id: &acp::SessionId,
    ) -> Option<Arc<dyn AgentSessionConfigOptions>> {
        self.shared.script.config_options.clone()
    }

    fn session_list(&self) -> Option<Arc<dyn AgentSessionList>> {
        self.shared.script.session_list.then(|| {
            Arc::new(FakeSessionList {
                shared: self.shared.clone(),
            }) as Arc<dyn AgentSessionList>
        })
    }

    fn supports_fork(&self) -> bool {
        self.shared.script.fork.is_some()
    }

    fn fork(&self, session_id: &acp::SessionId) -> Option<Arc<dyn AgentSessionFork>> {
        let forked = self.shared.script.fork.clone()?;
        Some(Arc::new(FakeFork {
            shared: self.shared.clone(),
            from: session_id.to_string(),
            forked,
        }))
    }

    fn session_effort(&self, _session_id: &acp::SessionId) -> Option<Arc<dyn AgentSessionEffort>> {
        self.shared.script.effort.then(|| {
            Arc::new(FakeEffort {
                shared: self.shared.clone(),
            }) as Arc<dyn AgentSessionEffort>
        })
    }

    fn model_catalogue(&self) -> Option<Arc<dyn AgentModelCatalogue>> {
        self.shared.script.model_catalogue.clone()
    }
}

// -------------------------------------------------------------- capabilities

struct FakeSessionList {
    shared: Arc<Shared>,
}

impl AgentSessionList for FakeSessionList {
    fn list_sessions(
        &self,
        _request: AgentSessionListRequest,
    ) -> BoxFuture<'static, Result<AgentSessionListResponse>> {
        async { Ok(AgentSessionListResponse::new(Vec::new())) }.boxed()
    }

    fn supports_delete(&self) -> bool {
        self.shared.script.session_delete
    }

    fn delete_session(&self, session_id: &acp::SessionId) -> BoxFuture<'static, Result<()>> {
        self.shared
            .record(FakeCall::DeleteSession(session_id.to_string()));
        async { Ok(()) }.boxed()
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn Any + Send + Sync> {
        self
    }
}

struct FakeFork {
    shared: Arc<Shared>,
    from: String,
    forked: String,
}

impl AgentSessionFork for FakeFork {
    fn run(&self) -> BoxFuture<'static, Result<acp::SessionId>> {
        self.shared.record(FakeCall::Fork(self.from.clone()));
        let forked = acp::SessionId::new(self.forked.clone());
        async move { Ok(forked) }.boxed()
    }
}

struct FakeEffort {
    shared: Arc<Shared>,
}

impl AgentSessionEffort for FakeEffort {
    fn set_effort(&self, level: Option<String>) -> Result<()> {
        self.shared.record(FakeCall::SetEffort(level));
        Ok(())
    }
}
