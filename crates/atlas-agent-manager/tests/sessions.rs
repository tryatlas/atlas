//! The session registry, through its public interface.
//!
//! Each test opens sessions on the scripted connection the manager's own
//! suites use, ends them one of the ways a session ends, and reads back two
//! things: the follow-ups the end handed over, in order, and
//! [`Residue`] — everything the registry and the manager still hold for the
//! session id. An ended session reads as `Residue::default()`.

mod support;

use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{AcpThread, AcpThreadHandle};
use atlas_agent_manager::{
    Agent, AgentEnd, AgentManager, Closed, EndKind, Ended, FollowUp, Released, Residue,
    SessionExtra, SessionMeta, SessionRegistry,
};
use support::*;

/// A host's extra, reduced to what decides its survival: prompts parked for
/// the next turn outlive the agent's process (the rebind picks them up), and
/// nothing outlives a close.
#[derive(Default)]
struct Parked(usize);

impl SessionExtra for Parked {
    fn survives(&mut self, end: EndKind) -> bool {
        match end {
            EndKind::AgentGone => self.0 > 0,
            EndKind::Closed | EndKind::Quit => false,
        }
    }
}

struct Fixture {
    server: Arc<TestServer>,
    manager: Arc<AgentManager>,
    registry: Arc<SessionRegistry<Parked>>,
    agent: Agent,
}

const AGENT: &str = "agent-a";

fn fixture_on(server: Arc<TestServer>) -> Fixture {
    let manager = manager(TestCatalog::new(&[AGENT]), TestServer::new("native"));
    let agent = custom(AGENT);
    manager.request_connection(agent.clone(), server.clone());
    Fixture {
        server,
        registry: Arc::new(SessionRegistry::new(manager.clone())),
        manager,
        agent,
    }
}

fn fixture() -> Fixture {
    fixture_on(TestServer::new(AGENT))
}

fn meta(agent: &Agent) -> SessionMeta {
    SessionMeta {
        agent: agent.clone(),
        plugin_id: "plugin".into(),
        cwd: "/project".into(),
    }
}

impl Fixture {
    /// Open and bind a session on `agent`, the way a host does: the ticket
    /// first, the agent's `session/new`, then the bind.
    async fn open_on(&self, agent: &Agent) -> String {
        let ticket = self.registry.begin_bind(agent, None);
        let thread = self
            .manager
            .new_session(agent.clone(), Vec::new())
            .await
            .expect("a session opens");
        self.registry
            .bind(ticket, &thread, meta(agent))
            .expect("nothing ended it meanwhile");
        let session_id = thread.lock().unwrap().session_id().to_string();
        session_id
    }

    async fn open(&self) -> String {
        self.open_on(&self.agent).await
    }

    /// A thread under an id of the test's choosing, on the agent's live
    /// connection: what a `session/load` of a stored session hands back.
    fn thread_named(&self, session_id: &str) -> AcpThreadHandle {
        let connection = self
            .manager
            .connected(&self.agent)
            .expect("the agent is connected");
        Arc::new(std::sync::Mutex::new(AcpThread::new(
            acp::SessionId::new(session_id),
            connection,
            Vec::new(),
            None,
            atlas_acp_thread::event_channel().0,
        )))
    }

    fn residue(&self, session_id: &str) -> Residue {
        self.registry.residue(session_id)
    }
}

fn open_residue() -> Residue {
    Residue {
        bound: true,
        manager_handle: true,
        ..Residue::default()
    }
}

/// The follow-ups, as their names, in order.
fn steps(ended: &Ended) -> Vec<String> {
    ended.follow_ups.iter().map(|f| format!("{f:?}")).collect()
}

fn ended(closed: Closed) -> Ended {
    match closed {
        Closed::Ended(ended) => ended,
        other => panic!("expected the session to end, got {other:?}"),
    }
}

const CLOSE_STEPS: [&str; 4] = [
    "AnnounceEnded",
    "ForgetHistoryBinding",
    "CloseProjection",
    "CloseOnAgent",
];

// ---- the window lets it go ------------------------------------------------

#[tokio::test]
async fn closing_a_session_leaves_nothing_and_a_second_close_is_a_no_op() {
    let f = fixture();
    let id = f.open().await;
    assert_eq!(f.residue(&id), open_residue());

    let closed = ended(f.registry.close(&id));

    assert_eq!(closed.kind, EndKind::Closed);
    assert_eq!(closed.agent, f.agent);
    assert_eq!(steps(&closed), CLOSE_STEPS);
    assert_eq!(f.residue(&id), Residue::default());
    assert!(matches!(f.registry.close(&id), Closed::Unknown));
    assert_eq!(f.registry.counts(), (0, 0, 0));
}

