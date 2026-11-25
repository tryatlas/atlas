//! Conformance, at the connection: Atlas against ACP agents that do not
//! behave like Claude.
//!
//! Each test plays one named scenario (`test_support::scenarios`) through a
//! scripted agent — a real child process on real pipes — and asserts what the
//! spec asks of the client at this layer: what `AcpConnection` sends, how it
//! answers the agent's requests, and what lands in the session's thread. The
//! scenarios whose effect is only visible on a turn or on the delta wire
//! belong in a suite in `atlas-agent-manager`, against the same scenarios;
//! that suite has not been written yet.
//!
//! A test that Atlas fails today is `#[ignore = "audit #N: …"]`, asserting the
//! behaviour the spec asks for; `cargo test -p atlas-agent-servers --test
//! conformance -- --ignored` runs them, and the package that fixes #N deletes
//! the attribute.
//!
//! # Adding a scenario
//!
//! 1. Write it in `src/test_support/scenarios.rs`, named for what the agent
//!    does (`slow_cancel`), not for the bug it found: what it advertises
//!    (`Scenario`), and a `Script` for each method it handles its own way.
//! 2. Test it in the suite of the layer that owns the behaviour — here for the
//!    connection and the wire, the manager's suite for turns and deltas —
//!    named `<scenario>_<what must hold>`.
//! 3. If Atlas gets it wrong today, ignore it with the audit number, and run
//!    it with `--ignored` to see it fail before committing it.

use std::sync::{Arc, MutexGuard, PoisonError};
use std::time::Duration;

use agent_client_protocol::schema::v1 as acp;
use atlas_acp_thread::{
    AcpThread, AcpThreadHandle, AgentConnection as _, AgentThreadEntry, AssistantMessageChunk,
    LoadError,
};
use atlas_agent_servers::test_support::{scenarios, Approver, Folder, Scenario, ScriptedAgent};
use atlas_agent_servers::{AcpConnection, AcpDebugMessageContent};

/// Long enough for a slow CI runner; a test that needs it has failed anyway.
const TIMEOUT: Duration = Duration::from_secs(15);

// ------------------------------------------------------------ resume_only

/// An agent that can resume but not load is resumed, under the id it was
/// asked for, and never sent a `session/load` it did not advertise — nor a
/// `session/new` that would quietly start over. Audit #4 is what the crash
/// rebind does with this: it asks only for a load (`agents_load_session`,
/// load-only by contract) and then starts a fresh session in the frontend
/// (`agent-rebind.ts`), which no crate test reaches.
#[tokio::test(flavor = "multi_thread")]
async fn resume_only_is_resumed_never_loaded() {
    let Some(agent) = scripted(&scenarios::resume_only()) else {
        return;
    };
    let folder = Folder::new();
    let connection = Arc::new(agent.connect().await.expect("the handshake completes"));
    assert!(!connection.supports_load_session());
    assert!(connection.supports_resume_session());

    let thread = connection
        .clone()
        .resume_session(
            acp::SessionId::new("stored-7"),
            vec![folder.path().to_path_buf()],
            None,
        )
        .await
        .expect("session/resume");
    assert_eq!(lock(&thread).session_id().to_string(), "stored-7");

    let resumes = agent.requests("session/resume");
    assert_eq!(resumes.len(), 1);
    assert_eq!(resumes[0]["sessionId"], "stored-7");
    let methods = agent.received_methods();
    assert!(
        !methods
            .iter()
            .any(|method| method == "session/load" || method == "session/new"),
        "a resume-only agent is resumed, not loaded or restarted: {methods:?}"
    );

    let stop = prompt(&connection, &thread, "where were we?").await;
    assert_eq!(
        stop.expect("the resumed session answers"),
        acp::StopReason::EndTurn
    );
}

// ------------------------------------------------- modes_as_config_option

