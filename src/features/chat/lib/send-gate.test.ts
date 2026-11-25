// What a send does, for every state a session can be in: one table over
// (state × intent), read by every test below. A row names the state once and
// states what each sender does in it, so a gate that moves shows up as a row
// that changed rather than as a behaviour nobody wrote down.
//
// The drain's edge cases and the retry's own cases are next door
// (`send-gate.drain.test.ts`, `send-gate.retry.test.ts`), carried over from
// the files this module replaced.

import { describe, expect, it } from "vitest";
import { isBusyAgentStatus } from "@/types/agent";
import { planSubmit } from "./composer-submit";
import {
  composerGates,
  decide,
  sendGate,
  sendStateOf,
  type SendDecision,
  type SendSession,
  type SendState,
} from "./send-gate";

const BOUND: SendSession = { acpAgentId: "agent-1", acpSessionId: "sess-1", status: "idle" };
const HELD = { content: "first", mentions: [] };

interface Row {
  name: string;
  state: SendState;
  /** Tool calls still in flight: the composer's reading of "running" only. */
  toolsInFlight?: boolean;
  /** What Enter does in the composer (`planSubmit`, with text typed). */
  composer: "send" | "blocked" | "enqueue";
  /** A send from outside the composer: a chip, `atlas:chat-send`, the permission modal. */
  direct: SendDecision;
  /** The held first message, when the drain releases it. */
  recorded: SendDecision;
  stop: SendDecision;
  /** On an agent that can rewind. */
  retry: SendDecision;
  /** The composer and a direct send do different things here, on purpose
   *  (the file header of `send-gate.ts` lists each). */
  differs?: "mid-turn" | "remote-driver";
}

const dispatch: SendDecision = { do: "dispatch" };
const cancel: SendDecision = { do: "cancel" };
const retry: SendDecision = { do: "retry" };
const queue = (why: Extract<SendDecision, { do: "queue" }>["why"]): SendDecision => ({
  do: "queue",
  why,
});
const refuse = (why: Extract<SendDecision, { do: "refuse" }>["why"]): SendDecision => ({
  do: "refuse",
  why,
});

