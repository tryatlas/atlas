// @vitest-environment happy-dom
//
// Which tab a conversation goes into, over the real stores and the shared
// Tauri fake: the one reuse rule (`session-tab-reuse.ts`) as each way in uses
// it — a history row (`openThread`), a session id (`openAgentSession`), New
// chat (`openNewAgentChat`) and a branch (`forkSessionToNewTab`).
//
// The failure each guards is silent: an idle tab holding something the user
// sent, or the conversation a branch came from, was cleared out of its tab with
// no error and nothing to see but the other conversation in its place.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { toast } from "sonner";
import { tauri } from "@/test/tauri-fake";
import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useChatStore } from "../stores/chat-store";
import { resetAgent } from "./agents-api";
import { forkSessionToNewTab } from "./fork-session";
import { openAgentSession, openNewAgentChat } from "./open-agent-session";
import { openThread, type OpenableThread } from "./open-thread";
import { canReuseTab, findSessionHolder, tabReuseRefusal } from "./session-tab-reuse";

const TAB = "chat-1";
const PLUGIN = "opencode";
const AGENT = { agent_id: "agent-opencode", spec_id: PLUGIN, display_name: "OpenCode" };
const SOURCE = "sess-source";
const OTHER = "sess-other";

const snapshot = (sessionId: string) => ({
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
  messages: [{ role: "user", content: `in ${sessionId}`, timestamp: "", tool_calls: [] }],
  subagents: [],
  usage: {},
  created_at: "2026-10-01T12:00:00Z",
  updated_at: "2026-10-01T12:00:00Z",
});

const store = () => useChatStore.getState();
const session = (tab = TAB) => store().sessions[tab]!;
const tabIds = () => useLayoutStore.getState().tabs.map((t) => t.id);
const freshTab = () => tabIds().find((id) => id !== TAB)!;

const THREAD: OpenableThread = {
  threadId: "th-other",
  sessionId: OTHER,
  title: "Another session",
  agent: PLUGIN,
  cwd: "/proj",
  projectPath: "/proj",
};

const chatTab = (id: string) =>
  ({ id, type: "chat", title: "Session", closable: true, dirty: false, data: {} }) as never;

let switchTo: ReturnType<typeof vi.fn<(id: string) => Promise<void>>>;

beforeEach(() => {
  tauri.reset();
  tauri.handleRaw({
    agents_spawn: () => AGENT,
    agents_fork_session: () => "sess-branch",
    // Only `THREAD` is ever resumed from history here.
    threads_resume: () => ({
      key: { agent_id: AGENT.agent_id, session_id: OTHER },
      resumedWithoutHistory: false,
    }),
    agents_load_session: ({ sessionId }) => ({ agent_id: AGENT.agent_id, session_id: sessionId }),
    agents_snapshot: ({ key }) => snapshot((key as { session_id: string }).session_id),
    agents_snapshot_meta: ({ key }) => ({
      ...snapshot((key as { session_id: string }).session_id),
      messages: [],
    }),
  });
  localStorage.clear();
  resetAgent(PLUGIN);
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    queueIds: {},
    drafts: {},
    activeSessionId: null,
  });
  useAppStore.setState({ currentProject: { path: "/proj", name: "proj" } as never });
  switchTo = vi.fn(async (_id: string) => {});
  useProjectStore.setState({
    projects: [
      { id: "p-1", path: "/proj", name: "proj" } as never,
      { id: "p-2", path: "/elsewhere", name: "elsewhere" } as never,
    ],
    activeProjectId: "p-1",
    actions: { ...useProjectStore.getState().actions, switchTo },
  });
  useLayoutStore.setState({
    tabs: [chatTab(TAB)],
    groupOrder: ["main"],
    activeByGroup: { main: TAB },
    focusedGroupId: "main",
    activeTabId: TAB,
    viewsByWs: {},
    currentViewWsId: "p-1",
  });
  store().actions.createSession(TAB, PLUGIN);
  // The tab shows a conversation of its own, finished.
  store().actions.setAcpBinding(TAB, AGENT.agent_id, SOURCE, "/proj");
  store().actions.addMessage(TAB, "user", "the source conversation");
  vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** The source tab is left exactly as it was. */
