// @vitest-environment happy-dom
//
// Binding a new session to an agent, through the hook a chat panel mounts:
// `useAgentBind` over the app's own `sessionBind`, the real chat store and the
// shared Tauri fake, which stands where Rust does (`agents_spawn`,
// `agents_new_session`, …).
//
// What is pinned is the start path's contract (ADR-0008): one `session/new`
// per session however often the panel mounts, a failure that is reported once
// and does not loop, a hop that hangs ending at the client deadline with the
// connection killed, and an attempt nobody is waiting for any more writing
// nothing.
//
// Timers are fake throughout: the retry (1.5 s), the stall note (30 s) and the
// deadline (3 min) are all clocks.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { StrictMode, useRef } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { tauri } from "@/test/tauri-fake";
import { emitWindowEvent, onWindowEvent } from "@/lib/window-events";
import { useAgentRegistryStore } from "@/features/agents/stores/agent-registry-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useLogStore } from "@/features/log/stores/log-store";
import type { AgentCatalogEntry } from "@/types/agent-catalog";
import { useChatStore } from "../stores/chat-store";
import { resetAgent } from "../lib/agents-api";
import { saveConfigOptionPref } from "../lib/config-option-prefs";
import { sessionBind } from "../lib/session-bind";
import { sessionSend } from "../lib/session-send";
import { takeSignInCallback } from "../lib/agent-signin";
import { useAgentBind, type BindControl } from "./use-agent-bind";
import { useQueueDrain } from "./use-queue-drain";

// The numbers the bind runs on, restated: a change to one is a change to what
// the user waits through, and should have to be made twice.
const RETRY_MS = 1_500;
const STALL_MS = 30_000;
const DEADLINE_MS = 3 * 60_000;
const REAPPLY_MS = 5_000;

const PLUGIN = "codex";
const AGENT = { agent_id: "agent-codex", spec_id: PLUGIN, display_name: "Codex" };

const TAB = "tab-1";

const store = () => useChatStore.getState();
const session = () => store().sessions[TAB]!;
const count = (cmd: string) => tauri.calls(cmd).length;
/** Let every promise continuation that is ready run, without moving the clock. */
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const bindLogs = () =>
  useLogStore
    .getState()
    .buffer.filter((e) => e.kind === "agent-bind")
    .map((e) => e.summary);

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const meta = (sessionId: string, patch: Record<string, unknown> = {}) => ({
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
  messages: [],
  ...patch,
});

/** A backend where every hop answers at once: each `session/new` mints the
 *  next session id. A test overrides the hop it wants to hold or fail. */
function healthyBackend() {
  let sessions = 0;
  tauri.handleRaw({
    agents_spawn: ({ pluginId }) => ({
      agent_id: `agent-${String(pluginId)}`,
      spec_id: pluginId,
      display_name: String(pluginId),
    }),
    agents_new_session: ({ agentId }) => ({
      key: { agent_id: agentId, session_id: `sess-${++sessions}` },
      current_mode: null,
      available_modes: [],
    }),
    agents_snapshot_meta: ({ key }) => meta((key as { session_id: string }).session_id),
  });
}

/** The bind half of `ChatPanel`, with nothing rendered. */
function usePanel(tabId: string) {
  const live = useChatStore((s) => s.sessions[tabId]);
  const bindControlRef = useRef<BindControl | null>(null);
  useAgentBind(tabId, live, bindControlRef);
  return bindControlRef;
}
/** A panel on screen whose user has started writing, which is what starts a
 *  session: showing a chat only connects its agent (`lazy-chat-tab.test.tsx`
 *  pins that). Everything below is about the bind that writing starts. */
const mountPanel = (opts?: Parameters<typeof renderHook>[1]) => {
  const mounted = renderHook(() => usePanel(TAB), opts);
  act(() => emitWindowEvent("atlas:chat-input-started", { tabId: TAB }));
  return mounted;
};

/** The bind and the drain halves of `ChatPanel`: what holds a first message
 *  for the bind and lets it go when the binding lands. */
function useSendingPanel(tabId: string) {
  const live = useChatStore((s) => s.sessions[tabId]);
  const bindControlRef = useRef<BindControl | null>(null);
  useAgentBind(tabId, live, bindControlRef);
  useQueueDrain({ tabId, session: live, grantHold: false, bindControlRef });
  return bindControlRef;
}

let toastError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  tauri.reset();
  healthyBackend();
  localStorage.clear();
  sessionBind.reset();
  sessionSend.reset();
  for (const plugin of [PLUGIN, "opencode"]) resetAgent(plugin);
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    queueIds: {},
    drafts: {},
    activeSessionId: null,
    agentStartingStatus: {},
  });
  useLogStore.setState({ buffer: [] });
  useAgentRegistryStore.setState({ catalogById: {} });
  useAppStore.setState({ currentProject: { path: "/proj", name: "proj" } as never });
  // The tab sits behind another, so nothing here is the warm-up connect a
  // tab on screen makes (`lazy-chat-tab.test.tsx` pins that): every connect
  // counted below is the bind's own.
  const chatTab = (id: string) =>
    ({ id, type: "chat", title: "Session", closable: true, dirty: false, data: {} }) as never;
  useLayoutStore.setState({
    tabs: [chatTab(TAB), chatTab("tab-in-front")],
    groupOrder: ["main"],
    activeByGroup: { main: "tab-in-front" },
    focusedGroupId: "main",
    activeTabId: "tab-in-front",
    viewsByWs: {},
  });
  store().actions.createSession(TAB, "codex");
  toastError = vi.spyOn(toast, "error").mockImplementation(() => "");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  useLayoutStore.setState({ tabs: [], activeByGroup: {}, activeTabId: null, viewsByWs: {} });
});

