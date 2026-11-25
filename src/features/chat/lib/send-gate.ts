/**
 * What a send does, given a session's state. The pure half of the send module
 * (`session-send.ts` carries the decisions out).
 *
 * One question used to be answered in three places that restated each other:
 * the panel's send handler walked the gates, the drain effect detected their
 * edges, and the composer derived what to show from the same facts. This file
 * is the one answer:
 *
 * - `sendGate(state)`: is this session gated, and why. The composer, the send
 *   handler and the drain all read it.
 * - `decide(state, intent)`: what a send, a stop, a drain tick or a retry
 *   does now.
 *
 * No React, no store, no IPC: the transcript evaluates `sessionCanRetry`
 * inside a store selector on the hot render path, and a pure module is the
 * only way to test the gates without standing up Tauri's event bridge.
 *
 * # Where the old copies disagreed
 *
 * They are kept as they were, each one named here rather than hidden in a
 * call site. None is decided by this file; see the callers.
 *
 * - **Three meanings of "a turn is running".** The send handler and the retry
 *   ask `isBusyAgentStatus` (running, or waiting on a permission). The drain
 *   asks `status === "running"` only, so a turn that pauses on a permission
 *   reads as a turn end (`drainEdges`). The composer adds tool calls still in
 *   flight (`composerGates`' `running`).
 * - **Mid-turn, the composer queues and every other sender dispatches.** The
 *   composer never reaches `decide`'s send while a turn runs (`planSubmit`
 *   queues first); a chip or a permission answer does, and goes to the agent.
 * - **The remote driver is the composer's and the retry's gate only.** A send
 *   from outside the composer does not check it (Rust refuses it); the queue
 *   release skips the drain for it.
 * - **The grant hold pauses the queue but not the held first message.** A
 *   message held for the bind goes out when the bind lands, grant or no grant.
 * - **A retry does not check the grant hold**, and sends without passing the
 *   send gates.
 */
import { isBusyAgentStatus, type ChatSession } from "@/types/agent";

/** The session's own fields a send decision reads. A `ChatSession` is one. */
export type SendSession = Partial<
  Pick<
    ChatSession,
    | "acpAgentId"
    | "acpSessionId"
    | "resumePending"
    | "unrestoredModeId"
    | "disconnected"
    | "status"
    | "stopping"
    | "pendingSend"
  >
>;

/** Everything a send decision depends on, as one snapshot. */
export interface SendState {
  session: SendSession | undefined;
  /** How many prompts the strip shows queued. */
  queued: number;
  /** The no-AI-grant answer on the agent that bills the gateway: what the
   *  composer lock would be with no turn running (`grantLocksComposer`). */
  grantHold: boolean;
  /** Someone else holds the session's remote-control seat. */
  remoteDriving: boolean;
  /** An agent switch is waiting on its `/remember` turn (`switch-agent.ts`). */
  switchPending: boolean;
}

/** Build a snapshot; anything left out is the open, idle default. */
export function sendStateOf(
  session: SendSession | undefined,
  rest: Partial<Omit<SendState, "session">> = {},
): SendState {
  return {
    session,
    queued: rest.queued ?? 0,
    grantHold: rest.grantHold ?? false,
    remoteDriving: rest.remoteDriving ?? false,
    switchPending: rest.switchPending ?? false,
  };
}

// ── The gate ────────────────────────────────────────────────────────────────

/** Why a send cannot go to the agent now, in the order a send meets them. */
export type GateReason = "mode-unrestored" | "no-grant" | "resuming" | "starting";

