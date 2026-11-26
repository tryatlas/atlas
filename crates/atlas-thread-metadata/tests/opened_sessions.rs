//! Sessions Atlas opened itself: recorded the moment the agent answers
//! `session/new`, before anything is sent and so before Atlas has a row for
//! them, and known from then on, across restarts.
//!
//! An agent that stores and lists a session as soon as it exists (opencode)
//! lists one Atlas opened and never sent to, and the project sync imports any
//! session it does not know. Known only in memory, such a session came back
//! as an untitled "New session" row on the next launch.

use agent_client_protocol::schema::v1 as acp;
use atlas_thread_metadata::{LiveThreadUpdate, ThreadId, ThreadMetadataStore, WorktreePaths};

/// What the recorder writes for a session's row: a draft while nothing has
/// been sent, the conversation once something has.
fn live_update(thread_id: ThreadId, session: &acp::SessionId, is_draft: bool) -> LiveThreadUpdate {
    LiveThreadUpdate {
        thread_id,
        is_draft,
        session_id: Some(session.clone()),
        agent_id: "some-agent".into(),
        title: None,
        worktree_paths: WorktreePaths::default(),
        remote_connection: None,
        // A first message is activity; a draft's connect is not.
        activity: !is_draft,
    }
}

#[test]
fn a_session_atlas_opened_is_known_after_a_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("threads.db");
    let opened = acp::SessionId::new("opened-never-sent");
    {
        let store = ThreadMetadataStore::open(&path).unwrap();
        assert!(!store.known_session_ids().contains(&opened));
        store.record_session_opened(&opened);
        assert!(store.known_session_ids().contains(&opened));
        store.flush().unwrap();
    }
    let store = ThreadMetadataStore::open(&path).unwrap();
    assert!(store.known_session_ids().contains(&opened));
    assert!(store.is_opened_unused(&opened));
    assert!(!store.is_opened_unused(&acp::SessionId::new("from-a-terminal")));
}

#[test]
fn recording_a_session_twice_is_a_no_op() {
    let dir = tempfile::tempdir().unwrap();
    let store = ThreadMetadataStore::open(dir.path().join("threads.db")).unwrap();
    let opened = acp::SessionId::new("s");
    store.record_session_opened(&opened);
    store.record_session_opened(&opened);
    store.flush().unwrap();
    assert!(store.is_opened_unused(&opened));
}

/// "Unused" is a recorded fact, not the absence of a row: it ends, for good,
/// the moment the session's conversation is written, and is never inferred
/// again from the session having no row. A row moves to another session id
/// when an agent resumes a conversation under a fresh one, and the session it
/// left holds a real conversation; read as "no row, so unused", that session
/// would be deleted on its agent.
#[test]
fn a_session_that_was_sent_to_is_never_unused_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("threads.db");
    let first = acp::SessionId::new("first");
    let resumed_as = acp::SessionId::new("resumed-under-a-fresh-id");
    let thread_id = ThreadId::new();
    {
        let store = ThreadMetadataStore::open(&path).unwrap();
        store.record_session_opened(&first);
        // Connected, nothing sent: still a draft, still unused.
        store.record_live_update(live_update(thread_id, &first, true));
        assert!(store.is_opened_unused(&first));
        // The first message.
        store.record_live_update(live_update(thread_id, &first, false));
        assert!(!store.is_opened_unused(&first));
        // The row moves to the id the agent resumed the conversation under.
        store.record_live_update(live_update(thread_id, &resumed_as, false));
        assert!(store.thread_for_session(&first).is_none());
        assert!(!store.is_opened_unused(&first));
        store.flush().unwrap();
    }
    let store = ThreadMetadataStore::open(&path).unwrap();
    assert!(
        !store.is_opened_unused(&first),
        "and not after a restart either"
    );
}

/// The time of opening is kept with the record, across restarts, and a
/// session found to have been used elsewhere stops being Atlas's unused one:
/// not known any more, so the next import lists it.
#[test]
fn the_time_of_opening_is_kept_and_a_session_used_elsewhere_is_forgotten() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("threads.db");
    let opened = acp::SessionId::new("opened");
    let before = chrono::Utc::now();
    let at = {
        let store = ThreadMetadataStore::open(&path).unwrap();
        store.record_session_opened(&opened);
        store.flush().unwrap();
        store.opened_unused_since(&opened).expect("recorded")
    };
    assert!(at >= before && at <= chrono::Utc::now());
    {
        let store = ThreadMetadataStore::open(&path).unwrap();
        assert_eq!(store.opened_unused_since(&opened), Some(at));
        assert!(store.forget_session_opened(&opened));
        assert!(!store.forget_session_opened(&opened));
        assert!(!store.known_session_ids().contains(&opened));
        store.flush().unwrap();
    }
    let store = ThreadMetadataStore::open(&path).unwrap();
    assert_eq!(store.opened_unused_since(&opened), None);
}