const ROWS: Row[] = [
  {
    name: "bound and idle",
    state: sendStateOf(BOUND),
    composer: "send",
    direct: dispatch,
    recorded: dispatch,
    stop: cancel,
    retry,
  },
  {
    name: "a turn running",
    state: sendStateOf({ ...BOUND, status: "running" }),
    composer: "enqueue",
    direct: dispatch,
    recorded: dispatch,
    stop: cancel,
    retry: refuse("turn-running"),
    differs: "mid-turn",
  },
  {
    name: "a turn waiting on a permission or a question",
    state: sendStateOf({ ...BOUND, status: "waiting" }),
    composer: "enqueue",
    direct: dispatch,
    recorded: dispatch,
    stop: cancel,
    retry: refuse("turn-running"),
    differs: "mid-turn",
  },
  {
    name: "tool calls in flight after the status went idle",
    state: sendStateOf(BOUND),
    toolsInFlight: true,
    composer: "enqueue",
    direct: dispatch,
    recorded: dispatch,
    stop: cancel,
    retry,
    differs: "mid-turn",
  },
  {
    name: "stopping",
    state: sendStateOf({ ...BOUND, status: "running", stopping: true }),
    composer: "enqueue",
    direct: dispatch,
    recorded: dispatch,
    stop: { do: "kill" },
    retry: refuse("turn-running"),
    differs: "mid-turn",
  },
  {
    name: "stop requested, terminal not landed, status already idle",
    state: sendStateOf({ ...BOUND, stopping: true }),
    composer: "send",
    direct: dispatch,
    recorded: dispatch,
    stop: { do: "kill" },
    retry: refuse("stopping"),
  },
  {
    name: "a failed turn",
    state: sendStateOf({ ...BOUND, status: "error" }),
    composer: "send",
    direct: dispatch,
    recorded: dispatch,
    stop: cancel,
    retry,
  },
  {
    name: "no session at all",
    state: sendStateOf(undefined),
    composer: "send",
    direct: { do: "hold-first", why: "starting" },
    recorded: { do: "hold-first", why: "starting" },
    stop: { do: "nothing" },
    retry: refuse("no-session"),
  },
  {
    name: "not bound yet, nothing sent",
    state: sendStateOf({ status: "idle" }),
    composer: "send",
    direct: { do: "hold-first", why: "starting" },
    recorded: { do: "hold-first", why: "starting" },
    stop: { do: "nothing" },
    retry,
  },
  {
    name: "not bound yet, a first message held",
    state: sendStateOf({ status: "running", pendingSend: HELD }),
    composer: "enqueue",
    direct: queue("starting"),
    recorded: queue("starting"),
    stop: { do: "abandon-start" },
    retry: refuse("turn-running"),
  },
  {
    name: "not bound, a message parked by a failed bind",
    state: sendStateOf({ status: "idle" }, { queued: 1 }),
    composer: "send",
    direct: queue("starting"),
    recorded: queue("starting"),
    stop: { do: "nothing" },
    retry,
  },
  {
    name: "a resume still loading",
    state: sendStateOf({ ...BOUND, resumePending: true }),
    composer: "send",
    direct: { do: "hold-first", why: "resuming" },
    recorded: { do: "hold-first", why: "resuming" },
    stop: cancel,
    retry: refuse("resuming"),
  },
  {
    name: "a resume still loading, a first message held",
    state: sendStateOf({ ...BOUND, status: "running", resumePending: true, pendingSend: HELD }),
    composer: "enqueue",
    direct: queue("resuming"),
    recorded: queue("resuming"),
    stop: { do: "abandon-start" },
    retry: refuse("resuming"),
  },
  {
    name: "a mode the resume could not restore",
    state: sendStateOf({ ...BOUND, unrestoredModeId: "plan" }),
    composer: "blocked",
    direct: queue("mode-unrestored"),
    recorded: queue("mode-unrestored"),
    stop: cancel,
    retry: refuse("mode-unrestored"),
  },
  {
    name: "a mode the resume could not restore, mid-turn",
    state: sendStateOf({ ...BOUND, status: "running", unrestoredModeId: "plan" }),
    composer: "enqueue",
    direct: queue("mode-unrestored"),
    recorded: queue("mode-unrestored"),
    stop: cancel,
    retry: refuse("mode-unrestored"),
  },
  {
    name: "no AI grant",
    state: sendStateOf(BOUND, { grantHold: true }),
    composer: "blocked",
    direct: queue("no-grant"),
    // A message held for the bind already has its bubble: it goes.
    recorded: dispatch,
    stop: cancel,
    // Kept as found: a retry does not check the grant hold.
    retry,
  },
  {
    name: "no AI grant, mid-turn: the turn was already admitted",
    state: sendStateOf({ ...BOUND, status: "running" }, { grantHold: true }),
    composer: "enqueue",
    direct: dispatch,
    recorded: dispatch,
    stop: cancel,
    retry: refuse("turn-running"),
    differs: "mid-turn",
  },
  {
    name: "no AI grant, not bound yet",
    state: sendStateOf({ status: "idle" }, { grantHold: true }),
    composer: "blocked",
    direct: queue("no-grant"),
    recorded: { do: "hold-first", why: "starting" },
    stop: { do: "nothing" },
    retry,
  },
  {
    name: "a remote driver holds the seat",
    state: sendStateOf(BOUND, { remoteDriving: true }),
    composer: "blocked",
    direct: dispatch,
    recorded: dispatch,
    stop: cancel,
    retry: refuse("remote-driver"),
    differs: "remote-driver",
  },
  {
    name: "a remote driver holds the seat, mid-turn",
    state: sendStateOf({ ...BOUND, status: "running" }, { remoteDriving: true }),
    composer: "blocked",
    direct: dispatch,
    recorded: dispatch,
    stop: cancel,
    retry: refuse("remote-driver"),
    differs: "remote-driver",
  },
  {
    name: "the agent process is gone",
    state: sendStateOf({ ...BOUND, disconnected: true }),
    composer: "send",
    direct: { do: "rebind" },
    recorded: { do: "rebind" },
    stop: cancel,
    retry: refuse("disconnected"),
  },
  {
    name: "the agent process is gone and a mode is unrestored: restart first",
    state: sendStateOf({ ...BOUND, disconnected: true, unrestoredModeId: "plan" }),
    composer: "blocked",
    direct: { do: "rebind" },
    recorded: { do: "rebind" },
    stop: cancel,
    retry: refuse("disconnected"),
  },
];