export interface SendGate {
  /** A resume could not restore the user's mode; no send until they pick one. */
  modeUnrestored: boolean;
  /** The gateway agent has no AI grant. */
  noGrant: boolean;
  /** A resume is still loading: the session id is optimistic. */
  resuming: boolean;
  /** No agent or no session yet. */
  unbound: boolean;
  /** Someone else holds the remote-control seat. Not one of `reason`'s: see
   *  the file header. */
  remoteDriver: boolean;
  /**
   * The drain gate: nothing leaves the queue, and a held first message stays
   * held. A resume still loading, or a mode it could not restore. Either
   * cause clearing is the release.
   */
  closed: boolean;
  /**
   * Rust's queue for the session is paused: `closed`, or the grant hold. Rust
   * drains nothing while held, and drains an idle session's head the moment
   * the last hold lifts.
   */
  holdsQueue: boolean;
  /** The first gate a send from outside the composer meets, or `null`: open. */
  reason: GateReason | null;
}

/** Is this session gated, and why. */
export function sendGate(state: SendState): SendGate {
  const s = state.session;
  const modeUnrestored = !!s?.unrestoredModeId;
  const noGrant = state.grantHold;
  const resuming = !!s?.resumePending;
  const unbound = !s?.acpAgentId || !s.acpSessionId;
  const closed = resuming || modeUnrestored;
  return {
    modeUnrestored,
    noGrant,
    resuming,
    unbound,
    remoteDriver: state.remoteDriving,
    closed,
    holdsQueue: closed || noGrant,
    reason: modeUnrestored
      ? "mode-unrestored"
      : noGrant
        ? "no-grant"
        : resuming
          ? "resuming"
          : unbound
            ? "starting"
            : null,
  };
}

/**
 * The gate as the composer applies it: what `planSubmit` and the send button
 * take (`composer-submit.ts`).
 *
 * `running` is the composer's own reading of a turn in progress: busy, or tool
 * calls still in flight. The grant lock waits for it — never while a turn
 * runs: the lock used to disable the Stop button of a turn already admitted
 * when the answer turned to no (`grantLocksComposer`).
 */
export function composerGates(
  state: SendState,
  running: boolean,
): {
  blockedByGrant: boolean;
  modeUnrestored: boolean;
  remoteDriving: boolean;
} {
  const gate = sendGate(state);
  return {
    blockedByGrant: gate.noGrant && !running,
    modeUnrestored: gate.modeUnrestored,
    remoteDriving: gate.remoteDriver,
  };
}

// ── Retry ───────────────────────────────────────────────────────────────────

export type RetryRefusal =
  | "no-session"
  | "no-rewind"
  | "remote-driver"
  | "disconnected"
  | "resuming"
  | "mode-unrestored"
  | "turn-running"
  | "stopping";

/**
 * Why this session cannot retry its last turn, or `null`: it can. Agent,
 * connection and status only.
 *
 * O(1) and allocation-free on purpose. The transcript evaluates it inside a
 * store selector, so it runs on every store write (every streaming delta);
 * anything that walked `messages` here would be quadratic across a long
 * thread's stream. Whether a given ROW is the retryable one is the
 * transcript's separate, memoized question.
 *
 * # Why a capability rather than an agent check
 *
 * THE canonical statement of this; everything else points here. Rewinding is
 * the engine's own `thread/rollback`, which is not an ACP verb. ACP's session
 * capabilities in schema 1.5.0 are `list`, `delete`, `additional_directories`,
 * `fork`, `resume`, `close` and `meta` — none of which tells an agent to
 * forget a turn. So for an ACP agent the choice is between hiding the
 * affordance and faking it with an append-and-resend that looks like a retry
 * and is not one; Atlas hides it.
 *
 * That still leaves HOW the caller knows. Comparing against the native agent's
 * id would work today and is exactly the special-casing ADR-0002 rules out, so
 * `agentSupportsRewind` comes from the connection answering for itself —
 * `AgentConnection::supports_rewind`, published onto the catalog entry as
 * `supportsRewind` — and this function only reads it. Note the honest limit:
 * the native connection answers `true` from its own impl rather than from
 * anything an agent advertised at `initialize`, because there is no ACP
 * capability to advertise. The seam is what matters here — an agent that gains
 * a rewind implements the trait and is offered the affordance, and no code
 * outside its own crate names it.
 *
 * @param agentSupportsRewind `agentCatalogEntry(agentType)?.supportsRewind`.
 *   False before the agent's first handshake, which is correct: unknown is not
 *   a licence to offer a destructive action.
 * @param remoteDriving someone other than this account holds the session's
 *   remote-control seat (`drivenElsewhere`). Retry re-sends a prompt, which
 *   only the driver may do, and rewinds a turn that may be theirs; neither is
 *   one of the owner's master powers (stop, kick, take over, close).
 */
