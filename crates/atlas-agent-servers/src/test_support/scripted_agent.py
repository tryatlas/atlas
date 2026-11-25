"""The scripted ACP agent: plays one scenario over stdio, as an agent would.

Run as `python3 -I -c <this file> <scenario.json> <log.jsonl>`. The scenario
is written by `scripted_agent.rs` (its `Scenario` and `Script` builders); read
that file first, it documents every step. This file only plays them.

Every request the client sends runs its script on a thread of its own, so a
long turn never blocks the reader: a `session/cancel`, or the client's answer
to a request this agent made, still arrives while the turn is talking.

Everything that crosses the pipe is appended to the log, one JSON object per
line, which is how a test sees exactly what Atlas put on the wire:

    {"in": <message>}                    every message the client sent
    {"out": <message>}                   every message this agent sent
    {"answer": {"method", "response"}}   the client's answer to one of ours
    {"note": "..."}                      anything that went wrong in here
"""

import json
import os
import sys
import threading
import time

SCENARIO_PATH, LOG_PATH = sys.argv[1], sys.argv[2]
with open(SCENARIO_PATH) as scenario_file:
    SCENARIO = json.load(scenario_file)

STARTED = time.monotonic()

# One lock for the shared state below, with a condition to wait on: a message
# arriving is what every waiter is waiting for.
STATE = threading.Condition()
RECEIVED = []  # (seq, method) of every request and notification, in order
ANSWERS = {}  # id of a request we sent -> the client's answer, once it came
CALLS = {}  # method -> how many times the client called it
NEXT_ID = [1000]

OUT = threading.Lock()  # one writer on stdout at a time, so frames never mix
LOG = threading.Lock()


def log(entry):
    entry["t"] = round((time.monotonic() - STARTED) * 1000)
    line = json.dumps(entry) + "\n"
    with LOG:
        try:
            with open(LOG_PATH, "a") as log_file:
                log_file.write(line)
        except OSError:
            pass  # the test is gone and took its directory with it


def frame(message):
    return (json.dumps(message, separators=(",", ":")) + "\n").encode()


def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def stdout(data, messages):
    """One `os.write` per call where the pipe allows it: `together` relies on
    a single write putting every frame in it into the pipe at once."""
    with OUT:
        write_all(1, data)
    for message in messages:
        log({"out": message})


def stderr(data):
    """Never raises: what a test asserts about stderr is whether the client
    kept reading it, so a failed write is recorded rather than fatal."""
    try:
        write_all(2, data)
    except OSError as error:
        log({"note": "stderr write failed", "error": str(error)})


class Context:
    """What one script run can refer to: the message that started it, the
    session it is talking about, and what earlier steps saved."""

    def __init__(self, message, session, seq):
        self.message = message
        self.params = message.get("params") or {}
        self.session = session
        self.seq = seq
        self.saved = {}


def lookup(ctx, path):
    head, _, rest = path.partition(".")
    if head == "params":
        value = ctx.params
    elif head == "sessionId":
        value = ctx.session
    elif head in ctx.saved:
        value = ctx.saved[head]
    else:
        raise KeyError("nothing called `%s` to fill `${%s}` with" % (head, path))
    for part in rest.split(".") if rest else []:
        value = value[int(part)] if isinstance(value, list) else value[part]
    return value


def fill(ctx, value):
    """`"${a.b}"` alone is replaced by that value, whatever its type; inside a
    longer string it is interpolated as text."""
    if isinstance(value, str):
        if value.startswith("${") and value.endswith("}") and value.count("${") == 1:
            return lookup(ctx, value[2:-1])
        out, at = "", 0
        while True:
            start = value.find("${", at)
            if start < 0:
                return out + value[at:]
            end = value.index("}", start)
            out += value[at:start] + str(lookup(ctx, value[start + 2 : end]))
            at = end + 1
    if isinstance(value, list):
        return [fill(ctx, item) for item in value]
    if isinstance(value, dict):
        return {key: fill(ctx, item) for key, item in value.items()}
    return value


def message_of(ctx, step):
    """The frame a message-shaped step writes, or None for any other step."""
    if "update" in step:
        session = fill(ctx, step.get("session", ctx.session))
        return {
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {"sessionId": session, "update": fill(ctx, step["update"])},
        }
    if "send" in step:
        message = dict(fill(ctx, step["send"]))
        message.setdefault("jsonrpc", "2.0")
        return message
    if "respond" in step:
        return {"jsonrpc": "2.0", "id": ctx.message["id"], "result": fill(ctx, step["respond"])}
    if "respond_error" in step:
        return {"jsonrpc": "2.0", "id": ctx.message["id"], "error": fill(ctx, step["respond_error"])}
    return None


def received_since(seq, method):
    return any(at > seq and name == method for at, name in RECEIVED)


def run(ctx, steps):
    for step in steps:
        run_step(ctx, step)


