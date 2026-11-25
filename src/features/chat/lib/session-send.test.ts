// @vitest-environment happy-dom
//
// The send module through its public interface, against an in-memory agents
// port: `send`, `stop`, a panel's `watch().tick`, and the queue. The chat
// store is the real one (it is the store boundary, and it is in memory); the
// fake stands where Rust does, with a turn controller small enough to read:
// a queue, a pause gate, and a turn that starts the head when it ends.
//
// Nothing here renders. What the panel's hook and handlers add is that they
// call this correctly, which `hooks/send-wiring.test.tsx` pins.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import type { SessionKey } from "@/types/agents";
import type { RebindOutcome } from "./agent-rebind";
import { useChatStore } from "../stores/chat-store";
import type { SendState } from "./send-gate";
import { createSessionSend, type AgentsPort, type SessionSend } from "./session-send";
import type { WirePrompt } from "./wire-prompt";

const TAB = "tab-1";
const KEY: SessionKey = { agent_id: "agent-1", session_id: "sess-1" };

const store = () => useChatStore.getState();
const session = () => store().sessions[TAB];
const strip = () => store().queues[TAB] ?? [];
const userBubbles = () => session().messages.filter((m) => m.role === "user");
/** Let the module's deferred work (one microtask, then awaited port calls) run. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

/** Rust, as far as a send can tell. */
function fakeAgents() {
  let ids = 0;
  const fake = {
    /** Every port call, in order. */
    log: [] as [name: string, ...args: unknown[]][],
    /** Prompts the agent was sent, by a direct send or by the queue's drain. */
    started: [] as string[],
    queue: [] as { id: string; text: string; session: string }[],
    paused: false,
    turnRunning: false,
    /** Make the next call of a method reject, or hang until released. */
    failNext: {} as Partial<Record<keyof AgentsPort, Error>>,
    holdAdds: null as null | (() => void)[],

    calls: (name: keyof AgentsPort) => fake.log.filter((c) => c[0] === name).map((c) => c.slice(1)),

    /** The turn controller: start the head if idle and not paused. */
    drainHead() {
      if (fake.turnRunning || fake.paused) return;
      const head = fake.queue.shift();
      if (!head) return;
      fake.started.push(head.text);
      fake.turnRunning = true;
      // `queue_changed` and the turn's `running` status, as deltas would bring them.
      store().actions.removeQueueItem(TAB, 0);
      store().actions.updateSessionStatus(TAB, "running");
    },
    /** A turn ends: idle, then Rust drains its own queue. */
    turnEnds() {
      fake.turnRunning = false;
      store().actions.updateSessionStatus(TAB, "idle");
      fake.drainHead();
    },
  };
  const call = async (name: keyof AgentsPort, args: unknown[]) => {
    fake.log.push([name, ...args]);
    const err = fake.failNext[name];
    if (err) {
      delete fake.failNext[name];
      throw err;
    }
  };
  const port: AgentsPort = {
    send: async (...args) => {
      await call("send", args);
      fake.started.push(args[1]);
      fake.turnRunning = true;
    },
    cancel: async (...args) => {
      await call("cancel", args);
      fake.queue = [];
    },
    kill: async (...args) => call("kill", args),
    killPlugin: async (...args) => call("killPlugin", args),
    queueAdd: async (key, text, prompt, ...rest) => {
      await call("queueAdd", [key, text, prompt, ...rest]);
      if (fake.holdAdds) await new Promise<void>((r) => fake.holdAdds?.push(r));
      const id = `q-${++ids}`;
      fake.queue.push({ id, text, session: key.session_id });
      return id;
    },
    queueRemove: async (key, itemId) => {
      await call("queueRemove", [key, itemId]);
      const before = fake.queue.length;
      fake.queue = fake.queue.filter((q) => q.id !== itemId);
      return fake.queue.length < before;
    },
    queueClear: async (...args) => {
      await call("queueClear", args);
      fake.queue = [];
    },
    queuePause: async (key, paused) => {
      await call("queuePause", [key, paused]);
      fake.paused = paused;
      if (!paused) fake.drainHead();
    },
    queueDrain: async (...args) => {
      await call("queueDrain", args);
      fake.drainHead();
      return null;
    },
    queueResume: async (...args) => {
      await call("queueResume", args);
      fake.drainHead();
      return null;
    },
  };
  return { fake, port };
}