/// The agent's `category: "mode"` select is the session's modes, so the mode
/// pill has something to show.
#[tokio::test(flavor = "multi_thread")]
async fn modes_as_config_option_become_the_sessions_modes() {
    let Some(agent) = scripted(&scenarios::modes_as_config_option()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, _thread, session_id) = open(&agent, &folder).await;

    let modes = connection
        .session_modes(&session_id)
        .expect("a mode select gives the session modes");
    let ids: Vec<String> = modes
        .all_modes()
        .iter()
        .map(|mode| mode.id.to_string())
        .collect();
    assert_eq!(ids, ["ask", "code"]);
    assert_eq!(modes.current_mode().to_string(), "ask");
}

/// A mode that came from a config option is picked the way the agent said it
/// is set: `session/set_config_option` on that option. The agent never
/// offered `session/set_mode`, so a pick sent that way is refused.
#[tokio::test(flavor = "multi_thread")]
async fn modes_as_config_option_a_pick_goes_out_as_set_config_option() {
    let Some(agent) = scripted(&scenarios::modes_as_config_option()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, _thread, session_id) = open(&agent, &folder).await;
    let modes = connection
        .session_modes(&session_id)
        .expect("a mode select gives the session modes");

    let picked = modes.set_mode(acp::SessionModeId::new("code")).await;

    let set_config = agent.requests("session/set_config_option");
    assert_eq!(
        set_config.len(),
        1,
        "the pick goes out as the option it came from; the agent was sent {:?}",
        agent.received_methods()
    );
    assert_eq!(set_config[0]["configId"], "mode");
    assert_eq!(set_config[0]["value"], "code");
    assert!(agent.requests("session/set_mode").is_empty());
    picked.expect("the agent takes the pick");
    assert_eq!(modes.current_mode().to_string(), "code");
}

// ------------------------------------------------------ mode_list_changes

/// A mode list the agent changes with `config_option_update` is the
/// session's mode list from then on — the new mode is offered and current —
/// not the list it opened with (audit #43).
#[tokio::test(flavor = "multi_thread")]
async fn mode_list_changes_reach_the_sessions_modes() {
    let Some(agent) = scripted(&scenarios::mode_list_changes()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, thread, session_id) = open(&agent, &folder).await;

    let stop = prompt(&connection, &thread, "plan it").await;
    assert_eq!(stop.expect("the turn ends"), acp::StopReason::EndTurn);

    let modes = connection
        .session_modes(&session_id)
        .expect("the session still has modes");
    let ids: Vec<String> = modes
        .all_modes()
        .iter()
        .map(|mode| mode.id.to_string())
        .collect();
    assert_eq!(ids, ["ask", "code", "architect"]);
    assert_eq!(modes.current_mode().to_string(), "architect");
}

// ------------------------------------------------------ two_model_selects

/// The model picker holds the first model select; the second is still
/// offered among the session's options and is set on its own id (audit #42).
#[tokio::test(flavor = "multi_thread")]
async fn two_model_selects_each_is_set_by_its_own_id() {
    let Some(agent) = scripted(&scenarios::two_model_selects()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, _thread, session_id) = open(&agent, &folder).await;

    let selector = connection
        .model_selector(&session_id)
        .expect("a model select gives a model picker");
    let picked = selector
        .selected_model()
        .await
        .expect("the picker has a current model");
    assert_eq!(picked.id.to_string(), "large", "the picker holds the first");

    let options = connection
        .session_config_options(&session_id)
        .expect("the options are offered");
    let ids: Vec<String> = options
        .config_options()
        .iter()
        .map(|option| option.id.to_string())
        .collect();
    assert_eq!(ids, ["model", "small_model"], "both selects are offered");

    let after = options
        .set_config_option(
            acp::SessionConfigId::new("small_model"),
            acp::SessionConfigOptionValue::from(acp::SessionConfigValueId::new("large")),
        )
        .await
        .expect("the agent takes the pick");
    let sets = agent.requests("session/set_config_option");
    assert_eq!(sets.len(), 1);
    assert_eq!(sets[0]["configId"], "small_model");
    assert_eq!(sets[0]["value"], "large");
    let small = after
        .iter()
        .find(|option| option.id.to_string() == "small_model")
        .expect("the second select is still there");
    let acp::SessionConfigKind::Select(select) = &small.kind else {
        panic!("still a select");
    };
    assert_eq!(select.current_value.to_string(), "large");
}

