//! Bringing a stored session back, and letting an agent forget one.
//!
//! Every test here drives a fake connection that advertises a chosen subset of
//! the session capabilities. That is the point: which of `session/load`,
//! `session/resume` and `session/delete` an agent gets is decided by what it
//! advertised at `initialize` and by nothing else — there is no agent name in
//! this file, and there must never be one.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use anyhow::{anyhow, Result};
use atlas_acp_thread::test_support::{FakeConnection, FakeHandle};
use atlas_acp_thread::{AgentConnection, AgentId};
use atlas_agent_manager::{Agent, AgentCatalog, AgentManager, ResumeMode};
use atlas_agent_servers::{
    AcpConnectionDefaults, AgentServer, AgentServerCommand, AgentServerDelegate, ConnectOptions,
    ExternalAgentServer, ThreadEventSink,
};
use futures::future::BoxFuture;
use futures::FutureExt;
use tokio::sync::watch;

/// What an agent said it could do at `initialize`.
#[derive(Clone, Copy, Default)]
struct Capabilities {
    /// `agentCapabilities.loadSession` — a top-level bool in this schema.
    load: bool,
    /// `sessionCapabilities.resume` — a presence marker.
    resume: bool,
    /// `sessionCapabilities.list` — a presence marker. Without it there is no
    /// session-list object at all, and so no delete either.
    list: bool,
    /// `sessionCapabilities.delete` — a presence marker under the list object.
    delete: bool,
}

impl Capabilities {
    fn load() -> Self {
        Self {
            load: true,
            ..Self::default()
        }
    }
    fn resume() -> Self {
        Self {
            resume: true,
            ..Self::default()
        }
    }
    fn neither() -> Self {
        Self::default()
    }
}

// ---------------------------------------------------------------- harness

/// Hands out connections over one script, so every connect answers to the
/// same recorded calls.
struct FakeServer {
    fake: FakeHandle,
    spawns: Arc<AtomicUsize>,
}

/// The connection an agent with these capabilities presents.
///
/// `forgets_sessions`: load and resume fail, an agent that no longer knows the
/// session. `replays_history`: whether `session/load` actually replays the
/// conversation into the thread. The protocol requires it before the load
/// answers, so replaying is the realistic default; `Harness::silent` is the
/// agent that does not, which ATL-230 finding 3 is about.
fn scripted(
    id: &AgentId,
    capabilities: Capabilities,
    forgets_sessions: bool,
    replays_history: bool,
) -> FakeHandle {
    let mut fake = FakeConnection::builder()
        .agent(id.as_str())
        .session_id("fresh");
    if capabilities.load {
        fake = fake.supports_load();
    }
    if capabilities.resume {
        fake = fake.supports_resume();
    }
    // Exactly the real gate: no `list` capability, no list object — and so no
    // delete, whatever `delete` says.
    if capabilities.list {
        fake = fake.supports_session_list();
    }
    if capabilities.delete {
        fake = fake.supports_session_delete();
    }
    if forgets_sessions {
        fake = fake.forgets_sessions("no conversation found with that id");
    }
    if replays_history {
        fake = fake.on_load(|thread| {
            thread.lock().unwrap().push_user_content_block(
                None,
                acp::ContentBlock::Text(acp::TextContent::new("what we said before".to_string())),
            );
        });
    }
    fake.handle()
}

impl AgentServer for FakeServer {
    fn agent_id(&self) -> AgentId {
        self.fake.agent_id()
    }

    fn connect(
        &self,
        _delegate: AgentServerDelegate,
        _options: ConnectOptions,
    ) -> BoxFuture<'static, Result<Arc<dyn AgentConnection>>> {
        self.spawns.fetch_add(1, Ordering::SeqCst);
        let connection = self.fake.connection();
        async move { Ok(connection as Arc<dyn AgentConnection>) }.boxed()
    }

    fn into_any(self: Arc<Self>) -> Arc<dyn std::any::Any + Send + Sync> {
        self
    }
}

struct FakeCatalog(AgentId);

impl AgentCatalog for FakeCatalog {
    fn external_agents(&self) -> Vec<AgentId> {
        vec![self.0.clone()]
    }
    fn agent_server(&self, _id: &AgentId) -> Option<Arc<dyn ExternalAgentServer>> {
        Some(Arc::new(FakeResolver))
    }
    fn default_mode(&self, _id: &AgentId) -> Option<acp::SessionModeId> {
        None
    }
    fn watch_new_version(&self, _id: &AgentId) -> Option<watch::Receiver<Option<String>>> {
        None
    }
    fn watch_loading_status(&self, _id: &AgentId) -> Option<watch::Receiver<Option<String>>> {
        None
    }
    fn updates(&self) -> watch::Receiver<u64> {
        watch::channel(0).1
    }
}

struct FakeResolver;

impl ExternalAgentServer for FakeResolver {
    fn get_command(
        &self,
        _extra_args: Vec<String>,
        _extra_env: HashMap<String, String>,
    ) -> BoxFuture<'static, Result<AgentServerCommand>> {
        async { Err(anyhow!("this test never spawns a process")) }.boxed()
    }
}

struct Harness {
    manager: Arc<AgentManager>,
    agent: Agent,
    fake: FakeHandle,
    spawns: Arc<AtomicUsize>,
}

impl Harness {
    fn new(capabilities: Capabilities) -> Self {
        Self::with(capabilities, false, true)
    }

    /// An agent that has forgotten whatever session it is asked for.
    fn forgetful(capabilities: Capabilities) -> Self {
        Self::with(capabilities, true, true)
    }

    /// An agent that advertises `loadSession`, answers the load, and replays
    /// nothing — a spec violation real agents have shipped.
    fn silent(capabilities: Capabilities) -> Self {
        Self::with(capabilities, false, false)
    }

