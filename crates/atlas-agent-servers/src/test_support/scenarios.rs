//! The named scenarios: agents that do not behave like Claude.
//!
//! Each function is one way a spec-compliant ACP agent behaves that Atlas has
//! to handle, named after the behaviour rather than after a bug. Together they
//! are the working definition of "works with any ACP agent" (ADR-0002): a new
//! agent bug found in the field becomes a new function here, plus a test in
//! the conformance suite of the layer that owns the behaviour —
//! `atlas-agent-servers/tests/conformance.rs` for the connection and the wire;
//! a suite for turns and the delta projection belongs in
//! `atlas-agent-manager`, which does not have one yet. The audit finding each
//! one came from is named on it.

use std::time::Duration;

use serde_json::{json, Value};

use super::{Scenario, Script};

/// A 1x1 PNG, the smallest image an agent can send.
pub const PNG_1X1: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

/// Advertises no `loadSession`, only `sessionCapabilities.resume`: it can
/// continue a stored session, but not replay it (audit #4).
pub fn resume_only() -> Scenario {
    Scenario::new("resume_only")
        .capabilities(json!({
            "loadSession": false,
            "sessionCapabilities": { "resume": {} },
        }))
        .answer("session/resume", json!({}))
}

/// Echoes the prompt back as a `user_message_chunk` during the turn, before
/// it answers (audit #5).
pub fn echoes_user_chunks() -> Scenario {
    Scenario::new("echoes_user_chunks").on(
        "session/prompt",
        Script::new()
            .update(json!({
                "sessionUpdate": "user_message_chunk",
                "content": "${params.prompt.0}",
            }))
            .agent_text("On it.")
            .end_turn(),
    )
}

/// Its modes are a `category: "mode"` select among its config options, and
/// it sends no `modes` (OpenCode's shape). A pick is applied with
/// `session/set_config_option`; it implements no `session/set_mode`
/// (audit #35).
pub fn modes_as_config_option() -> Scenario {
    fn options(current: &str) -> Value {
        json!([{
            "id": "mode",
            "name": "Mode",
            "category": "mode",
            "type": "select",
            "currentValue": current,
            "options": [
                { "value": "ask", "name": "Ask" },
                { "value": "code", "name": "Code" },
            ],
        }])
    }
    Scenario::new("modes_as_config_option")
        .new_session_fields(json!({ "configOptions": options("ask") }))
        .on(
            "session/set_config_option",
            Script::new().respond(json!({ "configOptions": options("${params.value}") })),
        )
}

/// [`modes_as_config_option`]'s agent, whose mode list changes mid-session:
/// during a turn it announces a third mode, `architect`, and switches to it —
/// with a `config_option_update`, the only way that wire has to say so
/// (audit #43).
pub fn mode_list_changes() -> Scenario {
    Scenario::new("mode_list_changes")
        .new_session_fields(json!({ "configOptions": [{
            "id": "mode",
            "name": "Mode",
            "category": "mode",
            "type": "select",
            "currentValue": "ask",
            "options": [
                { "value": "ask", "name": "Ask" },
                { "value": "code", "name": "Code" },
            ],
        }] }))
        .on(
            "session/prompt",
            Script::new()
                .update(json!({
                    "sessionUpdate": "config_option_update",
                    "configOptions": [{
                        "id": "mode",
                        "name": "Mode",
                        "category": "mode",
                        "type": "select",
                        "currentValue": "architect",
                        "options": [
                            { "value": "ask", "name": "Ask" },
                            { "value": "code", "name": "Code" },
                            { "value": "architect", "name": "Architect" },
                        ],
                    }],
                }))
                .end_turn(),
        )
}

/// Offers two `category: "model"` selects — the main model, and a small one
/// for quick work — each set with `session/set_config_option` on its own id
/// (audit #42).
pub fn two_model_selects() -> Scenario {
    fn options(small: &str) -> Value {
        let models = json!([
            { "value": "large", "name": "Large" },
            { "value": "small", "name": "Small" },
        ]);
        json!([
            {
                "id": "model",
                "name": "Model",
                "category": "model",
                "type": "select",
                "currentValue": "large",
                "options": models,
            },
            {
                "id": "small_model",
                "name": "Small model",
                "category": "model",
                "type": "select",
                "currentValue": small,
                "options": models,
            },
        ])
    }
    Scenario::new("two_model_selects")
        .new_session_fields(json!({ "configOptions": options("small") }))
        .on(
            "session/set_config_option",
            Script::new().respond(json!({ "configOptions": options("${params.value}") })),
        )
}