// --------------------------------------------------- numbers_sessions_1_2

/// Two agents that both call their first session "1" each keep their own: a
/// connection's sessions are its own (the spec scopes ids to one
/// client/agent pair). Whether the layers above keep them apart is the
/// manager suite's question (audit #86).
#[tokio::test(flavor = "multi_thread")]
async fn numbers_sessions_1_2_each_connection_keeps_its_own() {
    let (Some(first), Some(second)) = (
        scripted(&scenarios::numbers_sessions_1_2("numbering_agent_a")),
        scripted(&scenarios::numbers_sessions_1_2("numbering_agent_b")),
    ) else {
        return;
    };
    let folder = Folder::new();
    let (first_connection, first_thread, first_id) = open(&first, &folder).await;
    let (second_connection, second_thread, second_id) = open(&second, &folder).await;
    assert_eq!(first_id.to_string(), "1");
    assert_eq!(second_id.to_string(), "1");

    for (connection, thread) in [
        (&first_connection, &first_thread),
        (&second_connection, &second_thread),
    ] {
        let stop = prompt(connection, thread, "who are you?").await;
        assert_eq!(stop.expect("the turn ends"), acp::StopReason::EndTurn);
    }

    assert_eq!(assistant_text(&first_thread), "This is numbering_agent_a.");
    assert_eq!(assistant_text(&second_thread), "This is numbering_agent_b.");
}

// ------------------------------------------------------ message_id_change

/// The thread keeps two messages with different `messageId`s apart: each
/// id's chunks hold that message's text and only that. (Whether the wire
/// shows them as two messages is audit #18, in the manager suite.)
#[tokio::test(flavor = "multi_thread")]
async fn message_id_change_keeps_the_messages_apart_in_the_thread() {
    let Some(agent) = scripted(&scenarios::message_id_change()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, thread, _) = open(&agent, &folder).await;

    let stop = prompt(&connection, &thread, "fix it").await;
    assert_eq!(stop.expect("the turn ends"), acp::StopReason::EndTurn);

    let thread = lock(&thread);
    let mut by_id: Vec<(Option<String>, String)> = Vec::new();
    for entry in thread.entries() {
        let AgentThreadEntry::AssistantMessage(message) = entry else {
            continue;
        };
        for chunk in &message.chunks {
            if let AssistantMessageChunk::Message { id, block } = chunk {
                by_id.push((
                    id.as_ref().map(ToString::to_string),
                    block.to_text().to_string(),
                ));
            }
        }
    }
    assert_eq!(
        by_id,
        [
            (
                Some("message-1".to_string()),
                "Checking the file.".to_string()
            ),
            (
                Some("message-2".to_string()),
                "Here is the fix.".to_string()
            ),
        ]
    );
}

// ------------------------------------------------------- client_terminals

/// The client-owned terminal round trip works: `terminal/create`, then
/// `terminal/wait_for_exit`, `terminal/output` and `terminal/release` are
/// each answered, and the agent reads what its command printed. (Atlas asks
/// the user before it runs the command; that prompt is approved here.)
#[tokio::test(flavor = "multi_thread")]
async fn client_terminals_create_wait_read_and_release() {
    let Some(agent) = scripted(&scenarios::client_terminals()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, thread, _) = open(&agent, &folder).await;
    let _approver = Approver::start(thread.clone());

    let stop = prompt(&connection, &thread, "where are you?").await;
    assert_eq!(stop.expect("the turn ends"), acp::StopReason::EndTurn);

    let create = only_answer(&agent, "terminal/create");
    assert!(
        create["result"]["terminalId"].is_string(),
        "terminal/create answered {create}"
    );
    let exit = only_answer(&agent, "terminal/wait_for_exit");
    assert_eq!(
        exit["result"]["exitCode"], 0,
        "wait_for_exit answered {exit}"
    );
    let output = terminal_output(&agent);
    assert!(
        output.contains(scenarios::TERMINAL_DONE),
        "the output is the command's: {output:?}"
    );
    let release = only_answer(&agent, "terminal/release");
    assert!(
        release.get("result").is_some(),
        "release answered {release}"
    );
}

