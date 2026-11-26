//! The deltas reach the outbound pipeline losslessly, in order, on the emit
//! path.
//!
//! This is touchpoint #1, and the reason it is a test rather than a comment:
//! `CaptureMiddleware` is a pipeline *stage*, not a subscriber to a broadcast
//! channel, precisely because a broadcast drops events for a lagging
//! subscriber and a dropped event is a hole in the permanent record. A
//! pipeline that ran late, dropped, or reordered would be the same hole with a
//! different cause.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::test_support::FakeConnection;
use atlas_acp_thread::{AcpThread, AgentConnection};
use atlas_agent_delta::{AgentId, DeltaProjector, DeltaSink, SessionDeltaEnvelope};
use atlas_bus::{OutboundMiddleware, OutboundPipeline};

/// One stage of the pipeline. The real ones are broadcast, analytics, capture,
/// transcript and memory-ingest; what matters here is that each sees every
/// event and that they see them in registration order.
struct Stage {
    name: &'static str,
    order: Arc<Mutex<Vec<&'static str>>>,
    seen: Arc<Mutex<Vec<String>>>,
}

impl OutboundMiddleware<SessionDeltaEnvelope> for Stage {
    fn on_event(&self, event: &SessionDeltaEnvelope) {
        self.order.lock().unwrap().push(self.name);
        self.seen.lock().unwrap().push(
            serde_json::to_value(&event.delta).unwrap()["kind"]
                .as_str()
                .unwrap()
                .to_string(),
        );
    }
}

/// The host's sink: run the pipeline, then whatever else it does.
struct PipelineSink {
    pipeline: OutboundPipeline<SessionDeltaEnvelope>,
    emitted: Arc<AtomicUsize>,
}

impl DeltaSink for PipelineSink {
    fn emit(&self, envelope: SessionDeltaEnvelope) {
        self.pipeline.run(&envelope);
        self.emitted.fetch_add(1, Ordering::SeqCst);
    }
}

/// A connection that answers nothing: these tests drive the thread
/// directly, so no request ever leaves it.
fn stub_connection() -> Arc<dyn AgentConnection> {
    FakeConnection::builder()
        .agent("stub")
        .fail_new_session("not used")
        .build()
        .0
}

#[tokio::test]
async fn a_blocked_session_sink_leaves_other_sessions_and_the_runtime_live() {
    use std::sync::atomic::AtomicBool;
    use std::sync::Condvar;
    use std::time::Duration;
    struct SlowSink {
        entered: tokio::sync::Notify,
        other: tokio::sync::Notify,
        gate: (Mutex<bool>, Condvar),
        expired: AtomicBool,
    }
    impl DeltaSink for SlowSink {
        fn emit(&self, envelope: SessionDeltaEnvelope) {
            if envelope.session_id == "slow" {
                self.entered.notify_one();
                let (_released, timeout) = self
                    .gate
                    .1
                    .wait_timeout_while(
                        self.gate.0.lock().unwrap(),
                        Duration::from_secs(3),
                        |released| !*released,
                    )
                    .unwrap();
                if timeout.timed_out() {
                    self.expired.store(true, Ordering::SeqCst);
                }
            } else {
                self.other.notify_one();
            }
        }
    }
    struct Release(Arc<SlowSink>);
    impl Drop for Release {
        fn drop(&mut self) {
            *self.0.gate.0.lock().unwrap() = true;
            self.0.gate.1.notify_all();
        }
    }
    let sink = Arc::new(SlowSink {
        entered: tokio::sync::Notify::new(),
        other: tokio::sync::Notify::new(),
        gate: (Mutex::new(false), Condvar::new()),
        expired: AtomicBool::new(false),
    });
    let release = Release(sink.clone());
    let projector = DeltaProjector::new(sink.clone());
    let bind = |name: &str| {
        let id = acp::SessionId::new(name.to_string());
        let thread = Arc::new(Mutex::new(AcpThread::new(
            id.clone(),
            stub_connection(),
            Vec::new(),
            None,
            (projector.thread_events())(&"stub".into(), &id),
        )));
        projector.attach(AgentId::new(), thread.clone());
        thread
    };
    let slow = bind("slow");
    let fast = bind("fast");
    slow.lock()
        .unwrap()
        .handle_session_update(acp::SessionUpdate::AgentMessageChunk(
            acp::ContentChunk::new(acp::ContentBlock::from("slow write")),
        ))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), sink.entered.notified())
        .await
        .unwrap();
    fast.lock()
        .unwrap()
        .handle_session_update(acp::SessionUpdate::AgentMessageChunk(
            acp::ContentChunk::new(acp::ContentBlock::from("other session")),
        ))
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), sink.other.notified())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(1)).await;
    assert!(
        !sink.expired.load(Ordering::SeqCst),
        "the runtime waited for the blocked session"
    );
    drop(release);
    projector.close_session(&acp::SessionId::new("slow"));
    projector.close_session(&acp::SessionId::new("fast"));
}