export function retryRefusal(
  session: SendSession | undefined,
  agentSupportsRewind: boolean,
  remoteDriving = false,
): RetryRefusal | null {
  if (!session) return "no-session";
  if (!agentSupportsRewind) return "no-rewind";
  if (remoteDriving) return "remote-driver";
  if (session.disconnected) return "disconnected";
  if (session.resumePending) return "resuming";
  if (session.unrestoredModeId) return "mode-unrestored";
  // `isBusyAgentStatus` rather than a status set of our own: it also covers
  // `waiting`, the turn that is paused on a permission or plan approval.
  // Rewinding there would drop the exchange out from under a modal the user
  // is still looking at. `stopping` is the same argument for a cancelled turn
  // whose terminal delta has not landed yet.
  if (isBusyAgentStatus(session.status)) return "turn-running";
  if (session.stopping) return "stopping";
  return null;
}

/** Whether this session could retry at all (`retryRefusal`). */
export function sessionCanRetry(
  session: SendSession | undefined,
  agentSupportsRewind: boolean,
  remoteDriving = false,
): boolean {
  return retryRefusal(session, agentSupportsRewind, remoteDriving) === null;
}

// ── The drain ───────────────────────────────────────────────────────────────

/**
 * The moments a parked message may go, between two snapshots of one panel.
 *
 * These are edges, not states, and have to be: the drain used to treat any
 * `running → not running` edge as "the turn ended, send the next queued
 * message". A bind that FAILS produces that same edge: the first message is
 * held as `pendingSend` with the status `running` ("Starting …"), and the
 * failure branch parks it back in the queue and drops the status to `idle`.
 * The drain then shifted it straight back out, the send saw an unbound tab
 * and re-held it (recording a second user bubble), kicked the bind again,
 * which failed again in ~10 ms — 491 connect attempts, a bubble and an error
 * toast per cycle, until Stop (2026-09-14, engine start refused while the
 * machine had no DNS).
 *
 * The rule this encodes: a queue only drains INTO A BOUND SESSION. A turn
 * can only have finished on one, and a message dispatched into an unbound
 * tab is the loop. The bind's own success (`justBound`) and the gate's
 * falling edge (`justResumed`) are the other two legitimate moments, both of
 * which carry a session id by definition.
 *
 * And nothing drains while the gate is closed (`SendGate.closed`): a resume
 * still loading, or one that could not restore the user's mode. The gate's
 * falling edge — either cause clearing — is the release.
 *
 * The grant hold is the same shape for the native agent's no-AI-grant answer
 * (`grantLocksComposer`). That answer can land mid-turn, and the lock waits
 * for the turn to end so its Stop stays live — but a message queued during
 * that turn would then drain at the turn's end straight into a gateway that
 * refuses it. So the queue is held while the composer would be locked, and
 * released on the hold's falling edge (a Refresh that finds a grant, an org
 * switch to one that has it) on the SAME session. An agent switch is not that
 * edge: its own bind (`justBound`) drains the queue into the new agent.
 *
 * `prev` is `null` on a panel's first tick: nothing was bound before it, so a
 * panel that mounts onto a bound session reads as `justBound`. That is what
 * hands a remounted tab's local items to its session.
 */