/// A terminal created without a `cwd` runs in the session's working
/// directory — the spec's default — not wherever the client happens to be.
#[tokio::test(flavor = "multi_thread")]
async fn client_terminals_without_cwd_run_in_the_sessions_folder() {
    let Some(agent) = scripted(&scenarios::client_terminals()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, thread, _) = open(&agent, &folder).await;
    let _approver = Approver::start(thread.clone());

    let stop = prompt(&connection, &thread, "where are you?").await;
    assert_eq!(stop.expect("the turn ends"), acp::StopReason::EndTurn);

    let output = terminal_output(&agent);
    let ran_in = output.lines().next().unwrap_or_default().trim();
    assert_eq!(
        std::fs::canonicalize(ran_in).ok(),
        std::fs::canonicalize(folder.path()).ok(),
        "the command ran in {ran_in:?}"
    );
}

// -------------------------------------------------------- non_utf8_stderr

/// A stderr line that is not UTF-8 does not end the turn: stderr is a side
/// channel, and the agent's answer still arrives.
#[tokio::test(flavor = "multi_thread")]
async fn non_utf8_stderr_does_not_end_the_turn() {
    let Some(agent) = scripted(&scenarios::non_utf8_stderr()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, thread, _) = open(&agent, &folder).await;

    let stop = prompt(&connection, &thread, "go").await;
    assert_eq!(stop.expect("the turn ends"), acp::StopReason::EndTurn);
    assert_eq!(assistant_text(&thread), "Finished.");
}

/// After a stderr line that is not UTF-8, Atlas keeps reading stderr: the
/// agent's later writes succeed, and what it says lands in the log a user
/// copies into a bug report.
#[tokio::test(flavor = "multi_thread")]
async fn non_utf8_stderr_keeps_stderr_flowing() {
    let Some(agent) = scripted(&scenarios::non_utf8_stderr()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, thread, _session_id) = open(&agent, &folder).await;

    let stop = prompt(&connection, &thread, "go").await;
    assert_eq!(stop.expect("the turn ends"), acp::StopReason::EndTurn);

    let failed: Vec<_> = agent
        .notes()
        .into_iter()
        .filter(|note| note["note"] == "stderr write failed")
        .collect();
    assert!(
        failed.is_empty(),
        "the agent's stderr was closed on it: {failed:?}"
    );
    let (logged, _) = connection.subscribe_debug_messages();
    assert!(
        logged.iter().any(|message| matches!(
            &message.message,
            AcpDebugMessageContent::Stderr { line } if line.contains(scenarios::STDERR_AFTER_BAD_BYTES)
        )),
        "stderr written after the bad bytes reaches the log"
    );
}

// --------------------------------------------------- non_utf8_stdout_line

/// A stdout line that is not UTF-8 costs at most that line: the connection
/// survives it, the rest of the turn arrives, and the next turn works.
#[tokio::test(flavor = "multi_thread")]
async fn non_utf8_stdout_line_does_not_end_the_connection() {
    let Some(agent) = scripted(&scenarios::non_utf8_stdout_line()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, thread, _) = open(&agent, &folder).await;

    let first = tokio::time::timeout(TIMEOUT, prompt(&connection, &thread, "read the log"))
        .await
        .expect("the turn ends rather than hanging");
    assert_eq!(first.expect("the turn ends"), acp::StopReason::EndTurn);
    assert!(
        assistant_text(&thread).ends_with(scenarios::TEXT_AFTER_BAD_LINE),
        "what the agent said after the bad line arrived: {:?}",
        assistant_text(&thread)
    );

    let second = tokio::time::timeout(TIMEOUT, prompt(&connection, &thread, "again"))
        .await
        .expect("the next turn ends rather than hanging");
    assert_eq!(
        second.expect("the next turn ends"),
        acp::StopReason::EndTurn
    );
}

// --------------------------------------------------- answers_behind_a_burst

