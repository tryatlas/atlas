// @vitest-environment happy-dom
//
// The three ways an EXISTING session is put back into a tab, side by side,
// over the real stores and the shared Tauri fake:
//
//   openThread                 a history row (sidebar, search, a notification)
//   openAgentSession           a session id (a fork, a UI action)
//   rebindDisconnectedSession  the same tab, after its agent process died
//
// (The fourth entry point, a NEW session, is `useAgentBind`:
// `hooks/use-agent-bind.test.tsx`.)
//
// They are fed one snapshot and asked what of it reached the tab. They do not
// agree, and the table in "what each entry point hydrates" is the record of
// where: a change that makes two of them agree should have to change a row.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { toast } from "sonner";
import { tauri } from "@/test/tauri-fake";
import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "../stores/chat-store";
import { onWindowEvent } from "@/lib/window-events";
import { useAgentRegistryStore } from "@/features/agents/stores/agent-registry-store";
import type { AgentCatalogEntry } from "@/types/agent-catalog";
import { rebindDisconnectedSession, restartDisconnectedSession } from "./agent-rebind";
import { takeSignInCallback } from "./agent-signin";
import type { ThreadRow } from "./history-api";
import { restoreTabSession } from "./restore-tab-session";
import { ensureAgent, resetAgent } from "./agents-api";
import { saveLastModePref } from "./last-mode-pref";
import { openAgentSession } from "./open-agent-session";
import { loadThreadIntoTab, openThread, type OpenableThread } from "./open-thread";

const TAB = "chat-1";
// An agent whose type, plugin id and sidebar band are one string, so no test
// here depends on the id folding in `sidebar-agents.ts`.
const PLUGIN = "opencode";
const AGENT = { agent_id: "agent-opencode", spec_id: PLUGIN, display_name: "OpenCode" };
const SESSION = "sess-old";
const KEY = { agent_id: AGENT.agent_id, session_id: SESSION };

const MODES = [
  { id: "read-only", name: "Read only" },
  { id: "auto", name: "Auto" },
];
const MODELS = [
  { id: "m-small", name: "Small" },
  { id: "m-large", name: "Large" },
];

const message = (role: "user" | "assistant", content: string) => ({
  role,
  content,
  timestamp: "2026-10-01T12:00:00Z",
  tool_calls: [],
});

/** A session with everything a snapshot can carry, mid-turn. */
const snapshot = (patch: Record<string, unknown> = {}) => ({
  agent_id: AGENT.agent_id,
  session_id: SESSION,
  cwd: "/proj",
  plugin_id: PLUGIN,
  status: "running",
  current_mode: "auto",
  current_model: "m-large",
  available_modes: MODES,
  available_models: MODELS,
  available_commands: [{ name: "review", description: "Review the diff" }],
  config_options: [{ id: "effort", name: "Effort", type: "select", currentValue: "low" }],
  prompt_image_supported: false,
  plan: [{ content: "Read the code", status: "in_progress" }],
  messages: [message("user", "hi"), message("assistant", "hello")],
  subagents: [],
  usage: {},
  created_at: "2026-10-01T12:00:00Z",
  updated_at: "2026-10-01T12:00:00Z",
  ...patch,
});

const store = () => useChatStore.getState();
const session = (tab = TAB) => store().sessions[tab]!;
const count = (cmd: string) => tauri.calls(cmd).length;

/** What of the snapshot is in the tab. */
function hydrated(tab = TAB) {
  const s = session(tab);
  return {
    session: s.acpSessionId,
    messages: s.messages.length,
    mode: s.acpCurrentMode ?? null,
    modes: s.acpAvailableModes?.length ?? 0,
    status: s.status,
    plan: s.livePlan?.length ?? 0,
    models: s.acpAvailableModels?.length ?? 0,
    commands: s.availableCommands?.length ?? 0,
    configOptions: s.acpConfigOptions?.length ?? 0,
  };
}

const THREAD: OpenableThread = {
  threadId: "th-1",
  sessionId: SESSION,
  title: "An old session",
  agent: PLUGIN,
  cwd: "/proj",
  projectPath: "/proj",
};