let fake: ReturnType<typeof fakeAgents>["fake"];
let send: SessionSend;
let ambient: Pick<SendState, "grantHold" | "remoteDriving">;
let rebind: ReturnType<typeof vi.fn<(tabId: string) => Promise<RebindOutcome>>>;
/** What composing a prompt does; a test that holds it replaces it. */
let compose: (content: string) => Promise<WirePrompt>;
let forgetAgent: ReturnType<typeof vi.fn<(pluginId: string) => void>>;
let kickBind: ReturnType<typeof vi.fn<() => void>>;
let drain: ReturnType<SessionSend["watch"]>;

/** What the panel's effect does on every change: show the drain the state. */
const tick = (watch = drain) =>
  watch.tick({
    session: session(),
    grantHold: ambient.grantHold,
  });
/** A store change the panel would re-render for, then its tick. */
async function change(mutate: () => void) {
  mutate();
  tick();
  await settle();
}
const text = (content: string) => ({ content, mentions: [] });
const bindTab = () => store().actions.setAcpBinding(TAB, KEY.agent_id, KEY.session_id, "/tmp");
const setSession = (patch: Partial<ReturnType<typeof session>>) =>
  useChatStore.setState((s) => {
    Object.assign(s.sessions[TAB], patch);
  });

beforeEach(() => {
  localStorage.clear();
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    queueIds: {},
    drafts: {},
    activeSessionId: null,
  });
  store().actions.createSession(TAB, "claude-code");
  const made = fakeAgents();
  fake = made.fake;
  ambient = { grantHold: false, remoteDriving: false };
  rebind = vi.fn(async (): Promise<RebindOutcome> => ({ ok: true }));
  compose = async (content) => ({ prompt: content, resourceLinks: [], pastedTexts: [] });
  forgetAgent = vi.fn();
  kickBind = vi.fn();
  send = createSessionSend({
    agents: made.port,
    chat: () => useChatStore.getState(),
    ambient: () => ambient,
    rebind,
    forgetAgent,
    wirePrompt: (_session, content) => compose(content),
    queuedPrompt: (queued) => queued,
  });
  drain = send.watch(TAB, { kickBind });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a send into a session that is not ready", () => {
  it("send while resuming is held and dispatched exactly once after the bind completes", async () => {
    bindTab();
    setSession({ resumePending: true });
    tick();

    await send.send(TAB, text("hello"), { kickBind });
    expect(session().pendingSend?.content).toBe("hello");
    expect(session().status).toBe("running");
    expect(userBubbles()).toHaveLength(1);
    expect(fake.started).toEqual([]);

    await change(() => setSession({ resumePending: false }));
    expect(fake.started).toEqual(["hello"]);
    expect(session().pendingSend).toBeUndefined();
    expect(userBubbles()).toHaveLength(1);
    // The bubble drawn when it was held is the one the prompt rides with.
    expect(fake.calls("send")[0][5]).toBe(userBubbles()[0].clientMessageId);

    // Nothing later sends it again: more ticks, a turn end, a remount.
    tick();
    fake.turnEnds();
    tick();
    tick(send.watch(TAB));
    await settle();
    expect(fake.calls("send")).toHaveLength(1);
  });

  it("the first message into an unbound session is held, and asks for a bind", async () => {
    tick();
    await send.send(TAB, text("hello"), { kickBind });
    expect(session().pendingSend?.content).toBe("hello");
    expect(session().title).toBe("hello");
    expect(kickBind).toHaveBeenCalledTimes(1);

    await change(bindTab);
    expect(fake.started).toEqual(["hello"]);
  });

  it("what is typed behind a held message queues, and reaches the session after it, parked", async () => {
    tick();
    await send.send(TAB, text("first"), { kickBind });
    await send.send(TAB, text("second"), { kickBind });
    await send.send(TAB, text("third"), { kickBind });
    expect(strip()).toEqual(["second", "third"]);
    expect(userBubbles()).toHaveLength(1);
    expect(kickBind).toHaveBeenCalledTimes(1);

    await change(bindTab);
    expect(fake.started).toEqual(["first"]);
    expect(fake.queue.map((q) => q.text)).toEqual(["second", "third"]);
    // Not drained by the window: Rust starts them as turns end.
    expect(fake.calls("queueDrain")).toEqual([]);
    fake.turnEnds();
    fake.turnEnds();
    expect(fake.started).toEqual(["first", "second", "third"]);
  });
});