/// The turn ends after its last word: every chunk the agent wrote before its
/// `session/prompt` answer is in the thread when `prompt` returns, even when
/// the answer is read out of the same write as the chunks (audit #16).
#[tokio::test(flavor = "multi_thread")]
async fn answers_behind_a_burst_the_turn_ends_after_its_last_word() {
    let Some(agent) = scripted(&scenarios::answers_behind_a_burst()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, thread, _) = open(&agent, &folder).await;

    for turn in 1..=5 {
        let stop = prompt(&connection, &thread, "go").await;
        assert_eq!(stop.expect("the turn ends"), acp::StopReason::EndTurn);
        assert_eq!(
            assistant_text(&thread).len(),
            turn * scenarios::BURST,
            "turn {turn} ended before its last chunk was applied"
        );
    }
}

/// The same, for the last chunk alone, written with the answer.
#[tokio::test(flavor = "multi_thread")]
async fn answers_then_trailing_update_keeps_the_trailing_text() {
    let Some(agent) = scripted(&scenarios::answers_then_trailing_update()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, thread, _) = open(&agent, &folder).await;

    let stop = prompt(&connection, &thread, "go").await;
    assert_eq!(stop.expect("the turn ends"), acp::StopReason::EndTurn);
    assert!(
        assistant_text(&thread).ends_with(scenarios::TRAILING_TEXT),
        "{:?}",
        assistant_text(&thread)
    );
}

// ----------------------------------------------------- replays_then_answers

/// `session/load` returns with the whole replayed history in the thread: the
/// end of the replay is awaited, not merely queued (audit #10).
#[tokio::test(flavor = "multi_thread")]
async fn replays_then_answers_load_returns_with_the_whole_history() {
    let Some(agent) = scripted(&scenarios::replays_then_answers()) else {
        return;
    };
    let folder = Folder::new();
    let connection = Arc::new(agent.connect().await.expect("the handshake completes"));
    let thread = connection
        .clone()
        .load_session(
            acp::SessionId::new("stored-1"),
            vec![folder.path().to_path_buf()],
            None,
        )
        .await
        .expect("session/load");
    assert_eq!(assistant_text(&thread).len(), scenarios::BURST);
}

// ---------------------------------------------------------------- slow_load

/// Two opens of one session while its load is in flight share that load:
/// both get the same thread, the agent is asked once, and the session is
/// closed only when the second handle goes (audit #9).
#[tokio::test(flavor = "multi_thread")]
async fn slow_load_concurrent_opens_share_one_load() {
    let Some(agent) = scripted(&scenarios::slow_load()) else {
        return;
    };
    let folder = Folder::new();
    let connection = Arc::new(agent.connect().await.expect("the handshake completes"));
    let id = acp::SessionId::new("stored-1");
    let dirs = vec![folder.path().to_path_buf()];

    let (first, second) = tokio::join!(
        connection
            .clone()
            .load_session(id.clone(), dirs.clone(), None),
        connection
            .clone()
            .load_session(id.clone(), dirs.clone(), None),
    );
    let first = first.expect("the first open loads");
    let second = second.expect("the second open joins the load");
    assert!(Arc::ptr_eq(&first, &second), "one session, one thread");
    assert_eq!(agent.requests("session/load").len(), 1);

    connection
        .clone()
        .close_session(id.clone())
        .await
        .expect("first close");
    assert!(
        agent.requests("session/close").is_empty(),
        "a handle is still open"
    );
    connection
        .clone()
        .close_session(id.clone())
        .await
        .expect("second close");
    assert!(agent
        .wait_for_request("session/close", TIMEOUT)
        .await
        .is_some());
}