function healthyBackend() {
  tauri.handleRaw({
    agents_spawn: () => AGENT,
    threads_resume: () => ({ key: KEY, resumedWithoutHistory: false }),
    agents_load_session: () => KEY,
    agents_new_session: ({ agentId }) => ({
      key: { agent_id: agentId, session_id: "sess-fresh" },
      current_mode: null,
      available_modes: [],
    }),
    agents_snapshot: () => snapshot(),
    agents_snapshot_meta: () => snapshot({ messages: [], subagents: undefined }),
  });
}

let toastError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tauri.reset();
  healthyBackend();
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
  useLayoutStore.setState({
    tabs: [
      { id: TAB, type: "chat", title: "Session", closable: true, dirty: false, data: {} } as never,
    ],
    groupOrder: ["main"],
    activeByGroup: { main: TAB },
    focusedGroupId: "main",
    activeTabId: TAB,
  });
  store().actions.createSession(TAB, PLUGIN);
  toastError = vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(toast, "info").mockImplementation(() => "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** The tab as a dead agent leaves it: bound, two messages on screen, flagged. */
function disconnectedTab() {
  const { actions } = store();
  actions.setAcpBinding(TAB, AGENT.agent_id, SESSION, "/proj");
  actions.addMessage(TAB, "user", "hi");
  actions.addMessage(TAB, "assistant", "hello");
  actions.setDisconnected(TAB, true);
}

describe("what each entry point hydrates", () => {
  it("openThread: the transcript, the mode, the live turn, and the pickers", async () => {
    await openThread(THREAD);

    // One call starts the agent and reopens the session; which protocol verb
    // it used is the backend's (`threads_resume`).
    expect(count("threads_resume")).toBe(1);
    expect(count("agents_spawn")).toBe(0);
    expect(count("agents_load_session")).toBe(0);
    expect(hydrated()).toEqual({
      session: SESSION,
      messages: 2,
      mode: "auto",
      modes: 2,
      status: "running",
      plan: 1,
      models: 2,
      commands: 1,
      configOptions: 1,
    });
    expect(session().resumePending).toBeFalsy();
    expect(session().transcriptLoading).toBeFalsy();
    expect(session().title).toBe("An old session");
  });

  it("openAgentSession: the transcript, the mode and the live turn, but not the pickers", async () => {
    await openAgentSession({
      acpSessionId: SESSION,
      title: "Forked",
      cwd: "/proj",
      agentType: PLUGIN,
    });

    expect(count("agents_spawn")).toBe(1);
    expect(count("agents_load_session")).toBe(1);
    expect(count("threads_resume")).toBe(0);
    expect(hydrated()).toEqual({
      session: SESSION,
      messages: 2,
      mode: "auto",
      modes: 2,
      status: "running",
      plan: 1,
      // As found: models, slash commands and config options are in the
      // snapshot this path holds and are not seeded from it. A mounted panel's
      // `useSessionBackfill` fetches the snapshot again to fill them.
      models: 0,
      commands: 0,
      configOptions: 0,
    });
    expect(session().resumePending).toBeFalsy();
    expect(session().transcriptLoading).toBeFalsy();
  });

  it("rebindDisconnectedSession: the transcript and the mode only", async () => {
    disconnectedTab();
    await expect(rebindDisconnectedSession(TAB)).resolves.toBe(true);

    expect(count("agents_spawn")).toBe(1);
    expect(count("agents_load_session")).toBe(1);
    // The transcript from the full snapshot, then the mode from a second,
    // metadata-only read.
    expect(count("agents_snapshot")).toBe(1);
    expect(count("agents_snapshot_meta")).toBe(1);
    expect(hydrated()).toEqual({
      session: SESSION,
      messages: 2,
      mode: "auto",
      modes: 2,
      // As found: the snapshot's status and plan are not adopted, and the
      // pickers keep whatever the tab had.
      status: "idle",
      plan: 0,
      models: 0,
      commands: 0,
      configOptions: 0,
    });
    expect(session().disconnected).toBeFalsy();
  });
});

describe("the user's mode pick on resume", () => {
  // The same rule on all three (`resume-mode.ts`): the pick goes to the agent
  // before the tab can send.
  const pickReadOnly = () => {
    store().actions.setAcpModes(TAB, "read-only", MODES, PLUGIN);
    useChatStore.setState((s) => {
      s.sessions[TAB]!.acpModeExplicit = true;
    });
  };
  const sentMode = () => tauri.calls("agents_set_mode").map((c) => c.args.modeId);

  it("rebindDisconnectedSession pushes it before the tab is bound again", async () => {
    disconnectedTab();
    pickReadOnly();
    let disconnectedAtSetMode: boolean | undefined;
    tauri.handleRaw({
      agents_set_mode: () => {
        disconnectedAtSetMode = session().disconnected;
        return null;
      },
    });
    await rebindDisconnectedSession(TAB);
    expect(sentMode()).toEqual(["read-only"]);
    expect(disconnectedAtSetMode).toBe(true);
    expect(session().acpCurrentMode).toBe("read-only");
  });

  it("openAgentSession pushes it while sends are still gated", async () => {
    // The tab's own pick does not survive `clearSession`; the saved per-agent
    // one is what a reopened session is put back into.
    saveLastModePref(PLUGIN, "read-only");
    let pendingAtSetMode: boolean | undefined;
    tauri.handleRaw({
      agents_set_mode: () => {
        pendingAtSetMode = session().resumePending;
        return null;
      },
    });
    await openAgentSession({ acpSessionId: SESSION, title: "t", cwd: "/proj", agentType: PLUGIN });
    expect(sentMode()).toEqual(["read-only"]);
    expect(pendingAtSetMode).toBe(true);
    expect(session().resumePending).toBeFalsy();
  });
});

describe("openThread", () => {
  it("focuses the tab that already shows the session instead of loading it again", async () => {
    store().actions.setAcpBinding(TAB, AGENT.agent_id, SESSION, "/proj");
    await openThread(THREAD);
    expect(count("threads_resume")).toBe(0);
    expect(useLayoutStore.getState().activeTabId).toBe(TAB);
  });

  it("opens beside a running session, never over it", async () => {
    store().actions.updateSessionStatus(TAB, "running");
    await openThread(THREAD);
    const tabs = useLayoutStore.getState().tabs.map((t) => t.id);
    expect(tabs).toHaveLength(2);
    const fresh = tabs.find((id) => id !== TAB)!;
    expect(session(fresh).acpSessionId).toBe(SESSION);
    expect(session().acpSessionId).toBeUndefined();
    expect(session().status).toBe("running");
  });

  it("gates sends from the click until the session is really loaded", async () => {
    await ensureAgent(PLUGIN);
    let release!: (v: unknown) => void;
    tauri.handleRaw({ threads_resume: () => new Promise((r) => (release = r)) });

    const opening = openThread(THREAD);
    await vi.waitFor(() => expect(count("threads_resume")).toBe(1));
    // Optimistic: bound to the session before the backend has it (the agent
    // is already running), with the gate up and the skeleton showing.
    expect(session().acpSessionId).toBe(SESSION);
    expect(session().resumePending).toBe(true);
    expect(session().transcriptLoading).toBe(true);
    expect(session().messages).toHaveLength(0);

    release({ key: KEY, resumedWithoutHistory: false });
    await opening;
    expect(session().resumePending).toBe(false);
    expect(session().messages).toHaveLength(2);
  });

  it("a second click supersedes the first: only the last session lands", async () => {
    const answers: Record<string, (v: unknown) => void> = {};
    tauri.handleRaw({
      threads_resume: ({ threadId }) => new Promise((r) => (answers[String(threadId)] = r)),
      agents_snapshot: ({ key }) => {
        const id = (key as typeof KEY).session_id;
        return snapshot({ session_id: id, messages: [message("user", `from ${id}`)] });
      },
    });
    const first = openThread(THREAD);
    const second = openThread({ ...THREAD, threadId: "th-2", sessionId: "sess-2", title: "Two" });
    await vi.waitFor(() => expect(Object.keys(answers)).toContain("th-2"));
    answers["th-2"]!({ key: { ...KEY, session_id: "sess-2" }, resumedWithoutHistory: false });
    await Promise.all([first, second]);

    // The first never reached the agent: its token was stale before its turn.
    expect(Object.keys(answers)).toEqual(["th-2"]);

    expect(session().acpSessionId).toBe("sess-2");
    expect(session().messages.map((m) => m.content)).toEqual(["from sess-2"]);
    expect(session().title).toBe("Two");
  });

  it("a superseded resume that opened its session anyway hands it back (ACP audit finding 11)", async () => {
    const answers: Record<string, (v: unknown) => void> = {};
    tauri.handleRaw({
      threads_resume: ({ threadId }) => new Promise((r) => (answers[String(threadId)] = r)),
      agents_snapshot: ({ key }) => snapshot({ session_id: (key as typeof KEY).session_id }),
    });
    const first = openThread(THREAD);
    await vi.waitFor(() => expect(Object.keys(answers)).toContain("th-1"));
    const second = openThread({ ...THREAD, threadId: "th-2", sessionId: "sess-2", title: "Two" });
    await vi.waitFor(() => expect(Object.keys(answers)).toContain("th-2"));
    answers["th-2"]!({ key: { ...KEY, session_id: "sess-2" }, resumedWithoutHistory: false });
    await second;
    answers["th-1"]!({ key: KEY, resumedWithoutHistory: false });
    await first;

    expect(session().acpSessionId).toBe("sess-2");
    expect(tauri.calls("agents_drop_session").map((c) => c.args)).toEqual([
      { agentId: AGENT.agent_id, sessionId: SESSION },
    ]);
  });

  it("two clicks on one row: the superseded load leaves the session to the newer one", async () => {
    const answers: Array<(v: unknown) => void> = [];
    tauri.handleRaw({ threads_resume: () => new Promise((r) => answers.push(r)) });
    const first = openThread(THREAD);
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    const second = openThread(THREAD);
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    // The older load answers last, after the newer one has bound the session.
    answers[1]!({ key: KEY, resumedWithoutHistory: false });
    await second;
    answers[0]!({ key: KEY, resumedWithoutHistory: false });
    await Promise.all([first, second]);

    expect(session().acpSessionId).toBe(SESSION);
    expect(count("agents_drop_session")).toBe(0);
  });

  it("a resume that fails rolls the optimistic binding back and says so", async () => {
    await ensureAgent(PLUGIN);
    tauri.handleRaw({ threads_resume: () => Promise.reject({ message: "no such session" }) });
    await openThread(THREAD);

    expect(session().acpSessionId).toBeUndefined();
    expect(session().resumePending).toBeFalsy();
    expect(session().transcriptLoading).toBeFalsy();
    expect(toastError).toHaveBeenCalledWith("Couldn't resume this session: no such session");
  });

  it("tells the user when the agent could continue the session but not replay it", async () => {
    tauri.handleRaw({
      threads_resume: () => ({ key: KEY, resumedWithoutHistory: true }),
      agents_snapshot: () => snapshot({ messages: [] }),
      // Atlas's own recording stands in for the replay the agent could not do.
      agents_replay_transcript: () => [message("user", "hi")],
    });
    await openThread(THREAD);
    expect(toast.info).toHaveBeenCalledTimes(1);
    expect(session().messages.map((m) => m.content)).toEqual(["hi"]);
  });
});

describe("openAgentSession", () => {
  const open = () =>
    openAgentSession({ acpSessionId: SESSION, title: "Forked", cwd: "/proj", agentType: PLUGIN });

  it("focuses the tab that already shows the session instead of loading it again", async () => {
    store().actions.setAcpBinding(TAB, AGENT.agent_id, SESSION, "/proj");
    await open();
    expect(count("agents_load_session")).toBe(0);
  });

  it("opens beside a running session, never over it", async () => {
    store().actions.updateSessionStatus(TAB, "running");
    await open();
    const fresh = useLayoutStore
      .getState()
      .tabs.map((t) => t.id)
      .find((id) => id !== TAB)!;
    expect(session(fresh).acpSessionId).toBe(SESSION);
    expect(session().acpSessionId).toBeUndefined();
  });

  it("a load that fails rolls the optimistic binding back, as `openThread` does", async () => {
    // A tab bound to a session the backend never opened is stranded: the
    // panel's bind skips a bound tab, and every send goes to a session the
    // agent does not have.
    await ensureAgent(PLUGIN);
    tauri.handleRaw({ agents_load_session: () => Promise.reject({ message: "no such session" }) });
    await open();

    expect(toastError).toHaveBeenCalledWith("Couldn't open session: no such session");
    expect(session().resumePending).toBe(false);
    expect(session().transcriptLoading).toBe(false);
    expect(session().acpSessionId).toBeUndefined();
  });

  it("a load answered after the tab moved on paints and binds nothing", async () => {
    let release!: (v: unknown) => void;
    tauri.handleRaw({ agents_load_session: () => new Promise((r) => (release = r)) });
    const opening = open();
    await vi.waitFor(() => expect(count("agents_load_session")).toBe(1));

    // The user moves the tab on before the load answers.
    store().actions.clearSession(TAB);
    release(KEY);
    await opening;
    expect(session().acpSessionId).toBeUndefined();
    expect(session().messages).toHaveLength(0);
  });
});

describe("rebind after the agent disconnects", () => {
  it("hears the restarted agent's turns, which Rust numbers from 1 again", async () => {
    // Every bind gives the session a fresh turn counter in Rust
    // (`SessionRegistry::bind`), and a rebind keeps the session id. The tab
    // kept its old high-water mark, so every status and terminal of the
    // restarted agent's turns (1, 2, ...) read as stale and was dropped: the
    // tab said "Working" forever (audit #2).
    disconnectedTab();
    const delta = (status: string, turnSeq: number) =>
      store().actions.applyAgentDelta({
        kind: "status",
        agent_id: AGENT.agent_id,
        session_id: SESSION,
        seq: 0,
        status,
        turn_seq: turnSeq,
      } as never);
    // Three turns ran before the agent died.
    delta("running", 3);
    delta("idle", 3);

    await rebindDisconnectedSession(TAB);
    delta("running", 1);
    expect(session().status).toBe("running");
    delta("idle", 1);
    expect(session().status).toBe("idle");
  });

  it("a snapshot's turn number is adopted, so an older turn's late terminal is still refused", async () => {
    tauri.handleRaw({ agents_snapshot: () => snapshot({ status: "running", turn_seq: 4 }) });
    await openThread(THREAD);
    expect(session().currentTurnSeq).toBe(4);
  });

  it("resumes the same session and repaints it once, not on top of what is shown", async () => {
    disconnectedTab();
    await rebindDisconnectedSession(TAB);
    expect(tauri.calls("agents_load_session")[0]!.args).toEqual({
      agentId: AGENT.agent_id,
      sessionId: SESSION,
      cwd: "/proj",
    });
    expect(session().messages.map((m) => m.content)).toEqual(["hi", "hello"]);
    expect(session().acpSessionId).toBe(SESSION);
  });

  it("an agent that can only resume: reopened through its thread, not started over", async () => {
    // The restart called `session/load` and nothing else, and on any failure
    // quietly opened a NEW session: the old transcript stayed on screen while
    // the agent remembered none of it (audit #4). Through the thread the
    // backend picks `session/load` or `session/resume`, whichever the agent
    // advertised, as opening a history row does.
    disconnectedTab();
    tauri.handleRaw({
      threads_history: () => [
        {
          threadId: "th-1",
          sessionId: SESSION,
          agentId: PLUGIN,
          title: "t",
          folderPaths: ["/proj"],
        },
      ],
      threads_resume: () => ({ key: KEY, resumedWithoutHistory: true }),
      agents_load_session: () =>
        Promise.reject({ message: "this agent cannot load stored sessions" }),
      agents_snapshot: () => snapshot({ messages: [] }),
    });

    expect(await rebindDisconnectedSession(TAB)).toBe(true);
    expect(tauri.calls("threads_resume").map((c) => c.args)).toEqual([{ threadId: "th-1" }]);
    expect(count("agents_new_session")).toBe(0);
    expect(session().acpSessionId).toBe(SESSION);
    expect(session().messages.map((m) => m.content)).toEqual(["hi", "hello"]);
  });

  it("a session the agent cannot reopen: the chat says it starts over", async () => {
    disconnectedTab();
    tauri.handleRaw({
      threads_history: () => [],
      agents_load_session: () => Promise.reject({ message: "no such session" }),
    });

    expect(await rebindDisconnectedSession(TAB)).toBe(true);
    expect(session().acpSessionId).toBe("sess-fresh");
    const last = session().messages[session().messages.length - 1]!;
    expect(last.content).toMatch(/could not reopen this conversation/);
  });

  it("keeps what is on screen when the agent resumed without replaying", async () => {
    disconnectedTab();
    tauri.handleRaw({ agents_snapshot: () => snapshot({ messages: [] }) });
    await rebindDisconnectedSession(TAB);
    expect(session().messages).toHaveLength(2);
  });

  it("a second caller joins the rebind already running", async () => {
    disconnectedTab();
    const [a, b] = await Promise.all([
      rebindDisconnectedSession(TAB),
      rebindDisconnectedSession(TAB),
    ]);
    expect([a, b]).toEqual([true, true]);
    expect(count("agents_spawn")).toBe(1);
    expect(count("agents_load_session")).toBe(1);

    // And the next disconnect is a rebind of its own.
    resetAgent(PLUGIN);
    store().actions.setDisconnected(TAB, true);
    await rebindDisconnectedSession(TAB);
    expect(count("agents_load_session")).toBe(2);
  });

  it("starts a fresh session when the old one cannot be resumed", async () => {
    disconnectedTab();
    tauri.handleRaw({ agents_load_session: () => Promise.reject({ message: "gone" }) });
    await expect(rebindDisconnectedSession(TAB)).resolves.toBe(true);
    expect(session().acpSessionId).toBe("sess-fresh");
    expect(session().disconnected).toBeFalsy();
    // Nothing was replayed, so nothing is repainted; what is on screen stays,
    // with a line saying the agent no longer has it (audit #4).
    expect(count("agents_snapshot")).toBe(0);
    expect(
      session()
        .messages.map((m) => m.content)
        .slice(0, 2),
    ).toEqual(["hi", "hello"]);
    expect(session().messages).toHaveLength(3);
  });

  it("starts a fresh session for a tab that died before it ever bound", async () => {
    store().actions.setDisconnected(TAB, true);
    await expect(rebindDisconnectedSession(TAB)).resolves.toBe(true);
    expect(count("agents_load_session")).toBe(0);
    expect(session().acpSessionId).toBe("sess-fresh");
  });

  it("answers false and stays disconnected when the agent will not start", async () => {
    disconnectedTab();
    tauri.handleRaw({ agents_spawn: () => Promise.reject({ message: "spawn failed" }) });
    await expect(rebindDisconnectedSession(TAB)).resolves.toBe(false);
    expect(session().disconnected).toBe(true);
    expect(session().acpSessionId).toBe(SESSION);
    // Nothing is cached from a failed start: the next ask spawns again.
    healthyBackend();
    await expect(rebindDisconnectedSession(TAB)).resolves.toBe(true);
  });

  it("answers false for a tab with no session at all", async () => {
    await expect(rebindDisconnectedSession("no-such-tab")).resolves.toBe(false);
    expect(count("agents_spawn")).toBe(0);
  });

  it("holds sends when the mode cannot be read back after the restart", async () => {
    disconnectedTab();
    store().actions.setAcpModes(TAB, "read-only", MODES, PLUGIN);
    useChatStore.setState((s) => {
      s.sessions[TAB]!.acpModeExplicit = true;
    });
    tauri.handleRaw({ agents_snapshot_meta: () => Promise.reject({ message: "busy" }) });
    await expect(rebindDisconnectedSession(TAB)).resolves.toBe(true);
    // Bound, but failed closed: the pick could not be applied.
    expect(session().acpSessionId).toBe(SESSION);
    expect(session().unrestoredModeId).toBe("read-only");
  });
});

// ACP audit finding 64: only a NEW session's bind routed an auth refusal to
// the sign-in dialog. Putting an existing session back showed the agent's raw
// refusal and stopped. Each entry point now offers the same dialog, and runs
// again once the user has signed in.
describe("an auth refusal while putting a session back", () => {
  const REFUSAL = { message: "Please log in", kind: "auth" };
  let asked: number[];
  let off: () => void;
  beforeEach(() => {
    useAgentRegistryStore.setState({
      catalogById: {
        [PLUGIN]: { id: PLUGIN, agentType: PLUGIN, kind: "external", installed: true },
      } as unknown as Record<string, AgentCatalogEntry>,
    });
    asked = [];
    off = onWindowEvent("atlas:agent-signin", (d) => asked.push(d.requestId));
  });
  afterEach(() => {
    for (const id of asked) takeSignInCallback(id);
    off();
  });

  it("openThread offers sign-in instead of the raw error, and opens the session once signed in", async () => {
    tauri.handleRaw({ threads_resume: () => Promise.reject(REFUSAL) });
    await openThread(THREAD);
    expect(asked).toHaveLength(1);
    expect(toastError).not.toHaveBeenCalled();
    expect(session().acpSessionId).toBeUndefined();

    healthyBackend();
    takeSignInCallback(asked[0]!)?.onSignedIn?.();
    await vi.waitFor(() => expect(session().acpSessionId).toBe(SESSION));
  });

  it("a saved tab's restore offers it too", async () => {
    tauri.handleRaw({ threads_resume: () => Promise.reject(REFUSAL) });
    store().actions.setPendingRestore(TAB, SESSION);
    await restoreTabSession(TAB, {
      history: async () => [
        {
          threadId: THREAD.threadId,
          sessionId: SESSION,
          agentId: PLUGIN,
          title: THREAD.title,
          folderPaths: ["/proj"],
        } as unknown as ThreadRow,
      ],
      load: loadThreadIntoTab,
      projectPath: () => "/proj",
      error: (m) => void toast.error(m),
    });
    expect(asked).toHaveLength(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("openAgentSession offers it too", async () => {
    tauri.handleRaw({ agents_load_session: () => Promise.reject(REFUSAL) });
    await openAgentSession({ acpSessionId: SESSION, title: "S", cwd: "/proj", agentType: PLUGIN });
    expect(asked).toHaveLength(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("a restart after the agent died offers it, says nothing else, and restarts once signed in", async () => {
    disconnectedTab();
    tauri.handleRaw({ agents_spawn: () => Promise.reject(REFUSAL) });
    await expect(restartDisconnectedSession(TAB)).resolves.toEqual({ ok: false, error: null });
    expect(asked).toHaveLength(1);
    expect(session().disconnected).toBe(true);

    healthyBackend();
    takeSignInCallback(asked[0]!)?.onSignedIn?.();
    await vi.waitFor(() => expect(session().disconnected).toBeFalsy());
  });

  it("a second refusal after signing in is reported in the agent's words, not offered again", async () => {
    disconnectedTab();
    tauri.handleRaw({ agents_spawn: () => Promise.reject(REFUSAL) });
    await restartDisconnectedSession(TAB);
    const outcome = restartDisconnectedSession(TAB, { signInAttempted: true });
    await expect(outcome).resolves.toEqual({ ok: false, error: "Please log in" });
    expect(asked).toHaveLength(1);
  });
});

describe("a saved tab's restore", () => {
  it("parks a message held for it in the queue with its images", async () => {
    const image = { data: "aGk=", mimeType: "image/png" } as never;
    store().actions.setPendingRestore(TAB, SESSION);
    store().actions.setPendingSend(TAB, {
      content: "look at this",
      mentions: [],
      attachments: [image],
      clientMessageId: "m-1",
    });
    await restoreTabSession(TAB, {
      history: async () =>
        [
          { threadId: "th-1", sessionId: SESSION, agentId: PLUGIN, title: "T", folderPaths: [] },
        ] as unknown as ThreadRow[],
      load: async () => true,
      projectPath: () => "/proj",
      error: () => {},
    });
    expect(store().queueContent[TAB]?.[0]?.attachments).toEqual([image]);
  });
});