describe("the connect loop (2026-09-14)", () => {
  it("a bind failure does not re-enter: the parked message is not sent back into the unbound tab", async () => {
    tick();
    await send.send(TAB, text("hello"), { kickBind });
    tick();
    expect(kickBind).toHaveBeenCalledTimes(1);

    // What the bind's failure branch does (`use-agent-bind.ts`): park the
    // held message in the queue and drop "Starting…" to idle. That is the
    // same status edge a finished turn makes.
    await change(() => {
      store().actions.setPendingSend(TAB, undefined);
      store().actions.updateSessionStatus(TAB, "idle");
      store().actions.enqueueMessage(TAB, "hello", []);
    });
    await change(() => {});

    expect(fake.log).toEqual([]);
    expect(kickBind).toHaveBeenCalledTimes(1);
    expect(session().pendingSend).toBeUndefined();
    expect(userBubbles()).toHaveLength(1);
    expect(strip()).toEqual(["hello"]);
  });

  it("the parked message goes to the session's queue once a later bind lands", async () => {
    tick();
    store().actions.enqueueMessage(TAB, "hello", []);
    await change(bindTab);
    expect(fake.started).toEqual(["hello"]);
    expect(fake.calls("send")).toEqual([]);
  });
});

describe("sends while a turn runs", () => {
  beforeEach(async () => {
    bindTab();
    setSession({ status: "running" });
    fake.turnRunning = true;
    tick();
    await settle();
  });

  it("send, send, send during a running turn drains in order, one per turn end", async () => {
    send.enqueue(TAB, "one", []);
    send.enqueue(TAB, "two", []);
    send.enqueue(TAB, "three", []);
    await settle();
    expect(strip()).toEqual(["one", "two", "three"]);
    expect(fake.queue.map((q) => q.text)).toEqual(["one", "two", "three"]);
    expect(fake.started).toEqual([]);

    // Each turn end: Rust starts the head, and the window's own drain request
    // (made at the same edge) starts nothing more.
    await change(() => fake.turnEnds());
    expect(fake.started).toEqual(["one"]);
    expect(strip()).toEqual(["two", "three"]);
    tick();
    await change(() => fake.turnEnds());
    expect(fake.started).toEqual(["one", "two"]);
    tick();
    await change(() => fake.turnEnds());
    expect(fake.started).toEqual(["one", "two", "three"]);
    expect(strip()).toEqual([]);
    // The window never sent a queued prompt itself.
    expect(fake.calls("send")).toEqual([]);
  });

  it("a send from outside the composer goes straight to the agent", async () => {
    await send.send(TAB, text("answer"));
    expect(fake.calls("send").map((c) => c[1])).toEqual(["answer"]);
    expect(strip()).toEqual([]);
  });

  it("stop during a queued send discards the queue, withdraws the add still on its way, and asks once", async () => {
    send.enqueue(TAB, "confirmed", []);
    await settle();
    fake.holdAdds = [];
    send.enqueue(TAB, "in flight", []);
    await settle();
    expect(strip()).toEqual(["confirmed", "in flight"]);

    send.stop(TAB);
    expect(session().stopping).toBe(true);
    // Not idle: idle arrives with the turn's real terminal.
    expect(session().status).toBe("running");
    expect(strip()).toEqual([]);
    expect(fake.calls("cancel")).toEqual([[KEY, { stop: true }]]);
    expect(fake.calls("queueClear")).toEqual([[KEY]]);

    // The add lands after the Stop: it is taken back out rather than drained.
    fake.holdAdds.forEach((release) => release());
    fake.holdAdds = null;
    await settle();
    expect(fake.calls("queueRemove")).toHaveLength(1);
    expect(fake.queue).toEqual([]);
    fake.turnEnds();
    expect(fake.started).toEqual([]);
  });

  it("a second Stop kills the agent instead of asking again", async () => {
    send.stop(TAB);
    send.stop(TAB);
    expect(fake.calls("cancel")).toHaveLength(1);
    expect(fake.calls("kill")).toEqual([[KEY.agent_id, KEY.session_id]]);
    expect(session().stopping).toBeUndefined();
    expect(session().disconnected).toBe(true);
  });

  it("a second Stop says when other chats on the agent stopped with it", async () => {
    const info = vi.spyOn(toast, "info").mockImplementation(() => "");
    useChatStore.setState((s) => {
      s.sessions["other-tab"] = {
        ...s.sessions[TAB]!,
        acpSessionId: "other-session",
      };
    });
    send.stop(TAB);
    send.stop(TAB);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![0]).toMatch(/1 other chat using it stopped too/);
  });

  it("Stop clears a permission that was waiting on the turn", () => {
    useChatStore.setState((s) => {
      s.pendingPermissions[KEY.session_id] = [{ request_id: "r1" }] as never;
    });
    send.stop(TAB);
    expect(store().pendingPermissions[KEY.session_id]).toBeUndefined();
  });
});

