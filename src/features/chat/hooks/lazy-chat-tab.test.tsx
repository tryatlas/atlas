// @vitest-environment happy-dom
//
// A chat tab gets its agent session when it is on screen, not when its panel
// mounts, and a tab saved with a conversation gets that conversation back
// rather than a new session.
//
// Why this needs its own suite: every chat panel stays mounted behind the tab
// that is showing, so "the panel mounted" is true of every open tab at launch.
// Binding on mount spawned one agent session per tab in the same instant (six
// `session/new` within 10 ms on a six-tab launch, each a process for an
// external agent). Nothing errors when that comes back: every tab still works,
// and the cost is CPU and memory at launch. The counts below are the only
// thing that sees it.
//
// Over the real hooks, stores and the shared Tauri fake, which stands where
// Rust does.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { useRef } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { tauri } from "@/test/tauri-fake";
import { emitWindowEvent } from "@/lib/window-events";
import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "../stores/chat-store";
import { resetAgent } from "../lib/agents-api";
import {
  isChatTabShown,
  readChatTabSession,
  restorableSessionOfTab,
} from "../lib/chat-tab-session";
import { openAgentSession, openNewAgentChat } from "../lib/open-agent-session";
import { loadThreadIntoTab, tabShowingSession } from "../lib/open-thread";
import { sidebarAgentOf } from "../lib/sidebar-agents";
import { sessionBind } from "../lib/session-bind";
import { sessionSend } from "../lib/session-send";
import { useAgentBind, type BindControl } from "./use-agent-bind";
import { useTabSessionMirror } from "./use-tab-session-mirror";

const PLUGIN = "opencode";
const AGENT = { agent_id: "agent-opencode", spec_id: PLUGIN, display_name: "OpenCode" };
const TAB = "chat-1";
const OTHER = "chat-2";
const OLD = "sess-old";

const store = () => useChatStore.getState();
const session = (tab = TAB) => store().sessions[tab]!;
const layout = () => useLayoutStore.getState();
const count = (cmd: string) => tauri.calls(cmd).length;
/** Let every ready promise continuation run. A load is a chain of them. */
const settle = async () => {
  for (let i = 0; i < 8; i++) await act(() => vi.advanceTimersByTimeAsync(0));
};

const chatTab = (id: string, data: Record<string, unknown> = {}) =>
  ({ id, type: "chat", title: "Session", closable: true, dirty: false, data }) as never;

/** Two chat tabs in the one column, `active` showing. */
function tabs(active: string, data: Record<string, unknown> = {}) {
  useLayoutStore.setState({
    tabs: [chatTab(TAB, data), chatTab(OTHER)],
    groupOrder: ["main"],
    activeByGroup: { main: active },
    focusedGroupId: "main",
    activeTabId: active,
    viewsByWs: {},
  });
}
const show = (id: string) => act(() => layout().actions.setActiveTab(id));

const message = (role: "user" | "assistant", content: string) => ({
  role,
  content,
  timestamp: "2026-10-01T12:00:00Z",
  tool_calls: [],
});
const snapshot = (sessionId: string, messages: unknown[]) => ({
  agent_id: AGENT.agent_id,
  session_id: sessionId,
  cwd: "/proj",
  plugin_id: PLUGIN,
  status: "idle",
  current_mode: null,
  current_model: null,
  available_modes: [],
  available_models: [],
  available_commands: [],
  config_options: [],
  prompt_image_supported: false,
  plan: [],
  messages,
  subagents: [],
  usage: {},
  created_at: "2026-10-01T12:00:00Z",
  updated_at: "2026-10-01T12:00:00Z",
});
/** History as it lists the saved session. */
const ROW = { threadId: "th-1", sessionId: OLD, agentId: PLUGIN, title: "An old session" };