/** The composer's own reading of a turn in progress (`chat-panel.tsx`). */
const composerRunning = (row: Row) =>
  isBusyAgentStatus(row.state.session?.status) || !!row.toolsInFlight;

function composerPlan(row: Row): Row["composer"] {
  const gates = composerGates(row.state, composerRunning(row));
  const { kind } = planSubmit({
    text: "hello",
    disabled: gates.blockedByGrant,
    githubSyncing: false,
    running: composerRunning(row),
    remoteDriving: gates.remoteDriving,
    modeUnrestored: gates.modeUnrestored,
    atlasCommands: { fork: null, queue: "queue" },
  });
  if (kind !== "send" && kind !== "blocked" && kind !== "enqueue") {
    throw new Error(`plain text never plans "${kind}"`);
  }
  return kind;
}

describe("what each sender does, by state", () => {
  describe.each(ROWS)("$name", (row) => {
    it("the composer", () => expect(composerPlan(row)).toBe(row.composer));
    it("a send from outside the composer", () =>
      expect(decide(row.state, { kind: "send" })).toEqual(row.direct));
    it("the held first message", () =>
      expect(decide(row.state, { kind: "send", recorded: true })).toEqual(row.recorded));
    it("Stop", () => expect(decide(row.state, { kind: "stop" })).toEqual(row.stop));
    it("a retry", () =>
      expect(decide(row.state, { kind: "retry", supportsRewind: true })).toEqual(row.retry));
  });

  it("a retry is refused on an agent that cannot rewind, in every state with a session", () => {
    for (const row of ROWS.filter((r) => r.state.session)) {
      expect(decide(row.state, { kind: "retry", supportsRewind: false })).toEqual(
        refuse("no-rewind"),
      );
    }
  });

  it("a restarted agent is not asked to restart again, and still meets the gates", () => {
    const gone = sendStateOf({ ...BOUND, disconnected: true });
    expect(decide(gone, { kind: "send", rebound: true })).toEqual(dispatch);
    const goneUnrestored = sendStateOf({ ...BOUND, disconnected: true, unrestoredModeId: "plan" });
    expect(decide(goneUnrestored, { kind: "send", rebound: true })).toEqual(
      queue("mode-unrestored"),
    );
  });
});

describe("the composer and the send handler read one gate", () => {
  // What the handler does once any restart is behind it.
  const settled = (row: Row): SendDecision => {
    const first = decide(row.state, { kind: "send" });
    return first.do === "rebind" ? decide(row.state, { kind: "send", rebound: true }) : first;
  };
  // "Agree" means: what the composer lets through is not then stopped by a
  // gate it did not show, and what the composer refuses is not sent by another
  // sender. Starting and resuming are not composer gates (ADR-0002: the
  // composer is never disabled by an agent's readiness), so a send that is
  // held or queued for the bind agrees with "send".
  const agrees = (composer: Row["composer"], d: SendDecision): boolean => {
    const waitsForBind =
      d.do === "hold-first" || (d.do === "queue" && (d.why === "starting" || d.why === "resuming"));
    switch (composer) {
      case "send":
        return d.do === "dispatch" || waitsForBind;
      case "blocked":
        return d.do === "queue" && !waitsForBind;
      case "enqueue":
        return d.do === "queue";
    }
  };

  it.each(ROWS)("$name", (row) => {
    // Every difference is a named one, and every named one is real.
    expect(agrees(composerPlan(row), settled(row))).toBe(row.differs === undefined);
  });

  it("the reason the composer blocks for is the reason the handler queues for", () => {
    for (const row of ROWS.filter((r) => r.composer === "blocked" && !r.differs)) {
      const gates = composerGates(row.state, composerRunning(row));
      const d = settled(row);
      const why = d.do === "queue" ? d.why : null;
      expect({
        "mode-unrestored": gates.modeUnrestored,
        "no-grant": gates.blockedByGrant,
      }).toHaveProperty([why ?? ""], true);
    }
  });

  it("names exactly the two differences", () => {
    expect([...new Set(ROWS.map((r) => r.differs).filter(Boolean))].sort()).toEqual([
      "mid-turn",
      "remote-driver",
    ]);
  });
});