function expectSourceIntact() {
  expect(session().acpSessionId).toBe(SOURCE);
  expect(session().messages.map((m) => m.content)).toEqual(["the source conversation"]);
}

describe("the reuse rule", () => {
  it("an idle chat with nothing unsent may be reused", () => {
    expect(canReuseTab(TAB)).toBe(true);
  });

  it.each([
    ["busy", () => store().actions.updateSessionStatus(TAB, "running")],
    ["queued messages", () => store().actions.enqueueMessage(TAB, "next, do this", [])],
    ["held message", () => store().actions.setPendingSend(TAB, { content: "held" } as never)],
    ["draft", () => store().actions.setDraft(TAB, "half a thought")],
  ])("refuses a tab with %s", (why, arrange) => {
    arrange();
    expect(tabReuseRefusal(TAB)).toBe(why);
  });

  it("refuses a tab that is not open in the active project", () => {
    expect(canReuseTab("chat-gone")).toBe(false);
  });
});

describe("a branch always opens a new tab (#50)", () => {
  it("leaves the idle source tab as it was", async () => {
    forkSessionToNewTab(TAB);
    await vi.waitFor(() => expect(tabIds()).toHaveLength(2));
    await vi.waitFor(() => expect(session(freshTab()).acpSessionId).toBe("sess-branch"));
    expectSourceIntact();
  });
});

describe("nothing the user sent or wrote is lost to a reuse (#54)", () => {
  const arrangements: Array<[string, () => void]> = [
    ["a queued message", () => store().actions.enqueueMessage(TAB, "next, do this", [])],
    ["a held message", () => store().actions.setPendingSend(TAB, { content: "held" } as never)],
    ["a draft", () => store().actions.setDraft(TAB, "half a thought")],
  ];

  it.each(arrangements)("openThread opens beside a tab with %s", async (_, arrange) => {
    arrange();
    await openThread(THREAD);
    expect(tabIds()).toHaveLength(2);
    expect(session(freshTab()).acpSessionId).toBe(OTHER);
    expectSourceIntact();
  });

  it.each(arrangements)("openAgentSession opens beside a tab with %s", async (_, arrange) => {
    arrange();
    await openAgentSession({
      acpSessionId: OTHER,
      title: "Other",
      cwd: "/proj",
      agentType: PLUGIN,
    });
    expect(tabIds()).toHaveLength(2);
    expect(session(freshTab()).acpSessionId).toBe(OTHER);
    expectSourceIntact();
  });

  it.each(arrangements)("New chat opens beside a tab with %s", (_, arrange) => {
    arrange();
    const id = openNewAgentChat();
    expect(id).not.toBe(TAB);
    expectSourceIntact();
  });

  it("an idle tab with nothing unsent is still loaded in place", async () => {
    await openThread(THREAD);
    expect(tabIds()).toEqual([TAB]);
    expect(session().acpSessionId).toBe(OTHER);
  });
});

describe("a session held in another project is shown there (#48)", () => {
  beforeEach(() => {
    useLayoutStore.setState({
      viewsByWs: { "p-2": { tabs: [chatTab("chat-far")] } as never },
    });
    store().actions.createSession("chat-far", PLUGIN);
    store().actions.setAcpBinding("chat-far", AGENT.agent_id, OTHER, "/elsewhere");
  });

  it("is found across projects", () => {
    expect(findSessionHolder(OTHER)).toBe("chat-far");
  });

  it("a stale committed copy of the active project's view does not count", () => {
    useLayoutStore.setState({ viewsByWs: { "p-1": { tabs: [chatTab("chat-far")] } as never } });
    expect(findSessionHolder(OTHER)).toBeNull();
  });

  it("openThread switches to its project instead of loading it twice", async () => {
    await openThread(THREAD);
    expect(switchTo).toHaveBeenCalledWith("p-2");
    expect(tauri.calls("threads_resume")).toHaveLength(0);
    expectSourceIntact();
  });

  it("openAgentSession switches to its project instead of loading it twice", async () => {
    await openAgentSession({
      acpSessionId: OTHER,
      title: "Other",
      cwd: "/proj",
      agentType: PLUGIN,
    });
    expect(switchTo).toHaveBeenCalledWith("p-2");
    expect(tauri.calls("agents_load_session")).toHaveLength(0);
    expectSourceIntact();
  });
});