function backend(history: unknown[] = [{ ...ROW, folderPaths: ["/proj"] }]) {
  let sessions = 0;
  tauri.handleRaw({
    agents_spawn: () => AGENT,
    agents_new_session: ({ agentId }) => ({
      key: { agent_id: agentId, session_id: `sess-${++sessions}` },
      current_mode: null,
      available_modes: [],
    }),
    agents_snapshot_meta: ({ key }) => snapshot((key as { session_id: string }).session_id, []),
    threads_history: () => history,
    threads_resume: () => ({
      key: { agent_id: AGENT.agent_id, session_id: OLD },
      resumedWithoutHistory: false,
    }),
    agents_snapshot: () => snapshot(OLD, [message("user", "hi"), message("assistant", "hello")]),
  });
}

/** The bind and saved-session halves of `ChatPanel`, with nothing rendered. */
function usePanel(tabId: string) {
  const live = useChatStore((s) => s.sessions[tabId]);
  const bindControlRef = useRef<BindControl | null>(null);
  useAgentBind(tabId, live, bindControlRef);
  useTabSessionMirror(tabId, live);
  return bindControlRef;
}
const mountPanel = (tabId = TAB) => renderHook(() => usePanel(tabId));

beforeEach(() => {
  vi.useFakeTimers();
  tauri.reset();
  backend();
  localStorage.clear();
  sessionBind.reset();
  sessionSend.reset();
  resetAgent(PLUGIN);
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    queueIds: {},
    drafts: {},
    activeSessionId: null,
    agentStartingStatus: {},
  });
  useAppStore.setState({ currentProject: { path: "/proj", name: "proj" } as never });
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  useLayoutStore.setState({ tabs: [], activeByGroup: {}, activeTabId: null, viewsByWs: {} });
});

describe("which tab is on screen", () => {
  it("is the active tab of its column, and no other", () => {
    tabs(OTHER);
    expect(isChatTabShown(layout(), OTHER)).toBe(true);
    expect(isChatTabShown(layout(), TAB)).toBe(false);
  });

  it("is never a background project's tab", () => {
    useLayoutStore.setState({
      tabs: [chatTab(OTHER)],
      activeByGroup: { main: OTHER },
      viewsByWs: {
        elsewhere: { tabs: [chatTab(TAB)], activeByGroup: { main: TAB } } as never,
      },
    });
    expect(isChatTabShown(layout(), TAB)).toBe(false);
  });

  it("is a tab no layout lists: nothing says it is hidden", () => {
    tabs(OTHER);
    expect(isChatTabShown(layout(), "mounted-elsewhere")).toBe(true);
  });
});

describe("a new chat in a tab nobody is looking at", () => {
  beforeEach(() => store().actions.createSession(TAB, PLUGIN));

  it("starts no agent and no session on mount", async () => {
    tabs(OTHER);
    mountPanel();
    await settle();

    expect(count("agents_spawn")).toBe(0);
    expect(count("agents_new_session")).toBe(0);
    expect(session().acpSessionId).toBeUndefined();
  });

  it("switched to: connects its agent, and still starts no session", async () => {
    tabs(OTHER);
    mountPanel();
    await settle();

    await show(TAB);
    await settle();
    expect(count("agents_spawn")).toBe(1);
    expect(count("agents_new_session")).toBe(0);
    expect(session().acpSessionId).toBeUndefined();
  });

  it("starts its session when sent to while hidden", async () => {
    tabs(OTHER);
    const control = mountPanel();
    await settle();

    // What a send does for a message it has to hold (`kickBind`).
    act(() => control.result.current.current?.kick());
    await settle();
    expect(count("agents_new_session")).toBe(1);
    expect(session().acpSessionId).toBe("sess-1");
  });

  it("starts its session for a message that was waiting before the panel mounted", async () => {
    // A tab opened in the background for a prompt: the send lands first, and
    // has no panel to kick.
    tabs(OTHER);
    store().actions.setPendingSend(TAB, { content: "do this", mentions: [] });
    mountPanel();
    await settle();

    expect(count("agents_new_session")).toBe(1);
    expect(session().acpSessionId).toBe("sess-1");
  });

  it("six tabs open, one showing: one agent connected, no session", async () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    useLayoutStore.setState({
      tabs: ids.map((id) => chatTab(id)),
      groupOrder: ["main"],
      activeByGroup: { main: "c" },
      activeTabId: "c",
      viewsByWs: {},
    });
    for (const id of ids) store().actions.createSession(id, PLUGIN);
    for (const id of ids) mountPanel(id);
    await settle();

    expect(count("agents_spawn")).toBe(1);
    expect(count("agents_new_session")).toBe(0);
  });
});