#[tokio::test(flavor = "multi_thread")]
async fn every_delta_reaches_every_stage_in_order_on_the_emit_path() {
    const STAGES: [&str; 5] = [
        "broadcast",
        "analytics",
        "capture",
        "transcript",
        "memory-ingest",
    ];

    let order = Arc::new(Mutex::new(Vec::new()));
    let seen: Vec<Arc<Mutex<Vec<String>>>> = STAGES
        .iter()
        .map(|_| Arc::new(Mutex::new(Vec::new())))
        .collect();
    let mut pipeline = OutboundPipeline::new();
    for (name, seen) in STAGES.iter().zip(&seen) {
        pipeline.push(Arc::new(Stage {
            name,
            order: order.clone(),
            seen: seen.clone(),
        }));
    }

    let emitted = Arc::new(AtomicUsize::new(0));
    let projector = DeltaProjector::new(Arc::new(PipelineSink {
        pipeline,
        emitted: emitted.clone(),
    }));

    let session_id = acp::SessionId::new("sess-1");
    let events = (projector.thread_events())(&"stub".into(), &session_id);
    let thread = Arc::new(Mutex::new(AcpThread::new(
        session_id.clone(),
        stub_connection(),
        vec![PathBuf::from("/tmp")],
        None,
        events,
    )));
    let mut stream = projector
        .register(AgentId::new(), thread.clone())
        .expect("registered");

    // A turn's worth of traffic: text, a tool call that runs and finishes, and
    // a terminal.
    let updates = [
        serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "working on it" },
        }),
        serde_json::json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call-1",
            "title": "Bash",
            "kind": "execute",
            "status": "in_progress",
            "rawInput": { "command": "ls" },
        }),
        serde_json::json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call-1",
            "status": "completed",
            "content": [{ "type": "content", "content": { "type": "text", "text": "a.txt" } }],
        }),
    ];
    {
        let mut thread = thread.lock().unwrap();
        thread.begin_turn();
        for update in updates {
            thread
                .handle_session_update(serde_json::from_value(update).unwrap())
                .unwrap();
        }
        thread.end_turn(acp::StopReason::EndTurn);
    }

    let mut applied = 0;
    while let Ok(event) = stream.try_recv() {
        projector.apply(&session_id, event);
        applied += 1;
    }
    assert!(applied > 0, "the thread emitted something to project");

    // Synchronous: by the time `apply` returned, every stage had already run.
    // Nothing here waits, sleeps or polls.
    let total = emitted.load(Ordering::SeqCst);
    assert!(total > 0, "deltas reached the sink");

    // Lossless: every stage saw every delta, and the same ones.
    let first = seen[0].lock().unwrap().clone();
    assert_eq!(first.len(), total, "the first stage saw every delta");
    for (name, stage) in STAGES.iter().zip(&seen) {
        assert_eq!(
            *stage.lock().unwrap(),
            first,
            "`{name}` saw a different stream"
        );
    }

    // In order: the stages ran in registration order, once each, per event.
    let order = order.lock().unwrap().clone();
    assert_eq!(order.len(), total * STAGES.len());
    for chunk in order.chunks(STAGES.len()) {
        assert_eq!(chunk, STAGES, "stages ran out of registration order");
    }

    // And the turn is on the record from both ends.
    assert_eq!(first.first().map(String::as_str), Some("status"));
    assert!(first.contains(&"turn_finished".to_string()));
    assert!(first.contains(&"tool_call_upserted".to_string()));
}