def run_step(ctx, step):
    message = message_of(ctx, step)
    if message is not None:
        stdout(frame(message), [message])
    elif "together" in step:
        messages, data = [], b""
        for inner in step["together"]:
            message = message_of(ctx, inner)
            if message is not None:
                messages.append(message)
                data += frame(message)
            elif "stdout_hex" in inner:
                data += bytes.fromhex(inner["stdout_hex"])
            else:
                log({"note": "only messages and stdout bytes can share a write", "step": inner})
        stdout(data, messages)
    elif "stdout_hex" in step:
        stdout(bytes.fromhex(step["stdout_hex"]), [])
    elif "stderr" in step:
        stderr((step["stderr"] + "\n").encode())
    elif "stderr_hex" in step:
        stderr(bytes.fromhex(step["stderr_hex"]))
    elif "sleep_ms" in step:
        time.sleep(step["sleep_ms"] / 1000)
    elif "request" in step:
        request(ctx, step)
    elif "wait_for" in step:
        wait_for(ctx, step["wait_for"], step.get("timeout_ms", 30000))
    elif "repeat" in step:
        until = time.monotonic() + step["for_ms"] / 1000
        n = 0
        while time.monotonic() < until:
            ctx.saved["n"] = n
            run(ctx, step["repeat"])
            n += 1
            time.sleep(step.get("every_ms", 100) / 1000)
    elif "mark" in step:
        log({"mark": fill(ctx, step["mark"])})
    elif "close_stdout" in step:
        # The transport dies while the process lives on: nothing more can
        # reach the client, and only the client's own bookkeeping can notice.
        with OUT:
            os.close(1)
        log({"mark": "stdout closed"})
    else:
        log({"note": "unknown step", "step": step})


def request(ctx, step):
    spec = fill(ctx, step["request"])
    with STATE:
        NEXT_ID[0] += 1
        request_id = NEXT_ID[0]
    message = {"jsonrpc": "2.0", "id": request_id, "method": spec["method"]}
    message["params"] = spec.get("params", {})
    stdout(frame(message), [message])
    deadline = time.monotonic() + step.get("timeout_ms", 30000) / 1000
    with STATE:
        while request_id not in ANSWERS:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            STATE.wait(remaining)
        answer = ANSWERS.pop(request_id, None)
    if answer is None:
        log({"note": "no answer", "method": spec["method"]})
        answer = {"error": {"code": -32000, "message": "the scripted agent stopped waiting"}}
    log({"answer": {"method": spec["method"], "response": answer}})
    if "save" in step:
        ctx.saved[step["save"]] = answer["result"] if "result" in answer else answer


def wait_for(ctx, method, timeout_ms):
    deadline = time.monotonic() + timeout_ms / 1000
    with STATE:
        while not received_since(ctx.seq, method):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                log({"note": "gave up waiting", "for": method})
                return
            STATE.wait(remaining)


def default_steps(method):
    """What the agent does for a method its scenario did not script. Only the
    methods every agent must answer have a default; anything else is
    "method not found", as from an agent that does not implement it."""
    if method == "initialize":
        return [{"respond": SCENARIO["initialize"]}]
    if method == "session/new":
        result = dict(SCENARIO.get("new_session") or {})
        result["sessionId"] = SCENARIO["session_id"]
        return [{"respond": result}]
    if method == "session/prompt":
        return [{"respond": {"stopReason": "end_turn"}}]
    return None


def steps_for(method, call):
    scripted = SCENARIO.get("on", {}).get(method)
    if scripted is None:
        return default_steps(method)
    if isinstance(scripted, dict):
        calls = scripted["calls"]
        return calls[min(call, len(calls) - 1)]
    return scripted


def handle(message, seq, call):
    method = message["method"]
    is_request = "id" in message
    session = (message.get("params") or {}).get("sessionId")
    if method == "session/new":
        session = SCENARIO["session_id"]
    ctx = Context(message, session, seq)
    steps = steps_for(method, call)
    try:
        if steps is None:
            if is_request:
                error = {"code": -32601, "message": "Method not found: %s" % method}
                reply = {"jsonrpc": "2.0", "id": message["id"], "error": error}
                stdout(frame(reply), [reply])
            return
        run(ctx, steps)
    except Exception as error:  # a broken script must say so, not go quiet
        log({"note": "script failed", "method": method, "error": repr(error)})
        if is_request:
            failure = {"code": -32603, "message": "scripted agent: %r" % error}
            reply = {"jsonrpc": "2.0", "id": message["id"], "error": failure}
            stdout(frame(reply), [reply])


def main():
    seq = 0
    for raw in sys.stdin.buffer:
        line = raw.decode("utf-8", "replace").strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            log({"note": "unparsable line from the client", "line": line})
            continue
        log({"in": message})
        if "method" not in message:
            with STATE:
                ANSWERS[message.get("id")] = message
                STATE.notify_all()
            continue
        with STATE:
            seq += 1
            method = message["method"]
            RECEIVED.append((seq, method))
            call = CALLS.get(method, 0)
            CALLS[method] = call + 1
            STATE.notify_all()
        worker = threading.Thread(target=handle, args=(message, seq, call), daemon=True)
        worker.start()
    # The client closed stdin: it is done with this agent.
    os._exit(0)


main()