// The session is the user's, so only the user starts one. Showing a chat is
// not that: a launch, a project switch and a tab switch all show one. An
// agent that stores every session it is asked to open (opencode) listed each
// of those as a session of its own, which the sidebar then imported as one
// the user had started: an untitled "New session" per launch per project.
// Showing a tab connects the agent, so the session that typing asks for
// comes back in a fraction of a second, slash commands included.
describe("a new chat on screen", () => {
  beforeEach(() => store().actions.createSession(TAB, PLUGIN));

  it("connects its agent and starts no session", async () => {
    tabs(TAB);
    mountPanel();
    await settle();

    expect(count("agents_spawn")).toBe(1);
    expect(count("agents_new_session")).toBe(0);
    expect(session().acpSessionId).toBeUndefined();
  });

  it("does not leave the mode picker loading while it waits", async () => {
    tabs(TAB);
    mountPanel();
    await settle();
    expect(session().acpModesPending).toBe(false);
  });

  it("starts nothing when its composer takes the focus", async () => {
    tabs(TAB);
    mountPanel();
    await settle();

    emitWindowEvent("atlas:chat-input-focused", { tabId: TAB });
    await settle();
    expect(count("agents_new_session")).toBe(0);
  });

  it("starts its session when the user starts writing, once", async () => {
    tabs(TAB);
    mountPanel();
    await settle();

    emitWindowEvent("atlas:chat-input-started", { tabId: TAB });
    emitWindowEvent("atlas:chat-input-started", { tabId: TAB });
    await settle();
    expect(count("agents_new_session")).toBe(1);
    expect(session().acpSessionId).toBe("sess-1");
  });

  it("starts nothing for writing in another tab", async () => {
    tabs(TAB);
    mountPanel();
    await settle();

    emitWindowEvent("atlas:chat-input-started", { tabId: OTHER });
    await settle();
    expect(count("agents_new_session")).toBe(0);
  });

  it("starts its session when sent to", async () => {
    tabs(TAB);
    const control = mountPanel();
    await settle();

    act(() => control.result.current.current?.kick());
    await settle();
    expect(count("agents_new_session")).toBe(1);
  });
});