describe("Stop while the session is still starting", () => {
  it("abandons the bind, kills the connect, and keeps the queue", async () => {
    const abandonBind = vi.fn();
    await send.send(TAB, text("first"), { kickBind });
    await send.send(TAB, text("second"), { kickBind });

    send.stop(TAB, abandonBind);
    expect(abandonBind).toHaveBeenCalledTimes(1);
    expect(fake.calls("killPlugin")).toHaveLength(1);
    expect(forgetAgent).toHaveBeenCalledTimes(1);
    expect(fake.calls("cancel")).toEqual([]);
    expect(session().pendingSend).toBeUndefined();
    expect(session().status).toBe("idle");
    expect(userBubbles()).toHaveLength(1);
    expect(strip()).toEqual(["second"]);
  });

  it("Stop during a restart lets the held message go: nothing is sent when the agent comes back", async () => {
    bindTab();
    tick();
    await settle();
    fake.log.length = 0;
    setSession({ disconnected: true });
    let finish!: () => void;
    rebind.mockImplementation(
      () =>
        new Promise<RebindOutcome>((resolve) => {
          finish = () => {
            store().actions.setDisconnected(TAB, false);
            resolve({ ok: true });
          };
        }),
    );
    const sending = send.send(TAB, text("hello"));
    await settle();
    send.stop(TAB);
    finish();
    await sending;
    await settle();
    expect(fake.calls("send")).toEqual([]);
    expect(userBubbles()).toHaveLength(1);
    expect(session().pendingSend).toBeUndefined();
  });

  it("does nothing on a session with nothing sent and nothing bound", () => {
    send.stop(TAB);
    expect(fake.log).toEqual([]);
  });
});

