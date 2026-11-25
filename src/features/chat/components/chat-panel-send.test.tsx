// @vitest-environment happy-dom
//
// What a send, a stop and a drain do, pinned at the panel: the real
// `ChatPanel` (its bind effect, its send / stop handlers, its drain effect)
// over the shared Tauri fake, so every assertion is on a command Rust would
// have received or on the chat store. Nothing here names the module that
// makes the decision, on purpose: these were written against the code before
// the decision moved into one place, and are what says the move changed
// nothing.
//
// The panel's children are stubbed. What is under test is the wiring between
// the handlers and the drain, not anything they render.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
const Null = vi.hoisted(() => () => null);
vi.mock("./message-input", () => ({ MessageInput: Null }));
vi.mock("./chat-header", () => ({ ChatHeader: Null }));
vi.mock("./agent-update-bar", () => ({ AgentUpdateBar: Null }));
vi.mock("./permission-modal", () => ({ PermissionModal: Null }));
vi.mock("./chat-comments-controller", () => ({ ChatCommentsController: Null }));
vi.mock("./session-elicitation", () => ({ SessionElicitation: Null }));
vi.mock("./transcript", () => ({ Transcript: Null }));

import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { tauri } from "@/test/tauri-fake";
import { useAiGrantStore } from "../stores/ai-grant-store";
import { useChatStore } from "../stores/chat-store";
import { pluginIdForAgent } from "@/types/agent";
import { resetAgent } from "../lib/agents-api";
import { restartFailedNotice } from "../lib/agent-rebind";
import { ChatPanel } from "./chat-panel";
import { emitWindowEvent } from "@/lib/window-events";

const TAB = "tab-1";
const AGENT = "agent-1";
const SESSION = "sess-1";

const store = () => useChatStore.getState();
const session = () => store().sessions[TAB];
const queue = () => store().queues[TAB] ?? [];
const userBubbles = () => session().messages.filter((m) => m.role === "user");
const count = (cmd: string) => tauri.calls(cmd).length;
/** The first line of each prompt sent: the wire prompt carries a directive. */
const sentTexts = () => tauri.calls("agents_send").map((c) => String(c.args.text).split("\n")[0]);
const queuedTexts = () => tauri.calls("agents_queue_add").map((c) => c.args.text);
const settle = (ms = 30) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** A connect that never answers: the tab stays "starting" until the test binds it. */
const hangingConnect = () => tauri.handleRaw({ agents_spawn: () => new Promise(() => {}) });

function bind(sessionId = SESSION) {
  act(() => store().actions.setAcpBinding(TAB, AGENT, sessionId, "/tmp"));
}

function seedBound() {
  useChatStore.setState((s) => {
    s.sessions[TAB].acpAgentId = AGENT;
    s.sessions[TAB].acpSessionId = SESSION;
  });
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ChatPanel tabId={TAB} />
    </QueryClientProvider>,
  );
}

/** A send from outside the composer: a chip, a handoff, another agent's `ui_chat`. */
function chatSend(text: string) {
  act(() => {
    emitWindowEvent("atlas:chat-send", { tabId: TAB, text });
  });
}

function stop() {
  act(() => {
    emitWindowEvent("atlas:chat-stop", { tabId: TAB });
  });
}

let queueIdSeq = 0;