/// #86: ACP scopes a session id to its connection, so two agents can both
/// answer `"1"`. The second must not replace the first: each keeps its own
/// projection, its events reach the wire under its own agent, and closing one
/// leaves the other running.
#[tokio::test]
async fn two_agents_with_the_same_session_id_stay_separate() {
    use std::time::Duration;
    #[derive(Default)]
    struct Seen(Mutex<Vec<(AgentId, String)>>);
    impl DeltaSink for Seen {
        fn emit(&self, envelope: SessionDeltaEnvelope) {
            if let atlas_agent_delta::SessionDelta::MessageAppended { message, .. } =
                &envelope.delta
            {
                self.0
                    .lock()
                    .unwrap()
                    .push((envelope.agent_id, message.content.clone()));
            }
        }
    }
    let seen = Arc::new(Seen::default());
    let projector = DeltaProjector::new(seen.clone());
    let id = acp::SessionId::new("1");
    let bind = |agent: AgentId| {
        let thread = Arc::new(Mutex::new(AcpThread::new(
            id.clone(),
            stub_connection(),
            Vec::new(),
            None,
            (projector.thread_events())(&"stub".into(), &id),
        )));
        projector.attach(agent, thread.clone());
        thread
    };
    let (a, b) = (AgentId::new(), AgentId::new());
    let thread_a = bind(a);
    let thread_b = bind(b);
    assert_eq!(projector.session_count(), 2, "one projection per agent");
    assert!(projector.is_projecting(a, &id), "B's bind left A's alone");
    assert!(projector.is_projecting(b, &id));

    let say = |thread: &atlas_acp_thread::AcpThreadHandle, text: &str| {
        thread
            .lock()
            .unwrap()
            .handle_session_update(acp::SessionUpdate::AgentMessageChunk(
                acp::ContentChunk::new(acp::ContentBlock::from(text.to_string())),
            ))
            .unwrap();
    };
    say(&thread_a, "from a");
    say(&thread_b, "from b");
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while seen.0.lock().unwrap().len() < 2 {
        assert!(std::time::Instant::now() < deadline, "both agents speak");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let mut got = seen.0.lock().unwrap().clone();
    got.sort_by_key(|(_, text)| text.clone());
    assert_eq!(got, [(a, "from a".to_string()), (b, "from b".to_string())]);

    // The bare id names two sessions now: it closes neither.
    projector.close_session(&id);
    assert_eq!(
        projector.session_count(),
        2,
        "an ambiguous id is not guessed at"
    );
    projector.close_session_of(b, &id);
    assert!(
        projector.is_projecting(a, &id),
        "closing B leaves A running"
    );
    assert!(!projector.is_projecting(b, &id));
    // With one holder left the bare id is unambiguous again.
    projector.close_session(&id);
    assert_eq!(projector.session_count(), 0);
}

/// #86, the half before `attach`: a connection asks for a session's event
/// sink before the host registers the session, and whatever the thread emits
/// in between waits in that stream. Two agents opening `"1"` at once each get
/// their own: filed by the bare id, the second hand-out replaced the first,
/// and the first agent's registration took the second agent's events.
#[tokio::test]
async fn two_agents_opening_the_same_session_id_keep_their_own_pre_bind_events() {
    use std::time::Duration;
    #[derive(Default)]
    struct Seen(Mutex<Vec<(AgentId, String)>>);
    impl DeltaSink for Seen {
        fn emit(&self, envelope: SessionDeltaEnvelope) {
            if let atlas_agent_delta::SessionDelta::MessageAppended { message, .. } =
                &envelope.delta
            {
                self.0
                    .lock()
                    .unwrap()
                    .push((envelope.agent_id, message.content.clone()));
            }
        }
    }
    let connection = |agent: &str| {
        FakeConnection::builder()
            .agent(agent)
            .fail_new_session("not used")
            .build()
            .0
    };
    let seen = Arc::new(Seen::default());
    let projector = DeltaProjector::new(seen.clone());
    let id = acp::SessionId::new("1");
    // Both sinks are handed out before either session is registered.
    let open = |agent: &str| {
        Arc::new(Mutex::new(AcpThread::new(
            id.clone(),
            connection(agent),
            Vec::new(),
            None,
            (projector.thread_events())(&agent.into(), &id),
        )))
    };
    let thread_a = open("agent-a");
    let thread_b = open("agent-b");
    assert_eq!(projector.pending_len(), 2, "one waiting stream per agent");
    let say = |thread: &atlas_acp_thread::AcpThreadHandle, text: &str| {
        thread
            .lock()
            .unwrap()
            .handle_session_update(acp::SessionUpdate::AgentMessageChunk(
                acp::ContentChunk::new(acp::ContentBlock::from(text.to_string())),
            ))
            .unwrap();
    };
    say(&thread_a, "from a");
    say(&thread_b, "from b");

    let (a, b) = (AgentId::new(), AgentId::new());
    projector.attach(a, thread_a.clone());
    projector.attach(b, thread_b.clone());
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while seen.0.lock().unwrap().len() < 2 {
        assert!(std::time::Instant::now() < deadline, "both agents speak");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let mut got = seen.0.lock().unwrap().clone();
    got.sort_by_key(|(_, text)| text.clone());
    assert_eq!(got, [(a, "from a".to_string()), (b, "from b".to_string())]);
    assert_eq!(projector.pending_len(), 0);
}