/// A load abandoned midway — its deadline, or its caller giving up — leaves
/// nothing behind: the next open loads afresh instead of being told one is
/// "already in flight" until restart (audit #8, #59).
#[tokio::test(flavor = "multi_thread")]
async fn slow_load_an_abandoned_load_can_be_opened_again() {
    let Some(agent) = scripted(&scenarios::slow_load()) else {
        return;
    };
    let folder = Folder::new();
    let connection = Arc::new(agent.connect().await.expect("the handshake completes"));
    let id = acp::SessionId::new("stored-1");
    let dirs = vec![folder.path().to_path_buf()];

    let abandoned = tokio::spawn(
        connection
            .clone()
            .load_session(id.clone(), dirs.clone(), None),
    );
    agent
        .wait_for_request("session/load", TIMEOUT)
        .await
        .expect("the load went out");
    abandoned.abort();
    let _ = abandoned.await;

    let thread = connection
        .clone()
        .load_session(id.clone(), dirs, None)
        .await
        .expect("the session opens again");
    assert_eq!(lock(&thread).session_id(), &id);
}

// ------------------------------------- announces_before_answering_new_session

/// An update the agent sends for a session before it has answered
/// `session/new` is kept, not dropped as "unknown session" (audit #12).
#[tokio::test(flavor = "multi_thread")]
async fn announces_before_answering_new_session_keeps_the_early_update() {
    let Some(agent) = scripted(&scenarios::announces_before_answering_new_session()) else {
        return;
    };
    let folder = Folder::new();
    let (_connection, thread, _) = open(&agent, &folder).await;
    let names: Vec<String> = lock(&thread)
        .available_commands()
        .iter()
        .map(|command| command.name.clone())
        .collect();
    assert_eq!(names, ["review"]);
}

// ---------------------------------------------------- speaks_a_newer_protocol

/// A protocol version above the one Atlas speaks is refused at the handshake,
/// rather than spoken to as if it were v1 (audit #14).
#[tokio::test(flavor = "multi_thread")]
async fn speaks_a_newer_protocol_is_refused() {
    let Some(agent) = scripted(&scenarios::speaks_a_newer_protocol()) else {
        return;
    };
    let error = agent
        .connect()
        .await
        .expect_err("a newer protocol is refused");
    assert!(
        matches!(
            error.downcast_ref::<LoadError>(),
            Some(LoadError::Unsupported { .. })
        ),
        "{error:?}"
    );
}

// ------------------------------------------------- never_answers_housekeeping

/// `session/close`, `logout` and `session/delete` each give up at a deadline
/// instead of waiting forever on an agent that never answers (audit #13).
#[tokio::test(flavor = "current_thread")]
async fn never_answers_housekeeping_each_call_has_a_deadline() {
    let Some(agent) = scripted(&scenarios::never_answers_housekeeping()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, _thread, session_id) = open(&agent, &folder).await;
    let list = connection.session_list().expect("the agent can list");
    // From here the clock only moves when nothing else can: a deadline fires
    // at once, a wait with none never ends.
    tokio::time::pause();
    let ten_minutes = Duration::from_secs(600);

    let close = tokio::time::timeout(
        ten_minutes,
        connection.clone().close_session(session_id.clone()),
    )
    .await
    .expect("session/close gives up");
    assert!(close.is_err());
    let logout = tokio::time::timeout(ten_minutes, connection.logout())
        .await
        .expect("logout gives up");
    assert!(logout.is_err());
    let delete = tokio::time::timeout(ten_minutes, list.delete_session(&session_id))
        .await
        .expect("session/delete gives up");
    assert!(delete.is_err());
}

// ---------------------------------------------------------------------- forks

/// An agent that advertises `sessionCapabilities.fork` is forked through
/// `session/fork`, and the branch's id is the agent's answer (audit #15).
#[tokio::test(flavor = "multi_thread")]
async fn forks_a_session_through_session_fork() {
    let Some(agent) = scripted(&scenarios::forks()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, _thread, session_id) = open(&agent, &folder).await;
    assert!(connection.supports_fork());

    let forked = connection
        .fork(&session_id)
        .expect("a fork is offered")
        .run()
        .await
        .expect("session/fork");
    assert_eq!(forked.to_string(), "forked-1");
    let forks = agent.requests("session/fork");
    assert_eq!(forks.len(), 1);
    assert_eq!(forks[0]["sessionId"], session_id.to_string());
    assert_eq!(
        forks[0]["cwd"].as_str().map(std::path::PathBuf::from),
        Some(folder.path().to_path_buf())
    );
}