beforeEach(() => {
  tauri.reset();
  queueIdSeq = 0;
  tauri.handleRaw({ agents_queue_add: () => `q-${++queueIdSeq}` });
  localStorage.clear();
  resetAgent(pluginIdForAgent("claude-code"));
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    queueIds: {},
    drafts: {},
    activeSessionId: null,
  });
  store().actions.createSession(TAB, "claude-code");
  useAiGrantStore.setState({ entitlement: null });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a send into a session that is still starting", () => {
  it("is held as the first message and dispatched exactly once after the bind", async () => {
    hangingConnect();
    mount();

    chatSend("hello");
    await waitFor(() => expect(session().pendingSend?.content).toBe("hello"));
    // Shown as sent, with the agent starting: a bubble, not a queued chip.
    expect(userBubbles()).toHaveLength(1);
    expect(session().status).toBe("running");
    expect(queue()).toEqual([]);
    expect(count("agents_send")).toBe(0);

    bind();
    await waitFor(() => expect(sentTexts()).toEqual(["hello"]));
    expect(session().pendingSend).toBeUndefined();
    // The held bubble is the one the prompt rides with; none is drawn again.
    expect(userBubbles()).toHaveLength(1);
    expect(tauri.calls("agents_send")[0].args.clientMessageId).toBe(
      userBubbles()[0].clientMessageId,
    );

    // Later status edges do not send it again.
    act(() => store().actions.updateSessionStatus(TAB, "idle"));
    act(() => store().actions.updateSessionStatus(TAB, "running"));
    act(() => store().actions.updateSessionStatus(TAB, "idle"));
    await settle();
    expect(count("agents_send")).toBe(1);
  });

  it("queues what is typed behind the held message, and hands it to the session after it", async () => {
    hangingConnect();
    mount();

    chatSend("first");
    await waitFor(() => expect(session().pendingSend?.content).toBe("first"));
    chatSend("second");
    await waitFor(() => expect(queue()).toEqual(["second"]));
    expect(userBubbles()).toHaveLength(1);
    expect(count("agents_queue_add")).toBe(0);

    bind();
    await waitFor(() => expect(queuedTexts()).toEqual(["second"]));
    expect(sentTexts()).toEqual(["first"]);
    // Parked behind the first turn: Rust drains it when that turn ends.
    expect(count("agents_queue_drain")).toBe(0);
  });

  it("is held through a resume and dispatched exactly once when the resume lands", async () => {
    seedBound();
    useChatStore.setState((s) => {
      s.sessions[TAB].resumePending = true;
    });
    mount();

    chatSend("after resume");
    await waitFor(() => expect(session().pendingSend?.content).toBe("after resume"));
    expect(count("agents_send")).toBe(0);
    expect(tauri.calls("agents_queue_pause")).toEqual([]);

    act(() =>
      useChatStore.setState((s) => {
        s.sessions[TAB].resumePending = false;
      }),
    );
    await waitFor(() => expect(sentTexts()).toEqual(["after resume"]));
    await settle();
    expect(count("agents_send")).toBe(1);
    expect(userBubbles()).toHaveLength(1);
  });
});

describe("a bind that fails", () => {
  // The 2026-09-14 connect loop: the failure parked the held message in the
  // queue and dropped the status to idle, the drain read that edge as a turn
  // ending and sent the message back into the unbound tab, which re-held it
  // and kicked the bind again: 491 connect attempts in a minute.
  it("does not re-enter: the message stays held and nothing connects again", async () => {
    tauri.handleRaw({
      agents_spawn: () => {
        throw new Error("engine start refused");
      },
    });
    mount();

    chatSend("hello");
    await waitFor(() => expect(session().pendingSend?.content).toBe("hello"));

    // The first failure is retried once, quietly; the second leaves the
    // message held, idle, as its one bubble: the next bind that lands sends it
    // with its images, which the queue it used to be parked in dropped.
    await waitFor(() => expect(session().status).toBe("idle"), { timeout: 4000 });
    expect(session().pendingSend?.content).toBe("hello");
    const connects = count("agents_spawn");

    await settle(300);
    expect(count("agents_spawn")).toBe(connects);
    expect(connects).toBeLessThanOrEqual(3);
    expect(count("agents_send")).toBe(0);
    expect(userBubbles()).toHaveLength(1);
    expect(queue()).toEqual([]);
  });
});