describe("a new session", () => {
  it("binds once: one connect, one session/new, in the tab's project", async () => {
    mountPanel();
    await flush();

    expect(tauri.calls("agents_spawn")).toEqual([
      { cmd: "agents_spawn", args: { pluginId: PLUGIN } },
    ]);
    expect(tauri.calls("agents_new_session")).toEqual([
      {
        cmd: "agents_new_session",
        args: { agentId: AGENT.agent_id, cwd: "/proj", additionalDirectories: null },
      },
    ]);
    expect(session().acpSessionId).toBe("sess-1");
    expect(session().acpAgentId).toBe(AGENT.agent_id);
    expect(session().workingDirectory).toBe("/proj");
    expect(toastError).not.toHaveBeenCalled();

    // Bound: nothing binds again, whatever asks.
    emitWindowEvent("atlas:chat-input-started", { tabId: TAB });
    await advance(DEADLINE_MS);
    expect(count("agents_new_session")).toBe(1);
  });

  it("starts in the worktree the tab was asked to start in", async () => {
    useChatStore.setState((s) => {
      s.sessions[TAB]!.bindCwd = "/proj/.worktrees/a";
    });
    mountPanel();
    await flush();
    expect(tauri.calls("agents_new_session")[0]!.args.cwd).toBe("/proj/.worktrees/a");
    expect(session().workingDirectory).toBe("/proj/.worktrees/a");
  });

  it("puts the agent in the picked mode and model before the binding is visible", async () => {
    const modes = [
      { id: "read-only", name: "Read only" },
      { id: "auto", name: "Auto" },
    ];
    /** Was the tab bound when each command reached the backend? */
    const boundAt: Record<string, boolean> = {};
    const note = (cmd: string) => {
      boundAt[cmd] = !!session().acpSessionId;
      return null;
    };
    tauri.handleRaw({
      agents_new_session: ({ agentId }) => ({
        key: { agent_id: agentId, session_id: "sess-1" },
        current_mode: "auto",
        available_modes: modes,
      }),
      agents_set_mode: () => note("agents_set_mode"),
      agents_set_model: () => note("agents_set_model"),
    });
    act(() => {
      store().actions.setAcpModes(TAB, "read-only", modes, "codex");
      useChatStore.setState((s) => {
        s.sessions[TAB]!.acpModeExplicit = true;
        s.sessions[TAB]!.acpCurrentModel = "gpt-test";
      });
    });

    mountPanel();
    await flush();

    expect(tauri.calls("agents_set_mode")[0]!.args).toEqual({
      key: { agent_id: AGENT.agent_id, session_id: "sess-1" },
      modeId: "read-only",
    });
    expect(tauri.calls("agents_set_model")[0]!.args.modelId).toBe("gpt-test");
    // Binding is what releases a held first message: both must be there first.
    expect(boundAt).toEqual({ agents_set_mode: false, agents_set_model: false });
    expect(session().acpSessionId).toBe("sess-1");
    expect(session().acpCurrentMode).toBe("read-only");
  });

  it("shows the agent's mode, not the pick, when the agent refuses the pick", async () => {
    const modes = [
      { id: "read-only", name: "Read only" },
      { id: "auto", name: "Auto" },
    ];
    tauri.handleRaw({
      agents_new_session: ({ agentId }) => ({
        key: { agent_id: agentId, session_id: "sess-1" },
        current_mode: "auto",
        available_modes: modes,
      }),
      agents_set_mode: () => {
        throw "busy";
      },
      // Held: the snapshot would correct the picker a round trip later, and
      // the first prompt can go out before then.
      agents_snapshot_meta: () => new Promise(() => {}),
    });
    act(() => {
      store().actions.setAcpModes(TAB, "read-only", modes, "codex");
      useChatStore.setState((s) => {
        s.sessions[TAB]!.acpModeExplicit = true;
      });
    });

    mountPanel();
    await flush();

    expect(count("agents_set_mode")).toBe(1);
    expect(session().acpSessionId).toBe("sess-1");
    expect(session().acpCurrentMode).toBe("auto");
    // The mode showing is the agent's now, so it is nobody's pick.
    expect(session().acpModeExplicit).toBe(false);
  });

  // ACP audit finding 40
  it("shows the agent's model, not the pick, when the agent refuses the model picked before the bind", async () => {
    const models = [
      { id: "gpt-a", name: "A" },
      { id: "gpt-b", name: "B" },
    ];
    tauri.handleRaw({
      agents_set_model: () => {
        throw "unknown model";
      },
      agents_snapshot_meta: ({ key }) =>
        meta((key as { session_id: string }).session_id, {
          current_model: "gpt-a",
          available_models: models,
        }),
    });
    act(() => {
      useChatStore.setState((s) => {
        s.sessions[TAB]!.acpCurrentModel = "gpt-b";
      });
    });

    mountPanel();
    await flush();

    expect(count("agents_set_model")).toBe(1);
    expect(session().acpSessionId).toBe("sess-1");
    expect(session().acpCurrentModel).toBe("gpt-a");
  });

  it("binds once under StrictMode's double mount", async () => {
    mountPanel({ wrapper: StrictMode });
    await flush();

    expect(count("agents_new_session")).toBe(1);
    expect(session().acpSessionId).toBe("sess-1");
    // Mounting asks for nothing; the one write does.
    expect(count("agents_spawn")).toBe(1);
  });

  it("two panels on the same session bind once", async () => {
    mountPanel();
    mountPanel();
    await flush();

    expect(count("agents_new_session")).toBe(1);
    expect(session().acpSessionId).toBe("sess-1");
  });

  it("two panels: the bind outlives the panel whose kick started it", async () => {
    const spawn = deferred<typeof AGENT>();
    tauri.handleRaw({ agents_spawn: () => spawn.promise });
    const first = mountPanel();
    mountPanel();
    await flush();
    expect(count("agents_spawn")).toBe(1);

    first.unmount();
    spawn.resolve(AGENT);
    await flush();
    expect(count("agents_new_session")).toBe(1);
    expect(session().acpSessionId).toBe("sess-1");
  });

  it("coalesces a kick and composer input into the attempt already running", async () => {
    const spawn = deferred<typeof AGENT>();
    tauri.handleRaw({ agents_spawn: () => spawn.promise });
    const { result } = mountPanel();
    await flush();

    act(() => result.current.current?.kick());
    emitWindowEvent("atlas:chat-input-started", { tabId: TAB });
    await flush();
    expect(count("agents_spawn")).toBe(1);

    spawn.resolve(AGENT);
    await flush();
    expect(count("agents_new_session")).toBe(1);
  });
});