describe("the gate", () => {
  it("is open on a bound, idle session", () => {
    expect(sendGate(sendStateOf(BOUND))).toMatchObject({
      reason: null,
      closed: false,
      holdsQueue: false,
    });
  });

  it("closes the drain for a resume and an unrestored mode", () => {
    for (const state of [
      sendStateOf({ ...BOUND, resumePending: true }),
      sendStateOf({ ...BOUND, unrestoredModeId: "plan" }),
    ]) {
      expect(sendGate(state)).toMatchObject({ closed: true, holdsQueue: true });
    }
  });

  it("holds Rust's queue for the grant without closing the drain", () => {
    expect(sendGate(sendStateOf(BOUND, { grantHold: true }))).toMatchObject({
      closed: false,
      holdsQueue: true,
      reason: "no-grant",
    });
  });

  it("does not hold the queue of a session that is merely not bound, or remotely driven", () => {
    expect(sendGate(sendStateOf({ status: "idle" }))).toMatchObject({
      holdsQueue: false,
      reason: "starting",
    });
    expect(sendGate(sendStateOf(BOUND, { remoteDriving: true }))).toMatchObject({
      holdsQueue: false,
      reason: null,
      remoteDriver: true,
    });
  });

  it("never locks the composer for the grant while a turn runs", () => {
    const state = sendStateOf({ ...BOUND, status: "running" }, { grantHold: true });
    expect(composerGates(state, true).blockedByGrant).toBe(false);
    expect(composerGates(state, false).blockedByGrant).toBe(true);
  });
});

describe("a drain tick", () => {
  const drain = (cur: SendState, prev: SendState | null) => {
    const d = decide(cur, { kind: "drain", prev });
    if (d.do !== "drain") throw new Error("a drain intent decides a drain");
    return d;
  };

  it("a panel mounting onto a bound session reads as a bind: held message and queue may go", () => {
    expect(drain(sendStateOf(BOUND), null)).toMatchObject({ held: true, queue: true });
  });

  it("a panel mounting onto an unbound or gated session releases nothing", () => {
    expect(drain(sendStateOf({ status: "idle" }), null)).toMatchObject({
      held: false,
      queue: false,
    });
    expect(drain(sendStateOf({ ...BOUND, resumePending: true }), null)).toMatchObject({
      held: false,
      queue: false,
    });
  });

  it("a panel mounting under the grant hold releases the held message but not the queue", () => {
    expect(drain(sendStateOf(BOUND, { grantHold: true }), null)).toMatchObject({
      held: true,
      queue: false,
    });
  });

  it("nothing changing releases nothing", () => {
    const state = sendStateOf(BOUND);
    expect(drain(state, state)).toMatchObject({ held: false, queue: false });
  });

  it("a turn end drains the queue, and not the held message", () => {
    expect(drain(sendStateOf(BOUND), sendStateOf({ ...BOUND, status: "running" }))).toMatchObject({
      held: false,
      queue: true,
    });
  });

  it("a turn pausing on a permission reads as a turn end (kept as found)", () => {
    const d = drain(
      sendStateOf({ ...BOUND, status: "waiting" }),
      sendStateOf({ ...BOUND, status: "running" }),
    );
    expect(d.edges.turnFinished).toBe(true);
    expect(d.queue).toBe(true);
  });

  it("a switch waiting on its save holds the queue but not the held message", () => {
    const d = drain(sendStateOf(BOUND, { switchPending: true }), sendStateOf({ status: "idle" }));
    expect(d).toMatchObject({ held: true, queue: false });
  });

  it("a failed bind is not a turn end: nothing drains into an unbound tab", () => {
    // The 2026-09-14 connect loop, as the decision sees it.
    const d = drain(
      sendStateOf({ status: "idle" }, { queued: 1 }),
      sendStateOf({ status: "running", pendingSend: HELD }),
    );
    expect(d).toMatchObject({ held: false, queue: false });
  });
});