describe("sends while a turn runs", () => {
  beforeEach(() => {
    seedBound();
    useChatStore.setState((s) => {
      s.sessions[TAB].status = "running";
    });
  });

  it("queue in the order typed, and the window asks for a drain at each turn end", async () => {
    mount();
    await settle();
    const drainsAtMount = count("agents_queue_drain");
    const { enqueueMessage } = store().actions;
    // The composer's own path while a turn runs is the queue (`planSubmit`).
    act(() => {
      enqueueMessage(TAB, "one", []);
      enqueueMessage(TAB, "two", []);
      enqueueMessage(TAB, "three", []);
    });
    expect(queue()).toEqual(["one", "two", "three"]);

    act(() => store().actions.updateSessionStatus(TAB, "idle"));
    await waitFor(() => expect(queuedTexts()).toEqual(["one", "two", "three"]));
    await waitFor(() => expect(count("agents_queue_drain")).toBe(drainsAtMount + 1));

    act(() => store().actions.updateSessionStatus(TAB, "running"));
    await settle();
    expect(count("agents_queue_drain")).toBe(drainsAtMount + 1);
    act(() => store().actions.updateSessionStatus(TAB, "idle"));
    await waitFor(() => expect(count("agents_queue_drain")).toBe(drainsAtMount + 2));
    // Handed over once: a later turn end adds nothing again.
    expect(queuedTexts()).toEqual(["one", "two", "three"]);
    // The window never sends a queued prompt itself; Rust does.
    expect(count("agents_send")).toBe(0);
  });

  it("go straight to the agent from outside the composer", async () => {
    // A chip or a permission answer mid-turn belongs to the turn already
    // admitted: it is dispatched, and Rust's turn controller takes it from there.
    mount();
    chatSend("answer");
    await waitFor(() => expect(sentTexts()).toEqual(["answer"]));
    expect(queue()).toEqual([]);
  });

  it("Stop discards the queue, asks for the stop once, and a second Stop kills", async () => {
    mount();
    act(() => store().actions.enqueueMessage(TAB, "queued", [], "q-9"));

    stop();
    expect(session().stopping).toBe(true);
    // Not idle yet: idle arrives with the turn's real terminal.
    expect(session().status).toBe("running");
    expect(queue()).toEqual([]);
    expect(count("agents_queue_clear")).toBe(1);
    expect(tauri.calls("agents_cancel").map((c) => c.args.stop)).toEqual([true]);
    expect(count("agents_kill")).toBe(0);

    stop();
    expect(count("agents_cancel")).toBe(1);
    // The kill names the session it was pressed for: a late one cannot take
    // down the process that replaced the one it meant (audit #69).
    expect(tauri.calls("agents_kill").map((c) => c.args)).toEqual([
      { agentId: AGENT, sessionId: session().acpSessionId },
    ]);
    expect(session().stopping).toBeUndefined();
  });
});

describe("Stop while the session is still starting", () => {
  it("lets go of the held message, kills the connect, and keeps what was queued", async () => {
    hangingConnect();
    mount();
    chatSend("first");
    await waitFor(() => expect(session().pendingSend?.content).toBe("first"));
    chatSend("second");
    await waitFor(() => expect(queue()).toEqual(["second"]));

    stop();
    expect(session().pendingSend).toBeUndefined();
    expect(session().status).toBe("idle");
    expect(tauri.calls("agents_kill_plugin").map((c) => c.args.pluginId)).toEqual([
      pluginIdForAgent("claude-code"),
    ]);
    // Nothing was dispatched, so there is nothing to cancel on the wire.
    expect(count("agents_cancel")).toBe(0);
    // The bubble stays, as for a cancelled turn; the queue is untouched.
    expect(userBubbles()).toHaveLength(1);
    expect(queue()).toEqual(["second"]);
  });
});

describe("the gates a send from outside the composer meets", () => {
  beforeEach(seedBound);

  it("a mode the resume could not restore: queued and held, then released by the pick", async () => {
    useChatStore.setState((s) => {
      s.sessions[TAB].unrestoredModeId = "plan";
    });
    mount();

    chatSend("go");
    await waitFor(() => expect(queue()).toEqual(["go"]));
    expect(count("agents_send")).toBe(0);
    expect(tauri.calls("agents_queue_pause").map((c) => c.args.paused)).toEqual([true]);

    act(() =>
      useChatStore.setState((s) => {
        s.sessions[TAB].unrestoredModeId = undefined;
      }),
    );
    await waitFor(() =>
      expect(tauri.calls("agents_queue_pause").map((c) => c.args.paused)).toEqual([true, false]),
    );
    await waitFor(() => expect(count("agents_queue_drain")).toBe(1));
    expect(count("agents_send")).toBe(0);
  });

  describe("no AI grant on the native agent", () => {
    beforeEach(() => {
      useChatStore.setState((s) => {
        s.sessions[TAB].agentType = "atlas-agent";
      });
      useAiGrantStore.setState({ entitlement: { state: "noGrant" } as never });
    });

    it("queues an idle send rather than send it to a gateway that refuses", async () => {
      mount();
      chatSend("chip");
      await waitFor(() => expect(queue()).toEqual(["chip"]));
      expect(count("agents_send")).toBe(0);
      expect(count("agents_queue_drain")).toBe(0);
    });

    it("still dispatches mid-turn: that answer belongs to the turn already admitted", async () => {
      useChatStore.setState((s) => {
        s.sessions[TAB].status = "running";
      });
      mount();
      chatSend("answer");
      await waitFor(() => expect(sentTexts()).toEqual(["answer"]));
    });

    it("does not hold another agent's session", async () => {
      useChatStore.setState((s) => {
        s.sessions[TAB].agentType = "claude-code";
      });
      mount();
      chatSend("hi");
      await waitFor(() => expect(sentTexts()).toEqual(["hi"]));
    });
  });

  it("a held first message goes out once the resume lands, recorded once", async () => {
    useChatStore.setState((s) => {
      s.sessions[TAB].resumePending = true;
    });
    mount();
    chatSend("first");
    await waitFor(() => expect(session().pendingSend?.content).toBe("first"));
    expect(count("agents_send")).toBe(0);

    act(() => {
      useChatStore.setState((s) => {
        s.sessions[TAB].resumePending = false;
      });
    });
    await waitFor(() => expect(sentTexts()).toEqual(["first"]));
    expect(userBubbles()).toHaveLength(1);
  });
});