describe("the gates", () => {
  beforeEach(async () => {
    bindTab();
    // The panel mounts onto a bound session: its first tick tells Rust the
    // queue is open and asks for a drain, as a bind landing does.
    tick();
    await settle();
    expect(fake.calls("queuePause")).toEqual([[KEY, false]]);
    expect(fake.calls("queueDrain")).toHaveLength(1);
    fake.log.length = 0;
  });

  it("a mode the resume could not restore: the send queues, Rust's queue is held, the pick releases it", async () => {
    await change(() => setSession({ unrestoredModeId: "plan" }));
    expect(fake.paused).toBe(true);

    await send.send(TAB, text("go"));
    await settle();
    expect(strip()).toEqual(["go"]);
    expect(fake.started).toEqual([]);

    await change(() => setSession({ unrestoredModeId: undefined }));
    expect(fake.paused).toBe(false);
    expect(fake.started).toEqual(["go"]);
    expect(fake.calls("send")).toEqual([]);
  });

  it("no AI grant: an idle send queues, a mid-turn one goes, and the queue waits out the turn's end", async () => {
    ambient.grantHold = true;
    tick();
    await send.send(TAB, text("chip"));
    await settle();
    expect(strip()).toEqual(["chip"]);
    expect(fake.paused).toBe(true);

    await change(() => setSession({ status: "running" }));
    await send.send(TAB, text("answer"));
    expect(fake.calls("send").map((c) => c[1])).toEqual(["answer"]);

    await change(() => fake.turnEnds());
    expect(fake.started).toEqual(["answer"]);

    // A Refresh finds a grant: the hold's falling edge is the release.
    ambient.grantHold = false;
    await change(() => {});
    expect(fake.started).toEqual(["answer", "chip"]);
  });

  it("a remote driver: the window hands its items over but does not ask for the drain", async () => {
    setSession({ status: "running" });
    fake.turnRunning = true;
    tick();
    ambient.remoteDriving = true;
    // An item only the window holds (typed before the session could take it).
    store().actions.enqueueMessage(TAB, "typed", []);

    // The turn ends for the window (Rust's own drain skips the owner's items
    // while the seat is held, so the fake's is not run).
    fake.turnRunning = false;
    await change(() => setSession({ status: "idle" }));
    expect(fake.queue.map((q) => q.text)).toEqual(["typed"]);
    expect(fake.calls("queueDrain")).toEqual([]);
    expect(fake.started).toEqual([]);
  });

  it("an agent switch waiting on its save holds the queue; lifting it lets Rust drain", async () => {
    send.setHold(TAB, "switch", true);
    await settle();
    expect(send.state(TAB).switchPending).toBe(true);
    expect(fake.paused).toBe(true);
    send.enqueue(TAB, "for the next agent", []);
    await settle();
    await change(() => setSession({ status: "running" }));
    await change(() => setSession({ status: "idle" }));
    expect(fake.calls("queueDrain")).toEqual([]);
    expect(fake.started).toEqual([]);

    send.setHold(TAB, "switch", false);
    await settle();
    expect(send.state(TAB).switchPending).toBe(false);
    expect(fake.started).toEqual(["for the next agent"]);
  });

  it("tells Rust the pause once per change, and again for a new session", async () => {
    await change(() => setSession({ unrestoredModeId: "plan" }));
    tick();
    tick();
    expect(fake.calls("queuePause")).toEqual([[KEY, true]]);

    await change(() => store().actions.setAcpBinding(TAB, "agent-1", "sess-2", "/tmp"));
    expect(fake.calls("queuePause").slice(-1)[0]).toEqual([
      { agent_id: "agent-1", session_id: "sess-2" },
      true,
    ]);
  });
});