#[tokio::test]
async fn an_agent_that_advertises_close_is_asked_last() {
    let f = fixture();
    f.server.advertise_close();
    let id = f.open().await;

    let closed = ended(f.registry.close(&id));

    assert_eq!(
        steps(&closed),
        [
            "AnnounceEnded",
            "ForgetHistoryBinding",
            "CloseProjection",
            "CloseOnAgent"
        ]
    );
    let Some(FollowUp::CloseOnAgent { connection }) = closed.follow_ups.last().cloned() else {
        panic!("the close is the last step");
    };
    connection
        .close_session(acp::SessionId::new(id.as_str()))
        .await
        .expect("closed on the agent");
    assert_eq!(f.server.closes(), [id]);
}

#[tokio::test]
async fn closing_one_session_leaves_another_on_the_connection_and_the_last_leaves_it_up() {
    let f = fixture();
    let first = f.open().await;
    let second = f.open().await;

    ended(f.registry.close(&first));

    assert_eq!(f.residue(&first), Residue::default());
    assert_eq!(f.residue(&second), open_residue());
    assert_eq!(
        f.registry.sessions_of(&f.agent),
        std::slice::from_ref(&second)
    );

    ended(f.registry.close(&second));

    assert!(
        f.manager.connected(&f.agent).is_some(),
        "the last session going does not take the connection"
    );
    assert_eq!(f.server.live_connections(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn closing_during_a_running_turn_ends_it_and_the_late_turn_brings_nothing_back() {
    let f = fixture();
    let id = f.open().await;
    let answer = f.server.queue_prompt();
    let turn = tokio::spawn({
        let (manager, id) = (f.manager.clone(), acp::SessionId::new(id.as_str()));
        async move { manager.send(&id, Vec::new()).await }
    });
    wait_for(|| (f.server.prompts_started() == 1).then_some(()))
        .await
        .expect("the turn is in flight");

    let closed = ended(f.registry.close(&id));
    assert_eq!(steps(&closed), CLOSE_STEPS);
    assert_eq!(f.residue(&id), Residue::default());

    answer.send(Ok(acp::StopReason::EndTurn)).expect("answered");
    turn.await.expect("joined").expect("the turn came back");
    assert_eq!(f.residue(&id), Residue::default());
}

// ---- holds ----------------------------------------------------------------

#[tokio::test]
async fn a_held_session_is_only_marked_and_the_last_release_ends_it() {
    let f = fixture();
    let id = f.open().await;
    assert_eq!(f.registry.hold(&id, "a"), Some(true), "the first hold");
    assert_eq!(f.registry.hold(&id, "b"), Some(false));
    assert!(f.registry.is_held(&id));

    assert!(matches!(f.registry.close(&id), Closed::Held));
    assert_eq!(
        f.residue(&id),
        Residue {
            holds: vec!["a".into(), "b".into()],
            released_by_window: true,
            ..open_residue()
        }
    );

    assert!(matches!(f.registry.release(&id, "a"), Released::StillHeld));
    let Released::LastAndEnded(closed) = f.registry.release(&id, "b") else {
        panic!("the last hold going finishes the close");
    };
    assert_eq!(
        steps(&closed),
        CLOSE_STEPS,
        "exactly what a close hands over"
    );
    assert_eq!(f.residue(&id), Residue::default());
    assert!(matches!(f.registry.release(&id, "b"), Released::NotHeld));
}

#[tokio::test]
async fn a_hold_released_while_the_window_has_the_session_keeps_it() {
    let f = fixture();
    let id = f.open().await;
    f.registry.hold(&id, "a");

    assert!(matches!(
        f.registry.release(&id, "nobody"),
        Released::NotHeld
    ));
    assert!(matches!(f.registry.release(&id, "a"), Released::Last));

    assert_eq!(f.residue(&id), open_residue());
    assert_eq!(f.registry.hold("no-such-session", "a"), None);
}

#[tokio::test]
async fn a_session_the_window_took_back_survives_the_last_release() {
    let f = fixture();
    let id = f.open().await;
    f.registry.hold(&id, "a");
    assert!(matches!(f.registry.close(&id), Closed::Held));

    assert!(f.registry.reclaim_for_window(&id), "it is still bound");
    assert!(matches!(f.registry.release(&id, "a"), Released::Last));

    assert_eq!(f.residue(&id), open_residue());
    assert!(!f.registry.reclaim_for_window("no-such-session"));
}

// ---- its agent goes -------------------------------------------------------

#[tokio::test]
async fn stopping_an_agent_ends_every_session_on_it_and_drops_the_connection() {
    let f = fixture();
    let first = f.open().await;
    let second = f.open().await;
    let elsewhere = f.open_on(&Agent::Native).await;
    f.registry.hold(&first, "a");

    let mut gone = f
        .registry
        .end_agent(&f.agent, AgentEnd::stopping().with_notice("turned off"));
    gone.sort_by(|a, b| a.session_id.cmp(&b.session_id));

    assert_eq!(
        gone.iter()
            .map(|e| e.session_id.clone())
            .collect::<Vec<_>>(),
        [first.clone(), second.clone()]
    );
    for one in &gone {
        assert_eq!(one.kind, EndKind::AgentGone);
        assert_eq!(
            steps(one),
            [
                "NoticeDisconnected(\"turned off\")",
                "CloseProjection",
                "AnnounceEnded"
            ]
        );
    }
    assert_eq!(f.residue(&first), Residue::default(), "holds and all");
    assert_eq!(f.residue(&second), Residue::default());
    assert_eq!(f.residue(&elsewhere), open_residue(), "another agent's");
    assert!(f.manager.connected(&f.agent).is_none());
    wait_for(|| (f.server.live_connections() == 0).then_some(()))
        .await
        .expect("nothing pins the connection");

    assert!(f
        .registry
        .end_agent(&f.agent, AgentEnd::stopping())
        .is_empty());
    assert!(matches!(f.registry.release(&first, "a"), Released::NotHeld));
}

#[tokio::test]
async fn an_agent_that_already_exited_is_not_dropped_again() {
    let f = fixture();
    let id = f.open().await;

    let gone = f.registry.end_agent(&f.agent, AgentEnd::exited());

    assert_eq!(steps(&gone[0]), ["CloseProjection", "AnnounceEnded"]);
    assert_eq!(f.residue(&id), Residue::default());
    assert!(
        f.manager.connected(&f.agent).is_some(),
        "whatever connection is there now was started since: it stays"
    );
}

#[tokio::test]
async fn a_parked_queue_outlives_the_agent_and_nothing_outlives_a_close() {
    let f = fixture();
    let parked = f.open().await;
    let idle = f.open().await;
    f.registry.with_extra(&parked, |extra| extra.0 = 2);
    f.registry.with_extra(&idle, |extra| extra.0 = 0);

    f.registry.end_agent(&f.agent, AgentEnd::exited());

    assert_eq!(
        f.residue(&parked),
        Residue {
            extra: true,
            ..Residue::default()
        }
    );
    assert_eq!(f.residue(&idle), Residue::default());
    assert_eq!(
        f.registry.extra_mut(&parked, |extra| extra.map(|e| e.0)),
        Some(2)
    );

    // A session bound again under the same id finds its queue, and a close
    // then takes it.
    let ticket = f.registry.begin_bind(&f.agent, Some(&parked));
    f.registry
        .bind(ticket, &f.thread_named(&parked), meta(&f.agent))
        .expect("rebound");
    ended(f.registry.close(&parked));
    assert_eq!(f.residue(&parked), Residue::default());
}

#[tokio::test]
async fn quitting_ends_everything() {
    let f = fixture();
    let first = f.open().await;
    let second = f.open_on(&Agent::Native).await;
    f.registry.hold(&first, "a");
    f.registry.with_extra(&first, |extra| extra.0 = 5);
    let in_flight = f.registry.begin_bind(&f.agent, None);
    let late = f.thread_named("late");

    let gone = f.registry.end_all();

    assert_eq!(gone.len(), 2);
    for one in &gone {
        assert_eq!(one.kind, EndKind::Quit);
        assert_eq!(steps(one), ["AnnounceEnded"]);
    }
    assert_eq!(f.residue(&first), Residue::default());
    assert_eq!(f.residue(&second), Residue::default());
    assert!(f.manager.sessions().is_empty());
    assert!(f.manager.connections().is_empty());
    assert!(
        f.registry.end_all().is_empty(),
        "a second quit ends nothing"
    );

    let refused = f
        .registry
        .bind(in_flight, &late, meta(&f.agent))
        .expect_err("nothing binds after the quit");
    assert_eq!(refused.ended_by, EndKind::Quit);
    assert_eq!(f.registry.counts(), (0, 0, 0));
}

// ---- binds in flight ------------------------------------------------------

#[tokio::test]
async fn a_bind_that_lands_after_its_agent_was_stopped_is_refused() {
    let f = fixture();
    let ticket = f.registry.begin_bind(&f.agent, None);
    // The agent answers `session/new` — and is stopped before the bind.
    let thread = f
        .manager
        .new_session(f.agent.clone(), Vec::new())
        .await
        .expect("opened");
    let id = thread.lock().unwrap().session_id().clone();
    assert!(f
        .registry
        .end_agent(&f.agent, AgentEnd::exited())
        .is_empty());

    let refused = f
        .registry
        .bind(ticket, &thread, meta(&f.agent))
        .expect_err("the late bind must not resurrect the session");

    assert_eq!(refused.ended_by, EndKind::AgentGone);
    assert_eq!(
        refused
            .follow_ups
            .iter()
            .map(|f| format!("{f:?}"))
            .collect::<Vec<_>>(),
        [] as [&str; 0],
        "an agent that is going is not asked to close anything"
    );
    assert_eq!(f.residue(id.0.as_ref()), Residue::default());
    assert_eq!(f.registry.counts(), (0, 0, 0));
}

#[tokio::test]
async fn a_bind_that_lands_after_its_session_was_closed_is_refused_and_closed_on_the_agent() {
    let f = fixture_on(TestServer::with_fixed_session_id(AGENT, "s-stored"));
    f.server.advertise_close();
    // A stored session is being reopened; its tab closes before it is back.
    let ticket = f.registry.begin_bind(&f.agent, Some("s-stored"));
    assert_eq!(f.residue("s-stored").binds_in_flight, 1);
    assert!(matches!(f.registry.close("s-stored"), Closed::Unknown));
    let thread = f
        .manager
        .new_session(f.agent.clone(), Vec::new())
        .await
        .expect("opened");

    let refused = f
        .registry
        .bind(ticket, &thread, meta(&f.agent))
        .expect_err("the late bind must not resurrect the session");

    assert_eq!(refused.ended_by, EndKind::Closed);
    assert_eq!(
        refused
            .follow_ups
            .iter()
            .map(|f| format!("{f:?}"))
            .collect::<Vec<_>>(),
        ["CloseOnAgent"],
        "nothing of the host's is undone by id: the bind set nothing up"
    );
    assert_eq!(f.residue("s-stored"), Residue::default());
}

#[tokio::test]
async fn a_refused_bind_does_not_close_a_newer_bind_of_its_session_on_the_agent() {
    let f = fixture_on(TestServer::with_fixed_session_id(AGENT, "s-stored"));
    f.server.advertise_close();
    // The tab closes on a reopen in flight, and the row is opened again.
    let late = f.registry.begin_bind(&f.agent, Some("s-stored"));
    assert!(matches!(f.registry.close("s-stored"), Closed::Unknown));
    let newer = f.registry.begin_bind(&f.agent, Some("s-stored"));
    let open = || f.manager.new_session(f.agent.clone(), Vec::new());
    let (late_thread, newer_thread) =
        (open().await.expect("opened"), open().await.expect("opened"));
    f.registry
        .bind(newer, &newer_thread, meta(&f.agent))
        .expect("the reopen binds");

    let refused = f
        .registry
        .bind(late, &late_thread, meta(&f.agent))
        .expect_err("the bind the close covered");

    assert_eq!(refused.ended_by, EndKind::Closed);
    assert!(
        refused.follow_ups.is_empty(),
        "the agent has one session by this id, and the reopened tab is on it"
    );
    assert!(f.registry.contains("s-stored"));
    let handle = f
        .manager
        .session(&acp::SessionId::new("s-stored"))
        .expect("the newer bind lost its handle");
    assert!(
        Arc::ptr_eq(&handle.thread, &newer_thread),
        "the newer bind's thread is the one registered"
    );
}

#[tokio::test]
async fn a_refused_bind_does_not_close_a_newer_open_that_is_still_on_its_way() {
    let f = fixture_on(TestServer::with_fixed_session_id(AGENT, "s-stored"));
    f.server.advertise_close();
    let late = f.registry.begin_bind(&f.agent, Some("s-stored"));
    assert!(matches!(f.registry.close("s-stored"), Closed::Unknown));
    let newer = f.registry.begin_bind(&f.agent, Some("s-stored"));
    let open = || f.manager.new_session(f.agent.clone(), Vec::new());
    // The late load is answered first this time, and the newer one is
    // opened but not yet bound when the late bind is refused.
    let (late_thread, newer_thread) =
        (open().await.expect("opened"), open().await.expect("opened"));

    let refused = f
        .registry
        .bind(late, &late_thread, meta(&f.agent))
        .expect_err("the bind the close covered");
    assert!(
        refused.follow_ups.is_empty(),
        "the agent was told to close the session the newer open is on"
    );

    f.registry
        .bind(newer, &newer_thread, meta(&f.agent))
        .expect("the reopen binds");
    let handle = f
        .manager
        .session(&acp::SessionId::new("s-stored"))
        .expect("the reopen has no handle, so it cannot send");
    assert!(Arc::ptr_eq(&handle.thread, &newer_thread));
}

#[tokio::test]
async fn binding_a_session_again_replaces_its_handle() {
    let f = fixture_on(TestServer::with_fixed_session_id(AGENT, "s-stored"));
    let id = f.open_on(&f.agent).await;
    let again = f.registry.begin_bind(&f.agent, Some(&id));
    let thread = f
        .manager
        .new_session(f.agent.clone(), Vec::new())
        .await
        .expect("opened again");
    f.registry
        .bind(again, &thread, meta(&f.agent))
        .expect("a rebind of a bound session is accepted");
    let handle = f
        .manager
        .session(&acp::SessionId::new(id.as_str()))
        .expect("the session has a handle");
    assert!(
        Arc::ptr_eq(&handle.thread, &thread),
        "the session still sends through the thread it was bound to first"
    );
}

#[tokio::test]
async fn an_end_that_does_not_cover_a_bind_leaves_it_alone() {
    let f = fixture();
    let other = f.open().await;
    let ticket = f.registry.begin_bind(&f.agent, Some("s-mine"));

    ended(f.registry.close(&other));
    f.registry.end_agent(&Agent::Native, AgentEnd::stopping());

    f.registry
        .bind(ticket, &f.thread_named("s-mine"), meta(&f.agent))
        .expect("neither end was this session's");
    assert!(f.registry.contains("s-mine"));
}

#[tokio::test]
async fn a_bind_whose_open_failed_leaves_no_ticket() {
    let f = fixture();
    let ticket = f.registry.begin_bind(&f.agent, Some("s-never"));
    assert_eq!(f.registry.counts(), (0, 0, 1));

    drop(ticket);

    assert_eq!(f.registry.counts(), (0, 0, 0));
    assert_eq!(f.residue("s-never"), Residue::default());
}

// ---- the record -----------------------------------------------------------

#[tokio::test]
async fn a_session_is_looked_up_with_what_it_was_bound_with() {
    let f = fixture();
    let id = f.open().await;

    let info = f.registry.info(&id).expect("bound");
    assert_eq!(info.agent, f.agent);
    assert_eq!(
        (info.plugin_id.as_str(), info.cwd.as_str()),
        ("plugin", "/project")
    );
    assert_eq!(
        (info.turn_seq, info.current_model, info.held),
        (0, None, false)
    );

    assert_eq!(f.registry.next_turn_seq(&id), Some(1));
    assert_eq!(f.registry.next_turn_seq(&id), Some(2));
    assert!(f.registry.set_current_model(&id, "model-a".into()));
    let info = f.registry.info(&id).expect("bound");
    assert_eq!(
        (info.turn_seq, info.current_model.as_deref()),
        (2, Some("model-a"))
    );

    ended(f.registry.close(&id));
    assert!(f.registry.info(&id).is_none());
    assert_eq!(f.registry.next_turn_seq(&id), None);
    assert!(!f.registry.set_current_model(&id, "model-b".into()));
}

// ---- many at once ---------------------------------------------------------

/// Sessions binding, holding, closing and losing their agent from several
/// tasks at once. Bounded: a deadlock fails the test instead of hanging it.
/// What must hold afterwards is that no bind is left in flight and nothing
/// is bound without the manager holding its thread.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn binding_and_ending_from_many_tasks_at_once_neither_deadlocks_nor_tears() {
    let f = Arc::new(fixture());
    let agents = [f.agent.clone(), Agent::Native];

    let mut tasks = Vec::new();
    for worker in 0..8usize {
        let (f, agents) = (f.clone(), agents.clone());
        tasks.push(tokio::spawn(async move {
            for round in 0..40usize {
                let agent = &agents[(worker + round) % 2];
                let ticket = f.registry.begin_bind(agent, None);
                // Its agent may be stopped under it: then there is no
                // session, and the ticket goes with the failure.
                let Ok(thread) = f.manager.new_session(agent.clone(), Vec::new()).await else {
                    continue;
                };
                if f.registry.bind(ticket, &thread, meta(agent)).is_err() {
                    continue;
                }
                let id = thread.lock().unwrap().session_id().to_string();
                f.registry.hold(&id, "rc");
                f.registry.with_extra(&id, |extra| extra.0 = round % 3);
                f.registry.next_turn_seq(&id);
                tokio::task::yield_now().await;
                f.registry.close(&id);
                f.registry.release(&id, "rc");
            }
        }));
    }
    for stopper in 0..2usize {
        let (f, agents) = (f.clone(), agents.clone());
        tasks.push(tokio::spawn(async move {
            for round in 0..60usize {
                let agent = &agents[(stopper + round) % 2];
                let how = if round % 2 == 0 {
                    AgentEnd::stopping().with_notice("stopped")
                } else {
                    AgentEnd::exited()
                };
                f.registry.end_agent(agent, how);
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        }));
    }

    tokio::time::timeout(Duration::from_secs(30), async {
        for task in tasks {
            task.await.expect("no task panicked");
        }
    })
    .await
    .expect("every task finished: nothing deadlocked");

    let (_, _, binds) = f.registry.counts();
    assert_eq!(binds, 0, "no bind is left in flight");
    for agent in &agents {
        for id in f.registry.sessions_of(agent) {
            assert!(
                f.residue(&id).manager_handle,
                "{id} is bound, so the manager holds its thread"
            );
        }
    }

    f.registry.end_all();
    assert_eq!(f.registry.counts(), (0, 0, 0));
    assert!(f.manager.sessions().is_empty());
}

/// #86: ACP scopes a session id to its connection. Two agents that both
/// answer `"1"` have two sessions: binding the second does not replace the
/// first, the bare id is not guessed at while both hold it, and ending one
/// agent's session leaves the other's bound, handle and all.
#[tokio::test]
async fn two_agents_with_the_same_session_id_stay_separate() {
    let manager = manager(
        TestCatalog::new(&["agent-a", "agent-b"]),
        TestServer::new("native"),
    );
    let (a, b) = (custom("agent-a"), custom("agent-b"));
    manager.request_connection(a.clone(), TestServer::with_fixed_session_id("agent-a", "1"));
    manager.request_connection(b.clone(), TestServer::with_fixed_session_id("agent-b", "1"));
    let registry = SessionRegistry::<Parked>::new(manager.clone());
    for agent in [&a, &b] {
        let ticket = registry.begin_bind(agent, None);
        let thread = manager
            .new_session(agent.clone(), Vec::new())
            .await
            .expect("a session opens");
        registry
            .bind(ticket, &thread, meta(agent))
            .expect("nothing ended it meanwhile");
    }

    assert_eq!(registry.holders("1"), 2, "B's bind did not replace A's");
    assert_eq!(registry.counts().0, 2);
    assert_eq!(registry.info_of(&a, "1").map(|i| i.agent), Some(a.clone()));
    assert_eq!(registry.info_of(&b, "1").map(|i| i.agent), Some(b.clone()));
    assert!(
        registry.info("1").is_none() && manager.session(&acp::SessionId::new("1")).is_none(),
        "an id two agents share is not resolved by guessing"
    );
    assert!(matches!(registry.close("1"), Closed::Unknown));
    assert_eq!(registry.holders("1"), 2, "nor closed by guessing");

    let Closed::Ended(ended) = registry.close_of(&b, "1") else {
        panic!("B's session closes by name");
    };
    assert_eq!(ended.agent, b);
    assert!(registry.info_of(&a, "1").is_some(), "A's stays bound");
    assert_eq!(
        manager.session(&acp::SessionId::new("1")).map(|h| h.agent),
        Some(a.clone()),
        "and A's handle with it"
    );

    // Ending B's agent touches nothing of A's.
    registry.end_agent(&b, AgentEnd::stopping());
    assert_eq!(registry.info("1").map(|i| i.agent), Some(a));
}