/// Numbers its sessions "1", "2", … — so two such agents both have a session
/// "1". Each says which agent it is in every reply (audit #86).
pub fn numbers_sessions_1_2(name: &str) -> Scenario {
    let reply = format!("This is {name}.");
    Scenario::new(name)
        .on_calls(
            "session/new",
            vec![
                Script::new().respond(json!({ "sessionId": "1" })),
                Script::new().respond(json!({ "sessionId": "2" })),
            ],
        )
        .on(
            "session/prompt",
            Script::new().agent_text(&reply).end_turn(),
        )
}

/// Runs a tool whose `rawInput.command` is an array of argv words, not a
/// string, and asks permission for it with that same input (audit #94).
pub fn command_as_array() -> Scenario {
    let raw_input = json!({ "command": ["git", "status", "--short"], "cwd": "." });
    Scenario::new("command_as_array").on(
        "session/prompt",
        Script::new()
            .update(json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "call-1",
                "title": "git status --short",
                "kind": "execute",
                "status": "pending",
                "rawInput": raw_input,
            }))
            .request(
                "session/request_permission",
                json!({
                    "sessionId": "${sessionId}",
                    "toolCall": { "toolCallId": "call-1", "rawInput": raw_input },
                    "options": [
                        { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
                        { "optionId": "deny", "name": "Deny", "kind": "reject_once" },
                    ],
                }),
                "permission",
            )
            .update(json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call-1",
                "status": "completed",
                "rawOutput": { "exitCode": 0, "lines": [" M src/main.rs"] },
            }))
            .agent_text("One file changed.")
            .end_turn(),
    )
}

/// The text of the last chunk [`answers_then_trailing_update`] sends.
pub const TRAILING_TEXT: &str = "Done.";

/// Writes its final `agent_message_chunk` and the `session/prompt` answer
/// back to back, in ONE write, so the client reads both out of the pipe
/// together (audit #16).
pub fn answers_then_trailing_update() -> Scenario {
    Scenario::new("answers_then_trailing_update").on(
        "session/prompt",
        Script::new()
            .agent_text("Looking into it. ")
            .sleep(Duration::from_millis(2))
            .in_one_write(Script::new().agent_text(TRAILING_TEXT).end_turn()),
    )
}

/// Takes its time over a cancel: after `session/cancel` it keeps sending
/// chunks for two seconds, and only then answers the prompt `cancelled`
/// (audit #75).
pub fn slow_cancel() -> Scenario {
    Scenario::new("slow_cancel").on(
        "session/prompt",
        Script::new()
            .agent_text("Working on it.")
            .wait_for("session/cancel")
            .repeat_for(
                Duration::from_secs(2),
                Duration::from_millis(100),
                Script::new().agent_text(" still going"),
            )
            .stop("cancelled"),
    )
}

/// The line [`client_terminals`]' command prints after its working directory.
pub const TERMINAL_DONE: &str = "terminal done";

/// Runs a command in a terminal the CLIENT owns: `terminal/create` with no
/// `cwd` (the spec's default is the session's), shown in a tool call, then
/// `terminal/wait_for_exit`, `terminal/output` and `terminal/release`. The
/// command prints its working directory, then [`TERMINAL_DONE`]
/// (audit #27, #29).
pub fn client_terminals() -> Scenario {
    Scenario::new("client_terminals").on(
        "session/prompt",
        Script::new()
            .update(json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "call-1",
                "title": "Where am I",
                "kind": "execute",
                "status": "pending",
            }))
            .request(
                "terminal/create",
                json!({
                    "sessionId": "${sessionId}",
                    "command": "/bin/sh",
                    "args": ["-c", format!("pwd; echo {TERMINAL_DONE}")],
                }),
                "terminal",
            )
            .update(json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call-1",
                "status": "in_progress",
                "content": [{ "type": "terminal", "terminalId": "${terminal.terminalId}" }],
            }))
            .request(
                "terminal/wait_for_exit",
                json!({ "sessionId": "${sessionId}", "terminalId": "${terminal.terminalId}" }),
                "exit",
            )
            .request(
                "terminal/output",
                json!({ "sessionId": "${sessionId}", "terminalId": "${terminal.terminalId}" }),
                "output",
            )
            .request(
                "terminal/release",
                json!({ "sessionId": "${sessionId}", "terminalId": "${terminal.terminalId}" }),
                "release",
            )
            .update(json!({
                "sessionUpdate": "tool_call_update",
                "toolCallId": "call-1",
                "status": "completed",
            }))
            .end_turn(),
    )
}