export interface DrainEdges {
  /** The binding just landed: the held first message goes out ahead of the queue. */
  justBound: boolean;
  /** The gate just opened on a bound session: an optimistic resume became
   *  sendable, or a restored mode was picked. */
  justResumed: boolean;
  /** A real turn ended on a bound session. */
  turnFinished: boolean;
  /** The grant hold lifted on an idle, bound session. */
  grantReleased: boolean;
  /** A dead agent came back (the Restart banner, or a send's restart) on an
   *  idle session: a message held through a restart that failed goes out,
   *  and what queued behind it follows. Not while a turn runs — a send's own
   *  restart dispatches its message itself and is already running. */
  reconnected: boolean;
}

export function drainEdges(prev: SendState | null, cur: SendState): DrainEdges {
  const prevAcp = prev?.session?.acpSessionId;
  const curAcp = cur.session?.acpSessionId;
  const prevStatus = prev ? (prev.session?.status ?? "idle") : null;
  const curStatus = cur.session?.status ?? "idle";
  const prevGated = prev ? sendGate(prev).closed : false;
  const curGated = sendGate(cur).closed;
  const prevGrantHold = prev ? prev.grantHold : cur.grantHold;
  // `status === "running"`, not `isBusyAgentStatus`: see the file header.
  const wasRunning = prevStatus === "running";
  const isRunning = curStatus === "running";
  return {
    justBound: !prevAcp && !!curAcp && !curGated,
    justResumed: prevGated && !curGated && !!curAcp,
    // `curAcp` is the gate: with no session there is nothing a turn could
    // have finished on, and nothing the next message could go to.
    turnFinished: wasRunning && !isRunning && !!curAcp && !curGated,
    grantReleased:
      prevGrantHold && !cur.grantHold && !!curAcp && prevAcp === curAcp && !isRunning && !curGated,
    reconnected:
      !!prev?.session?.disconnected &&
      !cur.session?.disconnected &&
      !!curAcp &&
      !isRunning &&
      !curGated,
  };
}

// ── The decision ────────────────────────────────────────────────────────────

export type SendIntent =
  /**
   * A message from the composer's send, a chip, `atlas:chat-send`, the
   * permission modal, or the drain releasing the held first message.
   *
   * `recorded`: the user bubble, title and running status were already
   * applied when this message was held; only dispatch. `rebound`: the agent
   * was just restarted for this send, so do not ask for that again.
   */
  | { kind: "send"; recorded?: boolean; rebound?: boolean }
  /** Stop, from the composer or from outside it. */
  | { kind: "stop" }
  /** The panel's state changed; `prev` is its last snapshot (`null` at mount). */
  | { kind: "drain"; prev: SendState | null }
  /** Retry the last turn (rewind, then re-send). */
  | { kind: "retry"; supportsRewind: boolean };

export type SendDecision =
  /** Send it to the agent now. */
  | { do: "dispatch" }
  /** The first message into a session that is still starting: record it as
   *  sent, hold it on the session, make sure a bind is running. */
  | { do: "hold-first"; why: "starting" | "resuming" }
  /** Park it in the queue. */
  | { do: "queue"; why: GateReason }
  /** The agent process is gone: restart it, then decide again. */
  | { do: "rebind" }
  /** Stop while starting: abandon the bind and let go of the held message. */
  | { do: "abandon-start" }
  /** Ask the agent to stop the turn; the queue is discarded. */
  | { do: "cancel" }
  /** A second Stop: kill the agent process; the queue is discarded. */
  | { do: "kill" }
  /** A drain tick: whether the held first message, and the queue, may go. */
  | { do: "drain"; held: boolean; queue: boolean; edges: DrainEdges }
  /** Rewind the last turn and re-send its prompt. */
  | { do: "retry" }
  | { do: "refuse"; why: RetryRefusal }
  | { do: "nothing" };