describe("the agent process gone", () => {
  beforeEach(async () => {
    bindTab();
    tick();
    await settle();
    fake.log.length = 0;
    setSession({ disconnected: true });
  });

  it("the next send restarts it, then sends", async () => {
    rebind.mockImplementation(async () => {
      store().actions.setDisconnected(TAB, false);
      return { ok: true };
    });
    await send.send(TAB, text("hello"));
    expect(rebind).toHaveBeenCalledTimes(1);
    expect(fake.started).toEqual(["hello"]);
    expect(userBubbles()).toHaveLength(1);
    expect(fake.calls("send")[0][5]).toBe(userBubbles()[0].clientMessageId);
  });

  // ACP audit finding 79: the bubble used to appear only after the respawn, seconds later.
  it("the message shows at once, as starting, while the agent restarts", async () => {
    let finish!: () => void;
    rebind.mockImplementation(
      () =>
        new Promise<RebindOutcome>((resolve) => {
          finish = () => {
            store().actions.setDisconnected(TAB, false);
            resolve({ ok: true });
          };
        }),
    );
    const sending = send.send(TAB, text("hello"));
    await settle();
    expect(userBubbles().map((m) => m.content)).toEqual(["hello"]);
    expect(session().pendingSend?.content).toBe("hello");
    expect(session().status).toBe("running");
    expect(fake.started).toEqual([]);

    finish();
    await sending;
    expect(fake.started).toEqual(["hello"]);
    expect(session().pendingSend).toBeUndefined();
    expect(userBubbles()).toHaveLength(1);
  });

  // ACP audit finding 79: a second send used to start a second restart and race the first.
  it("a send during the restart queues behind the first instead of racing it", async () => {
    let finish!: () => void;
    rebind.mockImplementation(
      () =>
        new Promise<RebindOutcome>((resolve) => {
          finish = () => {
            store().actions.setDisconnected(TAB, false);
            resolve({ ok: true });
          };
        }),
    );
    const first = send.send(TAB, text("first"));
    await settle();
    const second = send.send(TAB, text("second"));
    await settle();
    expect(rebind).toHaveBeenCalledTimes(1);
    expect(strip()).toEqual(["second"]);

    finish();
    await Promise.all([first, second]);
    await settle();
    expect(fake.calls("send")).toHaveLength(1);
    expect(fake.started).toEqual(["first"]);
    expect(fake.queue.map((q) => q.text)).toEqual(["second"]);
    expect(userBubbles().map((m) => m.content)).toEqual(["first"]);
    fake.turnEnds();
    expect(fake.started).toEqual(["first", "second"]);
  });

  // ACP audit finding 62 (whole-app D8): the message was lost and the cause went to the console.
  it("a restart that fails keeps the message, says the real cause, and nothing restarts by itself", async () => {
    rebind.mockResolvedValue({ ok: false, error: "codex-acp exited with code 127" });
    const image = { mimeType: "image/png", dataBase64: "AAAA" };
    await send.send(TAB, { content: "hello", mentions: [], attachments: [image] });
    const notice = session().messages.find((m) => m.role === "assistant")?.content ?? "";
    expect(notice).toContain("codex-acp exited with code 127");
    expect(notice).not.toMatch(/node|npx/i);
    expect(userBubbles().map((m) => m.content)).toEqual(["hello"]);
    expect(session().pendingSend).toMatchObject({
      content: "hello",
      attachments: [image],
      clientMessageId: userBubbles()[0].clientMessageId,
    });
    expect(session().status).toBe("idle");
    expect(fake.log).toEqual([]);

    // A drain tick does not restart the agent.
    await change(() => setSession({ status: "running" }));
    await change(() => setSession({ status: "idle" }));
    expect(rebind).toHaveBeenCalledTimes(1);
  });

  it("a restart let go (the tab moved on) says nothing and keeps the message", async () => {
    rebind.mockResolvedValue({ ok: false, error: null });
    await send.send(TAB, text("hello"));
    expect(session().messages.map((m) => m.role)).toEqual(["user"]);
    expect(session().pendingSend?.content).toBe("hello");
  });

  it("the message kept through a failed restart goes, once, when the Restart banner brings the agent back", async () => {
    rebind.mockResolvedValue({ ok: false, error: "spawn failed" });
    const image = { mimeType: "image/png", dataBase64: "AAAA" };
    await send.send(TAB, { content: "hello", mentions: [], attachments: [image] });
    tick();

    // The banner's restart: the session is back, idle.
    await change(() => store().actions.setDisconnected(TAB, false));
    expect(fake.calls("send")).toHaveLength(1);
    expect(fake.calls("send")[0][2]).toEqual([image]);
    expect(fake.calls("send")[0][5]).toBe(userBubbles()[0].clientMessageId);
    expect(userBubbles()).toHaveLength(1);
    expect(session().pendingSend).toBeUndefined();
    tick();
    await settle();
    expect(fake.calls("send")).toHaveLength(1);
  });

  it("a send after a failed restart restarts for the kept message first, then queues behind it", async () => {
    rebind.mockResolvedValueOnce({ ok: false, error: "spawn failed" });
    await send.send(TAB, text("first"));
    rebind.mockImplementation(async () => {
      store().actions.setDisconnected(TAB, false);
      return { ok: true };
    });
    await send.send(TAB, text("second"));
    await settle();
    expect(fake.started).toEqual(["first"]);
    expect(fake.queue.map((q) => q.text)).toEqual(["second"]);
    expect(userBubbles().map((m) => m.content)).toEqual(["first"]);
  });
});