    fn with(capabilities: Capabilities, forgets_sessions: bool, replays_history: bool) -> Self {
        let id = AgentId::new("some-agent");
        let fake = scripted(&id, capabilities, forgets_sessions, replays_history);
        let spawns = Arc::new(AtomicUsize::new(0));
        let server = Arc::new(FakeServer {
            fake: fake.clone(),
            spawns: spawns.clone(),
        });
        let thread_events: ThreadEventSink =
            Arc::new(|_agent, _session_id| atlas_acp_thread::event_channel().0);
        let manager = AgentManager::new(
            Arc::new(FakeCatalog(id)),
            server,
            ConnectOptions {
                root_dir: None,
                defaults: AcpConnectionDefaults::default(),
                thread_events,
                request_elicitation_events: Arc::new(|_agent_id| {
                    atlas_acp_thread::event_channel().0
                }),
                session_mcp: None,
                client_name: "atlas-test",
                client_version: "0.0.0".to_string(),
            },
        );
        Self {
            manager,
            agent: Agent::Native,
            fake,
            spawns,
        }
    }

    async fn resume(&self) -> Result<ResumeMode> {
        self.manager
            .resume_stored_session(
                self.agent.clone(),
                acp::SessionId::new("ses-1"),
                vec![PathBuf::from("/tmp/atlas")],
                None,
            )
            .await
            .map(|resumed| resumed.mode)
    }

    fn calls(&self) -> Vec<&'static str> {
        self.fake.call_names()
    }
}

// ------------------------------------------------------------------- tests

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_that_can_load_replays_the_conversation() {
    let harness = Harness::new(Capabilities::load());

    assert_eq!(harness.resume().await.unwrap(), ResumeMode::Replayed);
    assert_eq!(harness.calls(), vec!["load_session"]);
}

/// Pins the known-weak half of `ResumeMode`, so the next reader finds the
/// reasoning rather than the surprise.
///
/// An agent that advertises `loadSession` and replays nothing is still reported
/// as `Replayed`, because the mode restates the capability instead of observing
/// the replay (ATL-230 finding 3). Deriving it from the thread's entries was
/// tried and reverted: for an external agent the replay frames are still queued
/// on the connection's dispatch task when `load_session` answers, so an empty
/// thread does not mean an empty replay, and the check told users their history
/// was gone on conversations that had it. See the comment at the call site in
/// `resume_stored_session` for what a correct signal would take.
#[tokio::test(flavor = "multi_thread")]
async fn an_agent_that_replays_nothing_is_still_reported_as_replayed() {
    let harness = Harness::silent(Capabilities::load());

    assert_eq!(harness.resume().await.unwrap(), ResumeMode::Replayed);
    assert_eq!(
        harness.calls(),
        vec!["load_session"],
        "the load is still attempted, and still answered"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_that_can_only_resume_continues_without_the_history() {
    let harness = Harness::new(Capabilities::resume());

    assert_eq!(harness.resume().await.unwrap(), ResumeMode::WithoutHistory);
    assert_eq!(
        harness.calls(),
        vec!["resume_session"],
        "and load is not attempted first"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn loading_wins_when_an_agent_advertises_both() {
    let harness = Harness::new(Capabilities {
        load: true,
        resume: true,
        ..Capabilities::default()
    });

    assert_eq!(harness.resume().await.unwrap(), ResumeMode::Replayed);
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_that_can_do_neither_says_so_and_starts_nothing() {
    let harness = Harness::new(Capabilities::neither());

    let error = harness.resume().await.expect_err("there is nothing to do");
    assert!(
        error.to_string().to_lowercase().contains("not supported"),
        "the error should name the limitation: {error}"
    );
    assert!(
        harness.calls().is_empty(),
        "no RPC is sent, and no fresh session is started in its place"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn resuming_starts_an_agent_that_is_not_running() {
    let harness = Harness::new(Capabilities::load());
    assert_eq!(harness.spawns.load(Ordering::SeqCst), 0);

    harness.resume().await.unwrap();

    assert_eq!(
        harness.spawns.load(Ordering::SeqCst),
        1,
        "spawned on demand"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_session_the_agent_has_forgotten_fails_without_starting_a_new_one() {
    let harness = Harness::forgetful(Capabilities::load());

    let error = harness.resume().await.expect_err("the agent said no");
    assert!(error.to_string().contains("no conversation found"));
    assert_eq!(
        harness.calls(),
        vec!["load_session"],
        "a failed load must not silently become a new session"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_is_asked_to_forget_a_session_only_when_it_says_it_can() {
    let advertised = Harness::new(Capabilities {
        list: true,
        delete: true,
        ..Capabilities::default()
    });
    assert!(advertised
        .manager
        .delete_stored_session(advertised.agent.clone(), &acp::SessionId::new("ses-1"))
        .await
        .unwrap());
    assert_eq!(advertised.calls(), vec!["delete_session"]);

    // `delete` without `list` is not a capability: there is no list object to
    // carry it, which is exactly how the protocol nests them.
    let unlisted = Harness::new(Capabilities {
        delete: true,
        ..Capabilities::default()
    });
    assert!(!unlisted
        .manager
        .delete_stored_session(unlisted.agent.clone(), &acp::SessionId::new("ses-1"))
        .await
        .unwrap());
    assert!(unlisted.calls().is_empty());

    let neither = Harness::new(Capabilities::neither());
    assert!(!neither
        .manager
        .delete_stored_session(neither.agent.clone(), &acp::SessionId::new("ses-1"))
        .await
        .unwrap());
    assert!(neither.calls().is_empty());
}