/** What `intent` does to a session in `state`. */
export function decide(state: SendState, intent: SendIntent): SendDecision {
  switch (intent.kind) {
    case "send":
      return decideSend(state, intent.recorded === true, intent.rebound === true);
    case "stop":
      return decideStop(state);
    case "drain": {
      const edges = drainEdges(intent.prev, state);
      const opened = edges.justBound || edges.justResumed || edges.reconnected;
      return {
        do: "drain",
        // The first message held while the session was starting goes out
        // ahead of the queue. Not held back by the grant hold or a pending
        // switch: see the file header.
        held: opened,
        // A switch waiting on `/remember` holds the queue: what was typed
        // during the save is for the agent the tab switches to.
        queue:
          !state.grantHold &&
          !state.switchPending &&
          (edges.turnFinished || opened || edges.grantReleased),
        edges,
      };
    }
    case "retry": {
      const why = retryRefusal(state.session, intent.supportsRewind, state.remoteDriving);
      return why ? { do: "refuse", why } : { do: "retry" };
    }
  }
}

function decideSend(state: SendState, recorded: boolean, rebound: boolean): SendDecision {
  const s = state.session;
  const gate = sendGate(state);
  const busy = isBusyAgentStatus(s?.status);
  // Dead agent process: respawn + resume first, then send (H4). Explicitly
  // user-initiated — this is the "next send lazily rebinds" path.
  if (s?.disconnected && !rebound) return { do: "rebind" };
  // Fail closed on a mode a resume could not restore: queue, and the drain
  // sends it once the user has picked a mode. The composer already refuses;
  // this catches every other sender (chips, handoffs).
  if (gate.modeUnrestored) return { do: "queue", why: "mode-unrestored" };
  // The same for the no-AI-grant hold: the composer is locked, but a
  // next-step chip or a handoff is not the composer. Park it with the rest
  // of the held queue rather than send it to a gateway that will refuse it;
  // the hold's release drains it. Not mid-turn — an answer to the running
  // turn's own question belongs to the turn already admitted, and a message
  // held for the bind (`recorded`) already has its bubble.
  if (gate.noGrant && !recorded && !busy) return { do: "queue", why: "no-grant" };
  // `resumePending` is the resume-path equivalent of "not bound yet": the
  // transcript has painted from disk but the agent spawn + ACP `session/load`
  // haven't landed, so the optimistic `acpSessionId` points at a session the
  // manager hasn't installed. Queue rather than send into the void.
  if (gate.unbound || gate.resuming) {
    const why = gate.resuming ? "resuming" : "starting";
    // The FIRST message into a session that is still starting is not
    // "typed during a turn" — nothing is running, the agent is just not up
    // yet (an in-tab agent switch respawns + `session/new` in 2–3 s). Show
    // it as sent, with the agent shown as starting, and hold the prompt on
    // the session; the drain dispatches it when the bind lands. A QUEUED
    // chip here read as "Atlas didn't send it". Anything typed after it, or
    // while a turn is live, still queues.
    const first = !s?.pendingSend && state.queued === 0 && !busy;
    return first ? { do: "hold-first", why } : { do: "queue", why };
  }
  return { do: "dispatch" };
}

function decideStop(state: SendState): SendDecision {
  const s = state.session;
  // Stop while the session is still starting: nothing has been dispatched,
  // so there is nothing to cancel on the wire — just let go of the held
  // message. The bubble stays, as it would for a cancelled turn.
  if (s?.pendingSend) return { do: "abandon-start" };
  if (!s?.acpAgentId || !s.acpSessionId) return { do: "nothing" };
  // Pressing Stop again while a stop is already pending means the first one
  // did not appear to work, so escalate to killing the process. The backend
  // resolves a cancel the agent ignores after a grace period, which covers a
  // wedged *turn*; an agent that is wedged outright would hang the next turn
  // too, and this is the way out of that without quitting Atlas.
  if (s.stopping) return { do: "kill" };
  return { do: "cancel" };
}