/// An agent that does not advertise it is never sent one.
#[tokio::test(flavor = "multi_thread")]
async fn without_the_capability_no_fork_is_offered() {
    let Some(agent) = scripted(&scenarios::message_id_change()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, _thread, session_id) = open(&agent, &folder).await;
    assert!(!connection.supports_fork());
    assert!(connection.fork(&session_id).is_none());
}

// -------------------------------------------------- options_announced_later

/// Config options an agent first announces after `session/new` are stored and
/// offered, not dropped because none came with the session (audit #37).
#[tokio::test(flavor = "multi_thread")]
async fn options_announced_later_are_kept() {
    let Some(agent) = scripted(&scenarios::options_announced_later()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, thread, session_id) = open(&agent, &folder).await;

    let stop = prompt(&connection, &thread, "go").await;
    assert_eq!(stop.expect("the turn ends"), acp::StopReason::EndTurn);
    let options = connection
        .session_config_options(&session_id)
        .expect("the announced options are offered");
    let ids: Vec<String> = options
        .config_options()
        .iter()
        .map(|option| option.id.to_string())
        .collect();
    assert_eq!(ids, ["effort"]);
}

// ---------------------------------------------------------------- slow_sign_in

/// An interactive sign-in has no fixed cap — a user can take longer than two
/// minutes in a browser — and is ended by the user instead (audit #67).
#[tokio::test(flavor = "current_thread")]
async fn slow_sign_in_waits_for_the_user_and_can_be_cancelled() {
    let Some(agent) = scripted(&scenarios::slow_sign_in()) else {
        return;
    };
    let connection = Arc::new(agent.connect().await.expect("the handshake completes"));
    tokio::time::pause();

    let sign_in = connection.authenticate(acp::AuthMethodId::new("browser"));
    tokio::pin!(sign_in);
    assert!(
        tokio::time::timeout(Duration::from_secs(600), &mut sign_in)
            .await
            .is_err(),
        "the sign-in is still waiting after ten minutes"
    );

    connection.cancel_authentication();
    let ended = tokio::time::timeout(Duration::from_secs(1), sign_in)
        .await
        .expect("cancelling ends the sign-in");
    assert!(ended.is_err(), "a cancelled sign-in is not a success");
}

// -------------------------------------------------------- closes_stdout_mid_turn

/// A transport that dies while the process lives on marks the agent gone, so
/// the UI stops calling it connected (audit #71, #87).
#[tokio::test(flavor = "multi_thread")]
async fn closes_stdout_mid_turn_the_agent_is_marked_gone() {
    let Some(agent) = scripted(&scenarios::closes_stdout_mid_turn()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, thread, _) = open(&agent, &folder).await;

    let turn = tokio::spawn({
        let connection = connection.clone();
        let thread = thread.clone();
        async move { prompt(&connection, &thread, "go").await }
    });
    tokio::time::timeout(TIMEOUT, connection.clone().exited())
        .await
        .expect("the connection reports its agent gone");
    let ended = tokio::time::timeout(TIMEOUT, turn)
        .await
        .expect("the turn ends rather than hanging")
        .expect("the turn task");
    assert!(ended.is_err(), "a turn cut off by a dead transport fails");
}

// ----------------------------------------------------- asks_then_runs_a_terminal

/// An agent that already asked the user through
/// `session/request_permission` for its tool call is not asked again by
/// Atlas when it runs the command (audit #28).
#[tokio::test(flavor = "multi_thread")]
async fn asks_then_runs_a_terminal_is_asked_once() {
    let Some(agent) = scripted(&scenarios::asks_then_runs_a_terminal()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, thread, _) = open(&agent, &folder).await;
    let _approver = Approver::start(thread.clone());

    let stop = prompt(&connection, &thread, "say hi").await;
    assert_eq!(stop.expect("the turn ends"), acp::StopReason::EndTurn);
    let create = only_answer(&agent, "terminal/create");
    assert!(create["result"]["terminalId"].is_string(), "{create}");
    let atlas_prompts: Vec<String> = lock(&thread)
        .entries()
        .iter()
        .filter_map(|entry| match entry {
            AgentThreadEntry::ToolCall(call) if call.id.to_string().starts_with("terminal-") => {
                Some(call.id.to_string())
            }
            _ => None,
        })
        .collect();
    assert!(
        atlas_prompts.is_empty(),
        "Atlas asked a second time: {atlas_prompts:?}"
    );
}