describe("once the binding lands", () => {
  const MODELS = [
    { id: "m-small", name: "Small" },
    { id: "m-large", name: "Large" },
  ];
  const KNOBS = [
    {
      id: "thought",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
        { value: "medium", name: "Medium" },
      ],
    },
  ];
  const advertising = () =>
    meta("sess-1", {
      current_model: "m-large",
      available_models: MODELS,
      available_commands: [{ name: "review", description: "Review the diff" }],
      config_options: KNOBS,
    });

  // The snapshot is an IPC round trip, so it always answers after the commit
  // in which the panel saw its tab bound and let go of the bind. Held here to
  // say so: answering in the same tick would hide what this pins.
  function heldSnapshot() {
    const snap = deferred<unknown>();
    tauri.handleRaw({
      // The first session's snapshot is the held one; a later session's
      // answers at once and advertises nothing.
      agents_snapshot_meta: ({ key }) => {
        const id = (key as { session_id: string }).session_id;
        return id === "sess-1" ? snap.promise : meta(id);
      },
    });
    return snap;
  }

  it("seeds what session/new advertised and no delta will repeat, and ends the loading state", async () => {
    const snap = heldSnapshot();
    mountPanel();
    await flush();
    expect(session().acpSessionId).toBe("sess-1");
    expect(session().acpModesPending).toBe(true);

    snap.resolve(advertising());
    await flush();
    expect(session().availableCommands).toHaveLength(1);
    expect(session().acpConfigOptions).toHaveLength(1);
    expect(session().acpAvailableModels).toHaveLength(2);
    expect(session().acpModesPending).toBe(false);
  });

  it("re-applies the user's remembered config-option picks to the new session", async () => {
    saveConfigOptionPref("codex", "thought", "high");
    const snap = heldSnapshot();
    mountPanel();
    await flush();
    snap.resolve(advertising());
    await flush();

    expect(tauri.calls("agents_set_config_option")).toEqual([
      {
        cmd: "agents_set_config_option",
        args: {
          key: { agent_id: AGENT.agent_id, session_id: "sess-1" },
          configId: "thought",
          value: "high",
        },
      },
    ]);
  });

  it("ends the loading state when the snapshot cannot be read", async () => {
    const snap = heldSnapshot();
    mountPanel();
    await flush();
    snap.reject({ message: "busy" });
    await flush();
    expect(session().acpModesPending).toBe(false);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("drops a snapshot that answers after the tab moved to another session", async () => {
    const snap = heldSnapshot();
    mountPanel();
    await flush();

    // "New session" in the same tab, before the first one's snapshot is back,
    // and the user writes in it.
    act(() => store().actions.clearSession(TAB));
    await flush();
    act(() => emitWindowEvent("atlas:chat-input-started", { tabId: TAB }));
    await flush();
    expect(session().acpSessionId).toBe("sess-2");
    snap.resolve(advertising());
    await flush();
    expect(session().availableCommands ?? []).toHaveLength(0);
    expect(session().acpAvailableModels ?? []).toHaveLength(0);
  });

  it("applies no remembered pick for an attempt let go while the options were being read", async () => {
    // The picks go in before the binding now, so the snapshot they are read
    // from answers while the attempt can still be let go.
    saveConfigOptionPref("codex", "thought", "high");
    const snap = heldSnapshot();
    const { result } = mountPanel();
    await flush();
    expect(session().acpSessionId).toBeUndefined();

    act(() => result.current.current?.abandon());
    snap.resolve(advertising());
    await flush();
    expect(count("agents_set_config_option")).toBe(0);
    expect(session().acpSessionId).toBeUndefined();
  });
});

describe("a first message sent before the bind has finished", () => {
  const KNOBS = [
    {
      id: "thought",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "high", name: "High" },
        { value: "medium", name: "Medium" },
      ],
    },
  ];
  const SENT = ["agents_set_config_option", "agents_set_effort", "agents_send"];
  /** The option pushes and the prompt, in the order they reached the backend. */
  const order = () =>
    tauri
      .calls()
      .map((call) => call.cmd)
      .filter((cmd) => SENT.includes(cmd));

  /** Hold `session/new`, mount, send "hello" into the tab that is still
   *  starting, and hand back what lets the bind carry on. */
  async function sendWhileStarting() {
    const created = deferred<unknown>();
    tauri.handleRaw({
      agents_new_session: () => created.promise,
      agents_snapshot_meta: ({ key }) =>
        meta((key as { session_id: string }).session_id, { config_options: KNOBS }),
    });
    const { result } = renderHook(() => useSendingPanel(TAB));
    await flush();
    await act(() =>
      sessionSend.send(
        TAB,
        { content: "hello", mentions: [] },
        { kickBind: () => result.current.current?.kick() },
      ),
    );
    expect(session().pendingSend?.content).toBe("hello");
    return () =>
      created.resolve({
        key: { agent_id: AGENT.agent_id, session_id: "sess-1" },
        current_mode: null,
        available_modes: [],
      });
  }

  it("goes out after the remembered option picks are applied, not before", async () => {
    saveConfigOptionPref("codex", "thought", "high");
    // The agent is slow to take the option: the window the prompt used to
    // slip through, on the agent's own default while the pill said "high".
    const taken = deferred<null>();
    tauri.handleRaw({ agents_set_config_option: () => taken.promise });
    const bindCarriesOn = await sendWhileStarting();

    bindCarriesOn();
    await flush();
    expect(order()).toEqual(["agents_set_config_option"]);
    expect(session().acpSessionId, "not exposed until the option is in").toBeUndefined();

    taken.resolve(null);
    await flush();
    expect(order()).toEqual(["agents_set_config_option", "agents_send"]);
    expect(tauri.calls("agents_set_config_option")[0]!.args).toMatchObject({
      configId: "thought",
      value: "high",
    });
    expect(session().acpSessionId).toBe("sess-1");
    expect(session().pendingSend).toBeUndefined();
    // And the pill follows from the snapshot read once the tab is bound.
    expect(session().acpConfigOptions).toHaveLength(1);
  });

  it("goes out after the native agent's reasoning effort is applied", async () => {
    act(() => {
      store().actions.switchChatAgent(TAB, "atlas-agent");
      useChatStore.setState((s) => {
        s.sessions[TAB]!.nativeEffort = "high";
      });
    });
    const taken = deferred<null>();
    tauri.handleRaw({ agents_set_effort: () => taken.promise });
    const bindCarriesOn = await sendWhileStarting();

    bindCarriesOn();
    await flush();
    expect(order()).toEqual(["agents_set_effort"]);
    expect(session().acpSessionId).toBeUndefined();

    taken.resolve(null);
    await flush();
    expect(order()).toEqual(["agents_set_effort", "agents_send"]);
    expect(tauri.calls("agents_set_effort")[0]!.args).toMatchObject({ effort: "high" });
  });

  it("still goes out when the agent refuses a remembered pick", async () => {
    saveConfigOptionPref("codex", "thought", "high");
    tauri.handleRaw({
      agents_set_config_option: () => {
        throw "not now";
      },
    });
    const bindCarriesOn = await sendWhileStarting();

    bindCarriesOn();
    await flush();
    expect(order()).toEqual(["agents_set_config_option", "agents_send"]);
    expect(session().acpSessionId).toBe("sess-1");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("still goes out when the options cannot be read", async () => {
    saveConfigOptionPref("codex", "thought", "high");
    const bindCarriesOn = await sendWhileStarting();
    tauri.handleRaw({
      agents_snapshot_meta: () => {
        throw { message: "busy" };
      },
    });

    bindCarriesOn();
    await flush();
    expect(order()).toEqual(["agents_send"]);
    expect(session().acpSessionId).toBe("sess-1");
    expect(session().acpModesPending).toBe(false);
  });

  it("is not held for ever by an option the agent never answers", async () => {
    saveConfigOptionPref("codex", "thought", "high");
    tauri.handleRaw({ agents_set_config_option: () => new Promise(() => {}) });
    const bindCarriesOn = await sendWhileStarting();

    bindCarriesOn();
    await advance(REAPPLY_MS - 1);
    expect(session().acpSessionId).toBeUndefined();
    await advance(1);
    expect(session().acpSessionId).toBe("sess-1");
    expect(order()).toEqual(["agents_set_config_option", "agents_send"]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("asks for nothing extra when nothing is remembered", async () => {
    const bindCarriesOn = await sendWhileStarting();
    bindCarriesOn();
    await flush();
    expect(order()).toEqual(["agents_send"]);
    // The one snapshot is the seeding one, read after the tab is bound.
    expect(count("agents_snapshot_meta")).toBe(1);
  });
});

describe("a bind that fails", () => {
  const failSpawn = (message: string, kind?: string) =>
    tauri.handleRaw({
      agents_spawn: () => Promise.reject(kind ? { message, kind } : { message }),
    });

  it("retries once in silence, then reports once, and does not loop", async () => {
    failSpawn("codex-acp exited with code 1");
    mountPanel();
    await flush();

    // The first failure of the automatic bind is the boot transient's.
    expect(count("agents_spawn")).toBe(1);
    expect(toastError).not.toHaveBeenCalled();
    expect(bindLogs()).toHaveLength(1);

    await advance(RETRY_MS);
    expect(count("agents_spawn")).toBe(2);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("codex-acp exited with code 1");
    expect(session().acpSessionId).toBeUndefined();
    expect(session().acpModesPending).toBe(false);

    // And then nothing, for as long as nobody asks.
    await advance(10 * DEADLINE_MS);
    expect(count("agents_spawn")).toBe(2);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("is retried by writing in the composer without a second toast, and logged every time", async () => {
    failSpawn("codex-acp exited with code 1");
    mountPanel();
    await flush();
    await advance(RETRY_MS);
    expect(toastError).toHaveBeenCalledTimes(1);

    emitWindowEvent("atlas:chat-input-started", { tabId: TAB });
    await flush();
    expect(count("agents_spawn")).toBe(3);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(bindLogs()).toHaveLength(3);

    // Another tab's input is not this tab's.
    emitWindowEvent("atlas:chat-input-started", { tabId: "some-other-tab" });
    await flush();
    expect(count("agents_spawn")).toBe(3);
  });

  it("keeps the held first message held, idle, and reports again while it waits", async () => {
    failSpawn("codex-acp exited with code 1");
    act(() => {
      store().actions.setPendingSend(TAB, { content: "hello", mentions: [] });
      store().actions.updateSessionStatus(TAB, "running");
    });
    mountPanel();
    await flush();
    // Still held through the silent retry.
    expect(session().pendingSend?.content).toBe("hello");

    await advance(RETRY_MS);
    expect(session().pendingSend?.content).toBe("hello");
    expect(session().status).toBe("idle");
    expect(store().queues[TAB]).toBeUndefined();
    expect(toastError).toHaveBeenCalledTimes(1);

    // Someone is waiting on this bind, so its next failure is said too.
    emitWindowEvent("atlas:chat-input-started", { tabId: TAB });
    await flush();
    expect(toastError).toHaveBeenCalledTimes(2);
  });

  // ACP audit finding 73 and 81: the queue carries text alone, and its drain draws the prompt.
  it("sends the held message as it was once a later bind lands: its images, its one bubble", async () => {
    failSpawn("codex-acp exited with code 1");
    const image = { mimeType: "image/png", dataBase64: "AAAA" };
    const { result } = renderHook(() => useSendingPanel(TAB));
    // The user writes, which is what starts the bind that fails.
    act(() => emitWindowEvent("atlas:chat-input-started", { tabId: TAB }));
    await flush();
    await advance(RETRY_MS);
    expect(toastError).toHaveBeenCalledTimes(1);
    await act(() =>
      sessionSend.send(
        TAB,
        { content: "hello", mentions: [], attachments: [image] },
        { kickBind: () => result.current.current?.kick() },
      ),
    );
    await flush();
    // The send's kick failed too: still held, with its image, beside one bubble.
    expect(session().pendingSend?.attachments).toEqual([image]);
    const bubbles = () => session().messages.filter((m) => m.role === "user");
    expect(bubbles()).toHaveLength(1);
    expect(store().queues[TAB]).toBeUndefined();

    healthyBackend();
    emitWindowEvent("atlas:chat-input-started", { tabId: TAB });
    await flush();
    expect(session().acpSessionId).toBe("sess-1");
    const sent = tauri.calls("agents_send");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.args.attachments).toEqual([image]);
    expect(sent[0]!.args.clientMessageId).toBe(bubbles()[0]!.clientMessageId);
    expect(count("agents_queue_add")).toBe(0);
    expect(session().pendingSend).toBeUndefined();
  });

  it("binds on a later attempt and reports the next breakage afresh", async () => {
    failSpawn("codex-acp exited with code 1");
    const { result } = mountPanel();
    await flush();
    await advance(RETRY_MS);
    expect(toastError).toHaveBeenCalledTimes(1);

    healthyBackend();
    emitWindowEvent("atlas:chat-input-started", { tabId: TAB });
    await flush();
    expect(session().acpSessionId).toBe("sess-1");
    expect(result.current.current).toBeNull();

    // The session is dropped (an agent switch back, a rebind of an empty
    // chat), the user writes again, and that bind fails: the earlier report
    // must not swallow it.
    failSpawn("codex-acp exited with code 2");
    resetAgent(PLUGIN);
    act(() => {
      useChatStore.setState((s) => {
        s.sessions[TAB]!.acpSessionId = undefined;
      });
    });
    await flush();
    act(() => emitWindowEvent("atlas:chat-input-started", { tabId: TAB }));
    await flush();
    await advance(RETRY_MS);
    expect(toastError).toHaveBeenCalledTimes(2);
    expect(toastError).toHaveBeenLastCalledWith("codex-acp exited with code 2");
  });

  it("offers sign-in once for an auth refusal, then says what the agent said", async () => {
    useAgentRegistryStore.setState({
      catalogById: {
        codex: { id: "codex", agentType: "codex", kind: "external", installed: true },
      } as unknown as Record<string, AgentCatalogEntry>,
    });
    failSpawn("Please log in", "auth");
    const asked: number[] = [];
    const off = onWindowEvent("atlas:agent-signin", (d) => asked.push(d.requestId));

    mountPanel();
    await flush();
    await advance(RETRY_MS);
    expect(asked).toHaveLength(1);
    // The dialog is the report (the one toast is its banner, for a user who
    // is looking elsewhere): the agent's raw refusal is not shown.
    expect(toastError.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual(["Sign in to Codex"]);

    // Signed in, and the agent refuses again: no second dialog, its own words.
    act(() => takeSignInCallback(asked[0]!)?.onSignedIn?.());
    await flush();
    expect(asked).toHaveLength(1);
    expect(toastError).toHaveBeenCalledTimes(2);
    expect(String(toastError.mock.calls[1]![0])).toContain(
      "still reports no credentials after signing in. It said: Please log in",
    );
    off();
  });

  // ACP audit finding 72
  it("dismissing the sign-in offers it again on the next failure, without claiming a sign-in", async () => {
    useAgentRegistryStore.setState({
      catalogById: {
        codex: { id: "codex", agentType: "codex", kind: "external", installed: true },
      } as unknown as Record<string, AgentCatalogEntry>,
    });
    failSpawn("Please log in", "auth");
    const asked: number[] = [];
    const off = onWindowEvent("atlas:agent-signin", (d) => asked.push(d.requestId));
    mountPanel();
    await flush();
    await advance(RETRY_MS);
    expect(asked).toHaveLength(1);

    act(() => takeSignInCallback(asked[0]!)?.onDismissed?.());
    emitWindowEvent("atlas:chat-input-started", { tabId: TAB });
    await flush();
    expect(asked).toHaveLength(2);
    expect(asked[1]).not.toBe(asked[0]);
    expect(toastError.mock.calls.map((c: unknown[]) => String(c[0])).join("\n")).not.toContain(
      "after signing in",
    );
    off();
  });

  it("two tabs asking to sign in to one agent share one dialog, and both hear it end", async () => {
    useAgentRegistryStore.setState({
      catalogById: {
        codex: { id: "codex", agentType: "codex", kind: "external", installed: true },
      } as unknown as Record<string, AgentCatalogEntry>,
    });
    failSpawn("Please log in", "auth");
    act(() => store().actions.createSession("tab-2", "codex"));
    const asked: number[] = [];
    const off = onWindowEvent("atlas:agent-signin", (d) => asked.push(d.requestId));
    mountPanel();
    renderHook(() => usePanel("tab-2"));
    act(() => emitWindowEvent("atlas:chat-input-started", { tabId: "tab-2" }));
    await flush();
    await advance(RETRY_MS);
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(new Set(asked).size).toBe(1);

    // Signed in once: both tabs bind.
    healthyBackend();
    act(() => takeSignInCallback(asked[0]!)?.onSignedIn?.());
    await flush();
    expect(session().acpSessionId).toBeDefined();
    expect(store().sessions["tab-2"]!.acpSessionId).toBeDefined();
    off();
  });
});

describe("a bind that hangs (ADR-0008)", () => {
  it("is noted as stalled at 30 s and ended at 3 min: connection killed, message kept, reported", async () => {
    tauri.handleRaw({ agents_spawn: () => new Promise(() => {}) });
    act(() => {
      store().actions.setPendingSend(TAB, { content: "hello", mentions: [] });
      store().actions.updateSessionStatus(TAB, "running");
      store().actions.setAgentStartingStatus(PLUGIN, "Installing codex-acp…");
    });
    mountPanel();

    await advance(STALL_MS - 1);
    expect(bindLogs()).toEqual([]);
    await advance(1);
    expect(bindLogs()).toHaveLength(1);
    expect(bindLogs()[0]).toContain("bind stalled (no answer after 30s)");

    await advance(DEADLINE_MS - STALL_MS - 1);
    expect(count("agents_kill_plugin")).toBe(0);
    await advance(1);

    // The documented end state: the hop is named, the plugin's connection is
    // killed by plugin id, the message still held, the tab idle.
    expect(tauri.calls("agents_kill_plugin")).toEqual([
      { cmd: "agents_kill_plugin", args: { pluginId: PLUGIN } },
    ]);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0]![0])).toContain(
      "has not finished connecting in 3 minutes",
    );
    expect(session().pendingSend?.content).toBe("hello");
    expect(session().status).toBe("idle");
    expect(store().queues[TAB]).toBeUndefined();
    expect(session().acpModesPending).toBe(false);
    expect(store().agentStartingStatus[PLUGIN]).toBeUndefined();
    expect(session().acpSessionId).toBeUndefined();

    // A three-minute hang is not the boot transient: no silent retry.
    await advance(10 * DEADLINE_MS);
    expect(count("agents_spawn")).toBe(1);

    // The way out still works: the next ask is a fresh connect.
    healthyBackend();
    emitWindowEvent("atlas:chat-input-started", { tabId: TAB });
    await flush();
    expect(session().acpSessionId).toBe("sess-1");
  });

  it("ends a session/new that never answers the same way", async () => {
    tauri.handleRaw({ agents_new_session: () => new Promise(() => {}) });
    mountPanel();
    await advance(DEADLINE_MS);

    expect(count("agents_kill_plugin")).toBe(1);
    expect(String(toastError.mock.calls[0]![0])).toContain(
      "has not answered `session/new` in 3 minutes",
    );
    // The killed connection's agent is forgotten: the next attempt connects again.
    emitWindowEvent("atlas:chat-input-started", { tabId: TAB });
    await flush();
    expect(count("agents_spawn")).toBe(2);
  });

  it("waits on while an install keeps restating its status, and ends when it stops", async () => {
    tauri.handleRaw({ agents_spawn: () => new Promise(() => {}) });
    mountPanel();

    await advance(60_000);
    act(() => store().actions.setAgentStartingStatus(PLUGIN, "Installing codex-acp… 60s"));
    await advance(DEADLINE_MS - 60_000);
    // The status moved inside the window: alive, so the deadline re-arms.
    expect(count("agents_kill_plugin")).toBe(0);

    // Same text a window later: a wedged install.
    await advance(DEADLINE_MS);
    expect(count("agents_kill_plugin")).toBe(1);
    expect(store().agentStartingStatus[PLUGIN]).toBeUndefined();
  });

  it("is superseded by Restart, and what the old attempt answers later is dropped", async () => {
    const hung = deferred<typeof AGENT>();
    let spawns = 0;
    tauri.handleRaw({ agents_spawn: () => (++spawns === 1 ? hung.promise : AGENT) });
    const { result } = mountPanel();
    await flush();

    act(() => result.current.current?.retry());
    await flush();
    expect(count("agents_spawn")).toBe(2);
    expect(session().acpSessionId).toBe("sess-1");

    hung.resolve(AGENT);
    await flush();
    expect(count("agents_new_session")).toBe(1);
    expect(session().acpSessionId).toBe("sess-1");
  });

  it("is let go by Stop, so the next send's kick binds again", async () => {
    const hung = deferred<typeof AGENT>();
    let spawns = 0;
    tauri.handleRaw({ agents_spawn: () => (++spawns === 1 ? hung.promise : AGENT) });
    const { result } = mountPanel();
    await flush();

    act(() => result.current.current?.abandon());
    await flush();
    expect(count("agents_spawn")).toBe(1);

    act(() => result.current.current?.kick());
    await flush();
    expect(session().acpSessionId).toBe("sess-1");
  });
});

describe("a panel that goes away mid-bind", () => {
  it("unmounted while connecting: no session is created and nothing is written", async () => {
    const spawn = deferred<typeof AGENT>();
    tauri.handleRaw({ agents_spawn: () => spawn.promise });
    const { result, unmount } = mountPanel();
    await flush();
    const control = result.current;
    expect(control.current).not.toBeNull();

    unmount();
    expect(control.current).toBeNull();
    spawn.resolve(AGENT);
    await flush();
    expect(count("agents_new_session")).toBe(0);
    expect(session().acpSessionId).toBeUndefined();

    // Its input listener and its clocks went with it.
    emitWindowEvent("atlas:chat-input-started", { tabId: TAB });
    await advance(10 * DEADLINE_MS);
    expect(count("agents_spawn")).toBe(1);
    expect(count("agents_kill_plugin")).toBe(0);
    expect(bindLogs()).toEqual([]);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("unmounted while session/new is out: the answer is not bound to the tab", async () => {
    const created = deferred<unknown>();
    tauri.handleRaw({ agents_new_session: () => created.promise });
    const { unmount } = mountPanel();
    await flush();
    expect(count("agents_new_session")).toBe(1);

    unmount();
    created.resolve({
      key: { agent_id: AGENT.agent_id, session_id: "sess-late" },
      current_mode: null,
      available_modes: [],
    });
    await flush();
    expect(session().acpSessionId).toBeUndefined();
    expect(count("agents_set_mode")).toBe(0);
    expect(count("agents_snapshot_meta")).toBe(0);
    // The session the agent did create is handed back: nothing else knows it
    // exists (ACP audit finding 11).
    expect(tauri.calls("agents_drop_session").map((c) => c.args)).toEqual([
      { agentId: AGENT.agent_id, sessionId: "sess-late" },
    ]);
  });

  it("restarted while session/new is out: the abandoned session is dropped, the new one kept", async () => {
    const created = deferred<unknown>();
    let news = 0;
    tauri.handleRaw({
      agents_new_session: () =>
        ++news === 1
          ? created.promise
          : {
              key: { agent_id: AGENT.agent_id, session_id: "sess-new" },
              current_mode: null,
              available_modes: [],
            },
    });
    const { result } = mountPanel();
    await flush();
    act(() => result.current.current?.retry());
    await flush();
    expect(session().acpSessionId).toBe("sess-new");

    created.resolve({
      key: { agent_id: AGENT.agent_id, session_id: "sess-abandoned" },
      current_mode: null,
      available_modes: [],
    });
    await flush();
    expect(session().acpSessionId).toBe("sess-new");
    expect(tauri.calls("agents_drop_session").map((c) => c.args)).toEqual([
      { agentId: AGENT.agent_id, sessionId: "sess-abandoned" },
    ]);
  });

  it("a failure that lands after the unmount is not reported or retried", async () => {
    const spawn = deferred<typeof AGENT>();
    tauri.handleRaw({ agents_spawn: () => spawn.promise });
    const { unmount } = mountPanel();
    await flush();
    unmount();
    spawn.reject({ message: "codex-acp exited with code 1" });
    await advance(10 * DEADLINE_MS);
    expect(count("agents_spawn")).toBe(1);
    expect(toastError).not.toHaveBeenCalled();
    expect(bindLogs()).toEqual([]);
  });

  it("the tab's session is gone when the bind lands: nothing is written", async () => {
    const created = deferred<unknown>();
    tauri.handleRaw({ agents_new_session: () => created.promise });
    mountPanel();
    await flush();
    act(() => {
      useChatStore.setState((s) => {
        delete s.sessions[TAB];
      });
    });
    created.resolve({
      key: { agent_id: AGENT.agent_id, session_id: "sess-late" },
      current_mode: null,
      available_modes: [],
    });
    await flush();
    expect(store().sessions[TAB]).toBeUndefined();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe("switching agent mid-bind", () => {
  it("drops the bind for the agent the tab left and binds the one it is on", async () => {
    const codex = deferred<typeof AGENT>();
    tauri.handleRaw({
      agents_spawn: ({ pluginId }) =>
        pluginId === PLUGIN
          ? codex.promise
          : { agent_id: "agent-opencode", spec_id: "opencode", display_name: "OpenCode" },
    });
    mountPanel();
    await flush();

    act(() => store().actions.switchChatAgent(TAB, "opencode"));
    await flush();
    expect(session().acpAgentId).toBe("agent-opencode");

    codex.resolve(AGENT);
    await flush();
    expect(count("agents_new_session")).toBe(1);
    expect(session().acpAgentId).toBe("agent-opencode");
    expect(session().acpSessionId).toBe("sess-1");
  });
});

describe("a start the user asked for", () => {
  it("is carried on by an agent switch, but not once the user stopped it", async () => {
    const hung = deferred<typeof AGENT>();
    tauri.handleRaw({ agents_spawn: () => hung.promise });
    const { result } = mountPanel();
    await flush();

    // Stop while it is still starting: the user let go of this session.
    act(() => result.current.current?.abandon());
    healthyBackend();
    act(() => store().actions.switchChatAgent(TAB, "opencode"));
    await flush();
    expect(count("agents_new_session")).toBe(0);
    expect(session().acpSessionId).toBeUndefined();
  });
});

describe("a panel that goes away with its start unfinished", () => {
  it("takes the request with it: mounting again starts nothing by itself", async () => {
    const hung = deferred<typeof AGENT>();
    tauri.handleRaw({ agents_spawn: () => hung.promise });
    const { unmount } = mountPanel();
    await flush();
    unmount();
    await flush();

    healthyBackend();
    renderHook(() => usePanel(TAB));
    await flush();
    expect(count("agents_new_session")).toBe(0);
    expect(session().acpSessionId).toBeUndefined();
  });
});

describe("an agent that disconnects", () => {
  it("is not rebound by the panel: the session id stays, and nothing runs unprompted", async () => {
    mountPanel();
    await flush();
    expect(session().acpSessionId).toBe("sess-1");

    act(() => store().actions.setDisconnected(TAB, true));
    resetAgent(PLUGIN);
    emitWindowEvent("atlas:chat-input-started", { tabId: TAB });
    await advance(10 * DEADLINE_MS);

    // The rebind is the next Send's or Restart's (`rebindDisconnectedSession`).
    expect(count("agents_spawn")).toBe(1);
    expect(count("agents_new_session")).toBe(1);
    expect(session().disconnected).toBe(true);
  });
});