describe("what the queue survives", () => {
  it("a panel remount: local items are handed to the bound session and drained", async () => {
    seedBound();
    act(() => store().actions.enqueueMessage(TAB, "kept", []));
    const first = mount();
    await waitFor(() => expect(queuedTexts()).toEqual(["kept"]));
    await waitFor(() => expect(count("agents_queue_drain")).toBe(1));
    first.unmount();

    // The tab is switched away and back: the strip still shows the item, now
    // mirrored, and it is not added to the session a second time.
    expect(queue()).toEqual(["kept"]);
    mount();
    await waitFor(() => expect(count("agents_queue_drain")).toBe(2));
    expect(queuedTexts()).toEqual(["kept"]);
  });

  it("an agent restart onto a new session: every item is handed to the new one", async () => {
    seedBound();
    useChatStore.setState((s) => {
      s.sessions[TAB].status = "running";
    });
    mount();
    await settle();
    // One item Rust already had under the old session, one the window held.
    act(() => {
      store().actions.enqueueMessage(TAB, "mirrored", [], "q-old");
      store().actions.enqueueMessage(TAB, "local", []);
    });
    tauri.handleRaw({
      agents_spawn: () => ({ agent_id: "agent-2" }),
      agents_load_session: () => {
        throw new Error("cannot resume");
      },
      agents_new_session: () => ({
        key: { agent_id: "agent-2", session_id: "sess-2" },
        current_mode: null,
        available_modes: [],
      }),
    });

    // The agent process died mid-turn; the turn's end is the drain edge.
    act(() => {
      useChatStore.setState((s) => {
        s.sessions[TAB].disconnected = true;
        s.sessions[TAB].status = "idle";
      });
    });
    await waitFor(() => expect(queuedTexts()).toEqual(["mirrored", "local"]));
    expect(tauri.calls("agents_queue_add").map((c) => c.args.key)).toEqual([
      { agent_id: "agent-2", session_id: "sess-2" },
      { agent_id: "agent-2", session_id: "sess-2" },
    ]);
    expect(session().acpSessionId).toBe("sess-2");
  });

  it("an agent that cannot be restarted: the send says so and nothing is dispatched", async () => {
    seedBound();
    useChatStore.setState((s) => {
      s.sessions[TAB].disconnected = true;
    });
    tauri.handleRaw({
      agents_spawn: () => {
        throw new Error("no runtime");
      },
    });
    mount();
    chatSend("hello");
    // The message stays, as the user's bubble and held for the next restart,
    // and the chat says why in the backend's words, not a guess at the cause.
    await waitFor(() =>
      expect(session().messages.map((m) => m.content)).toEqual([
        "hello",
        restartFailedNotice("no runtime"),
      ]),
    );
    expect(session().pendingSend?.content).toBe("hello");
    expect(count("agents_send")).toBe(0);
  });

  it("is dropped with the session when the tab is cleared for another one", async () => {
    seedBound();
    act(() => store().actions.enqueueMessage(TAB, "typed", []));
    act(() => store().actions.clearSession(TAB));
    expect(queue()).toEqual([]);
  });
});