/// An agent that did not ask is asked by Atlas — and when the user declines,
/// the agent hears a refusal, not an internal error of the client's.
#[tokio::test(flavor = "multi_thread")]
async fn client_terminals_a_declined_command_is_refused_not_an_internal_error() {
    let Some(agent) = scripted(&scenarios::client_terminals()) else {
        return;
    };
    let folder = Folder::new();
    let (connection, thread, _) = open(&agent, &folder).await;
    let _rejecter = Approver::rejecting(thread.clone());

    // The script cannot go on without a terminal; how it ends is its own.
    let _ = prompt(&connection, &thread, "where are you?").await;
    let create = only_answer(&agent, "terminal/create");
    let code = create["error"]["code"]
        .as_i64()
        .unwrap_or_else(|| panic!("a declined command is an error answer: {create}"));
    assert_ne!(code, -32603, "a decline is not an internal error: {create}");
}

// -------------------------------------------------------------- harness

/// The scenario's agent, or `None` (and a note) where there is no python3.
fn scripted(scenario: &Scenario) -> Option<ScriptedAgent> {
    let agent = ScriptedAgent::new(scenario);
    if agent.is_none() {
        eprintln!("skipping: no python3 on this machine");
    }
    agent
}

/// Connect and open one session in `folder`. The thread is handed back
/// because the connection only holds it weakly.
async fn open(
    agent: &ScriptedAgent,
    folder: &Folder,
) -> (Arc<AcpConnection>, AcpThreadHandle, acp::SessionId) {
    let connection = Arc::new(agent.connect().await.expect("the handshake completes"));
    let thread = connection
        .clone()
        .new_session(vec![folder.path().to_path_buf()])
        .await
        .expect("session/new");
    let session_id = lock(&thread).session_id().clone();
    (connection, thread, session_id)
}

/// One turn, opened on the thread first as the manager opens it
/// (`AgentManager::send` calls `begin_turn` before `session/prompt` goes out):
/// a request the agent makes outside a running turn is refused.
async fn prompt(
    connection: &Arc<AcpConnection>,
    thread: &AcpThreadHandle,
    text: &str,
) -> anyhow::Result<acp::StopReason> {
    let session_id = {
        let mut thread = lock(thread);
        thread.begin_turn();
        thread.session_id().clone()
    };
    connection
        .prompt(acp::PromptRequest::new(
            session_id,
            vec![acp::ContentBlock::from(text)],
        ))
        .await
        .map(|response| response.stop_reason)
}

fn lock(thread: &AcpThreadHandle) -> MutexGuard<'_, AcpThread> {
    thread.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Every assistant message chunk's text in the thread, run together.
fn assistant_text(thread: &AcpThreadHandle) -> String {
    let thread = lock(thread);
    let mut text = String::new();
    for entry in thread.entries() {
        if let AgentThreadEntry::AssistantMessage(message) = entry {
            for chunk in &message.chunks {
                if !chunk.is_thought() {
                    text.push_str(chunk.block().to_text());
                }
            }
        }
    }
    text
}

/// The client's one answer to the agent's one request of `method`.
fn only_answer(agent: &ScriptedAgent, method: &str) -> serde_json::Value {
    let mut answers = agent.answers(method);
    assert_eq!(answers.len(), 1, "one {method} answered: {answers:?}");
    answers.remove(0)
}

/// What `terminal/output` gave the agent.
fn terminal_output(agent: &ScriptedAgent) -> String {
    let output = only_answer(agent, "terminal/output");
    output["result"]["output"]
        .as_str()
        .unwrap_or_else(|| panic!("terminal/output answered {output}"))
        .to_string()
}