describe("what the queue survives, and what drops it", () => {
  beforeEach(bindTab);

  it("a tab switch: a remounted panel hands over what the window held, and nothing twice", async () => {
    store().actions.enqueueMessage(TAB, "kept", []);
    setSession({ status: "running" });
    fake.turnRunning = true;
    tick();
    await settle();
    expect(fake.queue.map((q) => q.text)).toEqual(["kept"]);

    // The panel unmounts and mounts again: a new watch, the same instance.
    tick(send.watch(TAB));
    await settle();
    expect(strip()).toEqual(["kept"]);
    expect(fake.calls("queueAdd")).toHaveLength(1);
  });

  it("a session rebind: the items the old session held go to the new one, in order", async () => {
    setSession({ status: "running" });
    fake.turnRunning = true;
    tick();
    send.enqueue(TAB, "mirrored", []);
    await settle();
    expect(store().queueIds[TAB]).toEqual(["q-1"]);
    // The agent process dies mid-turn, and something more is typed.
    setSession({ disconnected: true });
    store().actions.enqueueMessage(TAB, "local", []);
    rebind.mockImplementation(async () => {
      store().actions.setAcpBinding(TAB, "agent-2", "sess-2", "/tmp");
      store().actions.setDisconnected(TAB, false);
      return { ok: true };
    });

    await change(() => setSession({ status: "idle" }));
    await settle();
    expect(fake.queue.filter((q) => q.session === "sess-2").map((q) => q.text)).toEqual([
      "mirrored",
      "local",
    ]);
    expect(strip()).toEqual(["mirrored", "local"]);
  });

  it("a failed add: the prompt stays in the strip and goes at the next flush", async () => {
    fake.failNext.queueAdd = new Error("projection closed");
    send.enqueue(TAB, "kept", []);
    await settle();
    expect(strip()).toEqual(["kept"]);
    expect(store().queueIds[TAB]).toEqual([null]);

    await send.flushLocal(TAB, { drain: false });
    expect(fake.queue.map((q) => q.text)).toEqual(["kept"]);
  });

  it("a queued message goes as a direct send would: composed, with its images (ACP audit finding 80)", async () => {
    setSession({ status: "running" });
    fake.turnRunning = true;
    tick();
    compose = async (content) => ({
      prompt: `${content} [composed]`,
      resourceLinks: [{ uri: "file:///tmp/a.ts", name: "a.ts" }],
      pastedTexts: [{ id: "p1", text: "pasted" }],
    });
    const image = { mimeType: "image/png", dataBase64: "iVBO" };
    send.enqueue(TAB, "look at @a.ts", [], [image]);
    await settle();

    expect(fake.calls("queueAdd")).toEqual([
      [
        KEY,
        "look at @a.ts",
        "look at @a.ts [composed]",
        [image],
        [{ uri: "file:///tmp/a.ts", name: "a.ts" }],
        [{ id: "p1", text: "pasted" }],
      ],
    ]);
  });

  it("a long prompt the delta cut still reaches a new session whole (ACP audit finding 78)", async () => {
    setSession({ status: "running" });
    fake.turnRunning = true;
    tick();
    const long = "x".repeat(5000);
    send.enqueue(TAB, long, []);
    await settle();
    // Rust's `queue_changed` carries only the head of it.
    store().actions.applyAgentDelta({
      kind: "queue_changed",
      agent_id: KEY.agent_id,
      session_id: KEY.session_id,
      seq: 0,
      queue: [{ id: "q-1", text: long.slice(0, 2048), origin: { kind: "local" }, truncated: true }],
    });
    expect(strip()).toEqual([long]);

    // The agent dies; the restart lands on a different session.
    setSession({ disconnected: true });
    rebind.mockImplementation(async () => {
      store().actions.setAcpBinding(TAB, "agent-2", "sess-2", "/tmp");
      store().actions.setDisconnected(TAB, false);
      return { ok: true };
    });
    await change(() => setSession({ status: "idle" }));
    await settle();
    expect(fake.queue.filter((q) => q.session === "sess-2").map((q) => q.text)).toEqual([long]);
  });

  it("removing a chip takes it out of Rust's queue too", async () => {
    send.enqueue(TAB, "one", []);
    send.enqueue(TAB, "two", []);
    await settle();
    send.removeQueued(TAB, 0);
    await settle();
    expect(strip()).toEqual(["two"]);
    expect(fake.queue.map((q) => q.text)).toEqual(["two"]);
  });

  // ACP audit finding 77: a failed turn halts the queue; Resume lifts it.
  it("Resume lifts a failed turn's halt and runs the head", async () => {
    setSession({ status: "running" });
    fake.turnRunning = true;
    send.enqueue(TAB, "next", []);
    await settle();
    // The turn failed; the controller halted the queue instead of draining.
    fake.turnRunning = false;
    setSession({ status: "error", queueHalted: true });
    expect(fake.started).toEqual([]);

    await send.resumeQueue(TAB);
    expect(fake.calls("queueResume")).toEqual([[KEY]]);
    expect(fake.started).toEqual(["next"]);
    expect(store().sessions[TAB].queueHalted).toBeUndefined();
  });

  it("a refused Resume leaves the notice to try again", async () => {
    setSession({ status: "running" });
    fake.turnRunning = true;
    send.enqueue(TAB, "next", []);
    await settle();
    fake.turnRunning = false;
    setSession({ status: "error", queueHalted: true });
    fake.failNext.queueResume = new Error("unknown session");

    await send.resumeQueue(TAB);
    expect(store().sessions[TAB].queueHalted).toBe(true);
  });

  it("is dropped by Stop, by an agent switch taking it, and with the session", async () => {
    send.enqueue(TAB, "a", []);
    await settle();
    expect(send.takeQueued(TAB)).toEqual(["a"]);
    expect(strip()).toEqual([]);
    expect(fake.calls("queueClear")).toHaveLength(1);

    store().actions.enqueueMessage(TAB, "b", []);
    store().actions.clearSession(TAB);
    expect(strip()).toEqual([]);
  });
});