/// Answers with text and then an image, in `agent_message_chunk`s
/// (audit #19).
pub fn image_output() -> Scenario {
    Scenario::new("image_output").on(
        "session/prompt",
        Script::new()
            .agent_text("Here is the chart:")
            .update(json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "image", "mimeType": "image/png", "data": PNG_1X1 },
            }))
            .end_turn(),
    )
}

/// The line [`non_utf8_stderr`] writes once its bad bytes are out.
pub const STDERR_AFTER_BAD_BYTES: &str = "still talking on stderr";

/// Writes a stderr line that is not UTF-8 (a Latin-1 byte), then — a moment
/// later, so the client has read it — more stderr, and finishes its turn
/// (audit #71).
pub fn non_utf8_stderr() -> Scenario {
    Scenario::new("non_utf8_stderr").on(
        "session/prompt",
        Script::new()
            .stderr_bytes(b"warning: caf\xe9 is not UTF-8\n")
            .sleep(Duration::from_millis(300))
            .stderr_line(STDERR_AFTER_BAD_BYTES)
            .agent_text("Finished.")
            .end_turn(),
    )
}

/// The chunk [`non_utf8_stdout_line`] sends after its bad line.
pub const TEXT_AFTER_BAD_LINE: &str = "and after the bad line.";

/// Writes a `session/update` line whose text holds a byte that is not UTF-8
/// (a Latin-1 é), then carries on with its turn (audit #87).
pub fn non_utf8_stdout_line() -> Scenario {
    let scenario = Scenario::new("non_utf8_stdout_line");
    // Raw bytes cannot be templated, so the session id is spelled out: the
    // scenario's own, from its default `session/new`.
    let mut line = format!(
        r#"{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"{}","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"caf"#,
        scenario.session_id_of_new_sessions()
    )
    .into_bytes();
    line.push(0xe9);
    line.extend_from_slice(b"\"}}}}\n");
    scenario.on(
        "session/prompt",
        Script::new()
            .agent_text("Before the bad line, ")
            .stdout_bytes(&line)
            .agent_text(TEXT_AFTER_BAD_LINE)
            .end_turn(),
    )
}

/// Sends two agent messages one after the other, with different
/// `messageId`s (audit #18).
pub fn message_id_change() -> Scenario {
    Scenario::new("message_id_change").on(
        "session/prompt",
        Script::new()
            .agent_text_in("message-1", "Checking the file.")
            .agent_text_in("message-2", "Here is the fix.")
            .end_turn(),
    )
}

/// Ends its turn `refusal`: the spec says the prompt and everything after it
/// is dropped from the context, and the UI should say so (audit #20, #21).
pub fn refusal() -> Scenario {
    stops_with("refusal")
}

/// Ends its turn `max_tokens`: a normal ending, not a failure (audit #20).
pub fn max_tokens() -> Scenario {
    stops_with("max_tokens")
}

fn stops_with(reason: &str) -> Scenario {
    Scenario::new(reason).on(
        "session/prompt",
        Script::new()
            .agent_text("I can't take this any further.")
            .stop(reason),
    )
}

/// How many chunks the burst scenarios write in their one write.
pub const BURST: usize = 3000;

/// Writes [`BURST`] `agent_message_chunk`s and the `session/prompt` answer
/// in ONE write: the answer is read while the chunks are still queued for the
/// thread (audit #16).
pub fn answers_behind_a_burst() -> Scenario {
    let mut burst = Script::new();
    for _ in 0..BURST {
        burst = burst.agent_text("x");
    }
    Scenario::new("answers_behind_a_burst").on(
        "session/prompt",
        Script::new().in_one_write(burst.end_turn()),
    )
}

/// Replays a stored conversation of [`BURST`] chunks and answers
/// `session/load` in the same write (audit #10).
pub fn replays_then_answers() -> Scenario {
    let mut burst = Script::new();
    for _ in 0..BURST {
        burst = burst.agent_text("x");
    }
    Scenario::new("replays_then_answers")
        .capabilities(json!({ "loadSession": true }))
        .on(
            "session/load",
            Script::new().in_one_write(burst.respond(json!({}))),
        )
}

/// Takes 400 ms over every `session/load`, and can close sessions
/// (audit #8, #9, #59).
pub fn slow_load() -> Scenario {
    Scenario::new("slow_load")
        .capabilities(json!({
            "loadSession": true,
            "sessionCapabilities": { "close": {} },
        }))
        .on(
            "session/load",
            Script::new()
                .sleep(Duration::from_millis(400))
                .respond(json!({})),
        )
        .answer("session/close", json!({}))
}