describe("a tab saved with a conversation", () => {
  /** The tab as a restart leaves it: its saved id, and an empty chat session
   *  holding it (what `ChatPanel` creates on mount). */
  function savedTab(active: string) {
    tabs(active, { sessionId: OLD });
    store().actions.createSession(TAB, PLUGIN, restorableSessionOfTab(layout(), TAB) ?? undefined);
  }

  it("reads its saved session off the tab, live or in a background project", () => {
    tabs(OTHER, { sessionId: OLD });
    expect(restorableSessionOfTab(layout(), TAB)).toBe(OLD);
    expect(restorableSessionOfTab(layout(), OTHER)).toBeNull();

    useLayoutStore.setState({
      tabs: [],
      viewsByWs: { elsewhere: { tabs: [chatTab(TAB, { sessionId: OLD })] } as never },
    });
    expect(restorableSessionOfTab(layout(), TAB)).toBe(OLD);
  });

  it("hidden: loads nothing and starts nothing, and keeps its saved id", async () => {
    savedTab(OTHER);
    mountPanel();
    await settle();

    expect(tauri.calls()).toEqual([]);
    expect(session().pendingRestore).toBe(OLD);
    expect(readChatTabSession(layout().tabs[0].data)).toBe(OLD);
  });

  it("shown: the agent reopens that session, and no new one is started", async () => {
    savedTab(OTHER);
    mountPanel();
    await settle();

    await show(TAB);
    await settle();

    expect(tauri.calls("threads_resume")).toEqual([
      { cmd: "threads_resume", args: { threadId: "th-1" } },
    ]);
    expect(count("agents_new_session")).toBe(0);
    expect(session().acpSessionId).toBe(OLD);
    expect(session().messages).toHaveLength(2);
    expect(session().pendingRestore).toBeUndefined();
    expect(session().resumePending).toBe(false);
    expect(readChatTabSession(layout().tabs[0].data)).toBe(OLD);
  });

  it("on screen at launch: reopened at once", async () => {
    savedTab(TAB);
    mountPanel();
    await settle();

    expect(count("threads_resume")).toBe(1);
    expect(count("agents_new_session")).toBe(0);
    expect(session().acpSessionId).toBe(OLD);
  });

  it("is bound to its session before the conversation is painted", async () => {
    // The transcript keys its scroll state on the bound session id. Painted
    // first and bound after, it lays the conversation out twice, and the
    // reader sees it jump (no agent is connected at launch, so nothing binds
    // the tab ahead of the load).
    let boundAtPaint: string | undefined = "never painted";
    const stop = useChatStore.subscribe((s, prev) => {
      const now = s.sessions[TAB]?.messages.length ?? 0;
      if (now > 0 && (prev.sessions[TAB]?.messages.length ?? 0) === 0) {
        boundAtPaint = s.sessions[TAB]?.acpSessionId;
      }
    });
    savedTab(TAB);
    mountPanel();
    await settle();
    stop();

    expect(boundAtPaint).toBe(OLD);
  });

  it("starts no new session while the agent is still reopening the old one", async () => {
    // No agent is connected at launch, so the load has nothing to bind the
    // tab to until `threads_resume` answers: the tab is unbound for the whole
    // wait, which is exactly the state a new session is started in.
    let answer!: (v: unknown) => void;
    tauri.handleRaw({
      threads_resume: () => new Promise((resolve) => (answer = resolve)),
    });
    savedTab(TAB);
    mountPanel();
    await settle();

    expect(session().acpSessionId).toBeUndefined();
    expect(session().resumePending).toBe(true);
    expect(count("agents_new_session")).toBe(0);

    answer({ key: { agent_id: AGENT.agent_id, session_id: OLD }, resumedWithoutHistory: false });
    await settle();
    expect(session().acpSessionId).toBe(OLD);
    expect(count("agents_new_session")).toBe(0);
  });

  it("sent to while hidden: reopened, and the message waits in the queue", async () => {
    savedTab(OTHER);
    mountPanel();
    await settle();
    // A first message held for the tab, as `send` leaves it.
    act(() => store().actions.setPendingSend(TAB, { content: "carry on", mentions: [] }));
    await settle();

    expect(count("threads_resume")).toBe(1);
    expect(session().acpSessionId).toBe(OLD);
    expect(session().pendingSend).toBeUndefined();
    expect(store().queues[TAB]).toHaveLength(1);
  });

  it("deleted since: the tab becomes an ordinary new chat", async () => {
    backend([]);
    savedTab(TAB);
    mountPanel();
    await settle();

    expect(count("threads_resume")).toBe(0);
    expect(session().pendingRestore).toBeUndefined();
    // A new chat like any other: its session waits for the user.
    expect(count("agents_new_session")).toBe(0);
    act(() => emitWindowEvent("atlas:chat-input-started", { tabId: TAB }));
    await settle();
    expect(count("agents_new_session")).toBe(1);
    expect(session().acpSessionId).toBe("sess-1");
  });

  it("history unreadable: says so, keeps waiting, and loads on the next ask", async () => {
    let broken = true;
    tauri.handleRaw({
      threads_history: () => {
        if (broken) throw new Error("store not open");
        return [{ ...ROW, folderPaths: ["/proj"] }];
      },
    });
    savedTab(TAB);
    mountPanel();
    await settle();

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(session().pendingRestore).toBe(OLD);
    expect(count("agents_new_session")).toBe(0);
    expect(readChatTabSession(layout().tabs[0].data)).toBe(OLD);

    broken = false;
    act(() => emitWindowEvent("atlas:chat-input-focused", { tabId: TAB }));
    await settle();
    expect(session().acpSessionId).toBe(OLD);
    expect(count("agents_new_session")).toBe(0);
  });

  it("another conversation put in the tab first: the saved one is not loaded", async () => {
    savedTab(OTHER);
    mountPanel();
    await settle();

    // "New chat" in the tab, then looking at it and writing in it.
    act(() => store().actions.clearSession(TAB));
    await show(TAB);
    await settle();
    expect(count("agents_new_session")).toBe(0);
    act(() => emitWindowEvent("atlas:chat-input-started", { tabId: TAB }));
    await settle();

    expect(count("threads_resume")).toBe(0);
    expect(count("agents_new_session")).toBe(1);
  });

  it("New chat while it is still loading: no skeleton left behind, and the new chat hears its agent", async () => {
    // The load the restore started is still waiting on the agent when the
    // user gives up on it. A cleared tab still marked loading showed the
    // skeleton forever, and held back every delta of the session it bound
    // next, so the new chat's replies never rendered (audit #3).
    let answer!: (v: unknown) => void;
    tauri.handleRaw({
      threads_resume: () => new Promise((resolve) => (answer = resolve)),
    });
    savedTab(TAB);
    mountPanel();
    await settle();
    expect(session().transcriptLoading).toBe(true);

    act(() => void openNewAgentChat());
    await settle();
    expect(session().transcriptLoading).toBeFalsy();
    act(() => emitWindowEvent("atlas:chat-input-started", { tabId: TAB }));
    await settle();

    expect(session().acpSessionId).toBe("sess-1");
    act(() =>
      store().actions.applyAgentDelta({
        kind: "status",
        agent_id: AGENT.agent_id,
        session_id: "sess-1",
        seq: 1,
        status: "running",
        turn_seq: 1,
      } as never),
    );
    expect(session().status).toBe("running");

    // The abandoned load answering late changes nothing.
    answer({ key: { agent_id: AGENT.agent_id, session_id: OLD }, resumedWithoutHistory: false });
    await settle();
    expect(session().acpSessionId).toBe("sess-1");
    expect(session().messages).toEqual([]);
  });

  it("sent to while hidden, then the agent cannot reopen it: the message comes back to the composer", async () => {
    // The restore parks the held message in the queue before loading; the
    // failed load reset the tab to a new chat and the reset deleted the
    // queue, so a message the user had sent was simply gone (audit #46).
    tauri.handleRaw({
      threads_resume: () => {
        throw new Error("no such session");
      },
    });
    savedTab(OTHER);
    mountPanel();
    await settle();
    await act(() => sessionSend.send(TAB, { content: "carry on", mentions: [] }));
    await settle();

    expect(count("threads_resume")).toBe(1);
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(store().queues[TAB] ?? []).toEqual([]);
    expect(session().messages).toEqual([]);
    expect(store().drafts[TAB]).toBe("carry on");
  });

  it("history unreadable with a message waiting: the message is parked, and the next send asks again", async () => {
    // The history read failed before the held message was parked, so the tab
    // sat on "Starting…" (status running) with nothing starting (audit #53),
    // and a second send only queued: nothing asked for the restore again
    // (audit #57).
    let broken = true;
    tauri.handleRaw({
      threads_history: () => {
        if (broken) throw new Error("store not open");
        return [{ ...ROW, folderPaths: ["/proj"] }];
      },
    });
    savedTab(OTHER);
    mountPanel();
    await settle();
    await act(() => sessionSend.send(TAB, { content: "first", mentions: [] }));
    await settle();

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(session().pendingSend).toBeUndefined();
    expect(session().status).toBe("idle");
    expect(store().queues[TAB]).toEqual(["first"]);

    broken = false;
    await act(() => sessionSend.send(TAB, { content: "second", mentions: [] }));
    await settle();
    expect(count("threads_resume")).toBe(1);
    expect(session().acpSessionId).toBe(OLD);
    expect(store().queues[TAB]).toEqual(["first", "second"]);
  });

  it("counts as the tab showing its session, so the sidebar focuses it", () => {
    savedTab(OTHER);
    expect(tabShowingSession(OLD)).toBe(TAB);
  });
});