// ACP audit finding 84
describe("Stop while the prompt is being composed", () => {
  let release!: () => void;
  beforeEach(() => {
    bindTab();
    compose = (content) =>
      new Promise((resolve) => {
        release = () => resolve({ prompt: content, resourceLinks: [], pastedTexts: [] });
      });
  });

  it("aborts the send: nothing reaches the agent, and nothing is cancelled on the wire", async () => {
    const sending = send.send(TAB, text("hello"));
    await settle();
    expect(session().status).toBe("running");

    send.stop(TAB);
    expect(session().status).toBe("idle");
    expect(session().stopping).toBeFalsy();
    release();
    await sending;
    expect(fake.calls("send")).toEqual([]);
    expect(fake.calls("cancel")).toEqual([]);
    expect(userBubbles()).toHaveLength(1);
  });

  it("mid-turn, a Stop also stops the turn that was running", async () => {
    store().actions.updateSessionStatus(TAB, "running");
    const sending = send.send(TAB, text("an answer"));
    await settle();
    send.stop(TAB);
    release();
    await sending;
    expect(fake.calls("send")).toEqual([]);
    expect(fake.calls("cancel")).toHaveLength(1);
    expect(session().stopping).toBe(true);
  });

  it("a send composed without a Stop goes as before", async () => {
    const sending = send.send(TAB, text("hello"));
    await settle();
    release();
    await sending;
    expect(fake.started).toEqual(["hello"]);
  });
});

describe("a send the agent refuses", () => {
  it("shows the error in the transcript and leaves the session in error", async () => {
    bindTab();
    fake.failNext.send = new Error("gateway refused");
    await send.send(TAB, text("hello"));
    expect(session().messages.map((m) => m.content)).toEqual([
      "hello",
      "agent send error: gateway refused",
    ]);
    expect(session().status).toBe("error");
  });
});

describe("the instance owns its state", () => {
  it("two instances share nothing, and reset forgets every tab", async () => {
    bindTab();
    const other = createSessionSend({
      agents: fakeAgents().port,
      chat: () => useChatStore.getState(),
      ambient: () => ambient,
      rebind,
      forgetAgent,
      wirePrompt: (_s, content) => compose(content),
      queuedPrompt: (queued) => queued,
    });
    send.setHold(TAB, "switch", true);
    expect(send.state(TAB).switchPending).toBe(true);
    expect(other.state(TAB).switchPending).toBe(false);

    send.reset();
    expect(send.state(TAB).switchPending).toBe(false);
    // Forgotten, so the next hold is told to Rust again.
    send.setHold(TAB, "gate", true);
    expect(fake.calls("queuePause")).toEqual([
      [KEY, true],
      [KEY, true],
    ]);
  });

  it("forgetting a closed tab drops its holds", () => {
    bindTab();
    send.setHold(TAB, "switch", true);
    send.forget(TAB);
    expect(send.state(TAB).switchPending).toBe(false);
  });
});