/// Announces its slash commands for the new session BEFORE it answers
/// `session/new`, the id already decided (audit #12).
pub fn announces_before_answering_new_session() -> Scenario {
    let scenario = Scenario::new("announces_before_answering_new_session");
    let id = scenario.session_id_of_new_sessions().to_string();
    scenario.on(
        "session/new",
        Script::new()
            .update_session(
                &id,
                json!({
                    "sessionUpdate": "available_commands_update",
                    "availableCommands": [{ "name": "review", "description": "Review the diff" }],
                }),
            )
            .respond(json!({ "sessionId": id })),
    )
}

/// Answers `initialize` with a protocol version newer than any Atlas speaks
/// (audit #14).
pub fn speaks_a_newer_protocol() -> Scenario {
    Scenario::new("speaks_a_newer_protocol").protocol_version(2)
}

/// Advertises `session/close`, `session/list` + `session/delete` and
/// `logout`, and answers none of them (audit #13).
pub fn never_answers_housekeeping() -> Scenario {
    let silent = || Script::new().wait_for("never/sent");
    Scenario::new("never_answers_housekeeping")
        .capabilities(json!({
            "sessionCapabilities": { "close": {}, "list": {}, "delete": {} },
            "auth": { "logout": {} },
        }))
        .on("session/close", silent())
        .on("session/delete", silent())
        .on("logout", silent())
}

/// Advertises `sessionCapabilities.fork` and branches any session into
/// `forked-1` (audit #15).
pub fn forks() -> Scenario {
    Scenario::new("forks")
        .capabilities(json!({
            "loadSession": true,
            "sessionCapabilities": { "fork": {} },
        }))
        .answer("session/fork", json!({ "sessionId": "forked-1" }))
}

/// Sends no `configOptions` with `session/new`, and announces one mid-turn
/// (audit #37).
pub fn options_announced_later() -> Scenario {
    Scenario::new("options_announced_later").on(
        "session/prompt",
        Script::new()
            .update(json!({
                "sessionUpdate": "config_option_update",
                "configOptions": [{
                    "id": "effort",
                    "name": "Effort",
                    "category": "thought_level",
                    "type": "select",
                    "currentValue": "low",
                    "options": [
                        { "value": "low", "name": "Low" },
                        { "value": "high", "name": "High" },
                    ],
                }],
            }))
            .end_turn(),
    )
}

/// Offers one agent-run sign-in, whose `authenticate` never answers — a user
/// who has wandered off from the browser tab it opened (audit #67).
pub fn slow_sign_in() -> Scenario {
    Scenario::new("slow_sign_in")
        .auth_methods(json!([{ "id": "browser", "name": "Sign in with a browser" }]))
        .on("authenticate", Script::new().wait_for("never/sent"))
}

/// Says one thing, then closes its stdout and lives on (audit #71, #87).
pub fn closes_stdout_mid_turn() -> Scenario {
    Scenario::new("closes_stdout_mid_turn").on(
        "session/prompt",
        Script::new()
            .agent_text("Starting.")
            .sleep(Duration::from_millis(50))
            .close_stdout()
            .sleep(Duration::from_secs(30)),
    )
}

/// Asks the user through `session/request_permission` for its tool call,
/// then runs the command in a client terminal (audit #28).
pub fn asks_then_runs_a_terminal() -> Scenario {
    Scenario::new("asks_then_runs_a_terminal").on(
        "session/prompt",
        Script::new()
            .update(json!({
                "sessionUpdate": "tool_call",
                "toolCallId": "call-1",
                "title": "echo hi",
                "kind": "execute",
                "status": "pending",
            }))
            .request(
                "session/request_permission",
                json!({
                    "sessionId": "${sessionId}",
                    "toolCall": { "toolCallId": "call-1" },
                    "options": [
                        { "optionId": "allow", "name": "Allow", "kind": "allow_once" },
                        { "optionId": "deny", "name": "Deny", "kind": "reject_once" },
                    ],
                }),
                "permission",
            )
            .request(
                "terminal/create",
                json!({
                    "sessionId": "${sessionId}",
                    "command": "/bin/sh",
                    "args": ["-c", "echo hi"],
                }),
                "terminal",
            )
            .request(
                "terminal/wait_for_exit",
                json!({ "sessionId": "${sessionId}", "terminalId": "${terminal.terminalId}" }),
                "exit",
            )
            .request(
                "terminal/release",
                json!({ "sessionId": "${sessionId}", "terminalId": "${terminal.terminalId}" }),
                "release",
            )
            .end_turn(),
    )
}