describe("what a tab saves", () => {
  beforeEach(() => store().actions.createSession(TAB, PLUGIN));

  it("nothing for a session nobody has sent to", async () => {
    tabs(TAB);
    mountPanel();
    await settle();
    act(() => emitWindowEvent("atlas:chat-input-started", { tabId: TAB }));
    await settle();

    expect(session().acpSessionId).toBe("sess-1");
    expect(readChatTabSession(layout().tabs[0].data)).toBeNull();
  });

  it("the session, once it has a conversation, and nothing again once it is cleared", async () => {
    tabs(TAB);
    mountPanel();
    await settle();
    act(() => emitWindowEvent("atlas:chat-input-started", { tabId: TAB }));
    await settle();

    act(() => store().actions.addMessage(TAB, "user", "hi"));
    expect(readChatTabSession(layout().tabs[0].data)).toBe("sess-1");

    act(() => store().actions.clearSession(TAB));
    expect(readChatTabSession(layout().tabs[0].data)).toBeNull();
  });
});

describe("a load that fails or is replaced", () => {
  beforeEach(() => store().actions.createSession(TAB, PLUGIN));

  it("a load that fails gives back what was typed while it ran", async () => {
    // A sidebar open that fails resets the tab; the messages typed while it
    // loaded went with the reset (audit #55).
    let fail!: (err: unknown) => void;
    tauri.handleRaw({
      threads_resume: () => new Promise((_, reject) => (fail = reject)),
    });
    tabs(TAB);
    const loading = loadThreadIntoTab(TAB, {
      threadId: "th-1",
      sessionId: OLD,
      title: "An old session",
      agent: sidebarAgentOf(PLUGIN),
      cwd: "/proj",
      projectPath: "/proj",
    });
    await settle();
    await act(() => sessionSend.send(TAB, { content: "while it loads", mentions: [] }));
    await act(() => sessionSend.send(TAB, { content: "and this", mentions: [] }));

    fail(new Error("no such session"));
    await act(() => loading);

    expect(store().queues[TAB] ?? []).toEqual([]);
    expect(session().pendingSend).toBeUndefined();
    expect(store().drafts[TAB]).toBe("while it loads\n\nand this");
  });

  it("opening a session a saved tab is waiting for focuses that tab", async () => {
    // `openAgentSession` (fork, the agent's own `ui_open`) looked only at
    // bound tabs, and loaded the session into a second one; the saved tab
    // took it back when shown (audit #49).
    tabs(OTHER, { sessionId: OLD });
    store().actions.setPendingRestore(TAB, OLD);
    tauri.handleRaw({ agents_load_session: () => ({ agent_id: AGENT.agent_id, session_id: OLD }) });

    await act(() => openAgentSession({ acpSessionId: OLD, title: "Old", cwd: "/proj" }));

    expect(layout().activeTabId).toBe(TAB);
    expect(count("agents_load_session")).toBe(0);
  });

  it("New chat while opening a session: the session is not painted or bound into the new chat", async () => {
    let answer!: (v: unknown) => void;
    tauri.handleRaw({
      agents_load_session: () => new Promise((resolve) => (answer = resolve)),
    });
    tabs(TAB);
    const opening = openAgentSession({ acpSessionId: OLD, title: "Old", cwd: "/proj" });
    await settle();

    act(() => void openNewAgentChat());
    answer({ agent_id: AGENT.agent_id, session_id: OLD });
    await act(() => opening);

    expect(session().acpSessionId).not.toBe(OLD);
    expect(session().messages).toEqual([]);
    expect(session().transcriptLoading).toBeFalsy();
    expect(session().resumePending).toBeFalsy();
  });
});
