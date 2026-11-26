// @vitest-environment happy-dom
//
// Setting a session's configuration through the store's public actions, over
// the shared Tauri fake (which stands where Rust does): the permission mode,
// the model, the reasoning effort and an agent-advertised option.
//
// One table, a row per knob, because the sequence is the same for each: show
// the pick, push it to the agent, take it back if the agent says no, remember
// it for the next session. Where the knobs differ, the row says how
// (`optimistic`, `hasPreference`, `unbound`, `unoffered`), so a difference is
// a stated fact here rather than something that happens to be true of one
// action.
//
// The module's own suite (`../lib/session-configuration.test.ts`) covers the
// same sequence against in-memory fakes; this one is the wiring.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    info: vi.fn(),
    success: vi.fn(),
  },
}));

import { tauri } from "@/test/tauri-fake";
import type { AgentDelta } from "@/types/agents";
import type { AgentType, ChatSession } from "@/types/agent";
import { parseConfigOptions } from "../lib/acp-config-options";
import { loadCachedAcpConfigOptions } from "../lib/acp-config-options-cache";
import { loadCachedAcpModels } from "../lib/acp-models-cache";
import { loadConfigOptionPrefs } from "../lib/config-option-prefs";
import { loadLastModePref } from "../lib/last-mode-pref";
import { loadNativeEffort } from "../lib/native-model-pref";
import { useChatStore } from "./chat-store";

const TAB = "tab-1";
const KEY = { agent_id: "agent-1", session_id: "acp-1" };

const actions = () => useChatStore.getState().actions;
const session = (): ChatSession => useChatStore.getState().sessions[TAB]!;
const patch = (recipe: (s: ChatSession) => void) =>
  useChatStore.setState((s) => {
    recipe(s.sessions[TAB]!);
  });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const ACP_MODES = [
  { id: "read-only", name: "Read only" },
  { id: "auto", name: "Auto" },
  { id: "full-access", name: "Full access" },
];
const MODELS = [
  { id: "sonnet", name: "Sonnet" },
  { id: "opus", name: "Opus" },
  { id: "haiku", name: "Haiku" },
];
/** The wire shape of a select option: the kind under `type`, a choice's id
 *  under `value`. */
const thought = (currentValue: string) => ({
  id: "thought",
  name: "Thinking",
  type: "select",
  currentValue,
  options: [
    { value: "low", name: "Low" },
    { value: "high", name: "High" },
    { value: "max", name: "Max" },
  ],
});
const delta = (fields: Record<string, unknown>) =>
  ({ agent_id: KEY.agent_id, session_id: KEY.session_id, ...fields }) as unknown as AgentDelta;

interface Knob {
  name: string;
  agent: AgentType;
  /** The command that carries a pick to the agent. */
  cmd: string;
  /** What the command is called with, besides the session key. */
  args: (value: string) => Record<string, unknown>;
  /** Put the session where the agent advertises the knob and sits on `before`. */
  seed: () => void;
  pick: (value: string) => void;
  /** What the composer shows. */
  shown: () => unknown;
  /** What the next session on this agent would start from. */
  remembered: () => unknown;
  before: string;
  first: string;
  second: string;
  /** Does the composer show a pick before the agent has answered? */
  optimistic: boolean;
  /** Is anything remembered at all? */
  hasPreference: boolean;
  /** A pick made before there is a session to push it to. */
  unbound: "kept-for-bind" | "refused";
  /** The agent reporting a change of its own, where it has a way to. */
  reported?: (value: string) => AgentDelta;
  /** A pick the session does not offer. */
  unoffered: { arrange: () => void; pick: () => void };
}

const KNOBS: Knob[] = [
  {
    name: "Claude permission mode",
    agent: "claude-code",
    cmd: "agents_set_mode",
    args: (modeId) => ({ modeId }),
    seed: () => {},
    pick: (v) => actions().setClaudePermissionMode(TAB, v as "plan"),
    shown: () => session().claudePermissionMode,
    remembered: () => loadLastModePref("claude-code"),
    before: "default",
    first: "acceptEdits",
    second: "plan",
    optimistic: true,
    hasPreference: true,
    unbound: "kept-for-bind",
    reported: (mode_id) => delta({ kind: "mode_changed", mode_id }),
    // The permission modes are Claude's: another agent's session has no such knob.
    unoffered: {
      arrange: () => actions().switchChatAgent(TAB, "codex"),
      pick: () => actions().setClaudePermissionMode(TAB, "plan"),
    },
  },
  {
    name: "ACP mode",
    agent: "codex",
    cmd: "agents_set_mode",
    args: (modeId) => ({ modeId }),
    seed: () => actions().setAcpModes(TAB, "auto", ACP_MODES, "codex"),
    pick: (v) => actions().setAcpMode(TAB, v),
    shown: () => session().acpCurrentMode,
    remembered: () => loadLastModePref("codex"),
    before: "auto",
    first: "read-only",
    second: "full-access",
    optimistic: true,
    hasPreference: true,
    unbound: "kept-for-bind",
    reported: (mode_id) => delta({ kind: "mode_changed", mode_id }),
    unoffered: { arrange: () => {}, pick: () => actions().setAcpMode(TAB, "yolo") },
  },
  {
    name: "model",
    agent: "codex",
    cmd: "agents_set_model",
    args: (modelId) => ({ modelId }),
    seed: () => actions().setAcpModels(TAB, "sonnet", MODELS),
    pick: (v) => actions().setAcpModel(TAB, v),
    shown: () => session().acpCurrentModel,
    remembered: () => null,
    before: "sonnet",
    first: "opus",
    second: "haiku",
    optimistic: true,
    hasPreference: false,
    unbound: "kept-for-bind",
    reported: (model_id) => delta({ kind: "model_changed", model_id }),
    unoffered: { arrange: () => {}, pick: () => actions().setAcpModel(TAB, "") },
  },
  {
    name: "reasoning effort",
    agent: "atlas-agent",
    cmd: "agents_set_effort",
    args: (effort) => ({ effort }),
    seed: () =>
      patch((s) => {
        s.nativeEffort = "low";
      }),
    pick: (v) => actions().setNativeEffort(TAB, v),
    shown: () => session().nativeEffort,
    remembered: () => loadNativeEffort() || null,
    before: "low",
    first: "medium",
    second: "high",
    optimistic: true,
    hasPreference: true,
    unbound: "kept-for-bind",
    // The effort level is the native agent's: no other session has the knob.
    unoffered: {
      arrange: () => actions().switchChatAgent(TAB, "codex"),
      pick: () => actions().setNativeEffort(TAB, "high"),
    },
  },
  {
    name: "advertised option",
    agent: "codex",
    cmd: "agents_set_config_option",
    args: (value) => ({ configId: "thought", value }),
    seed: () => actions().setAcpConfigOptions(TAB, [thought("low")], "codex"),
    pick: (v) => void actions().setAcpConfigOption(TAB, "thought", v),
    shown: () => {
      const knob = parseConfigOptions(session().acpConfigOptions).find((o) => o.id === "thought");
      return knob?.kind === "select" ? knob.currentValue : undefined;
    },
    remembered: () => loadConfigOptionPrefs("codex").thought ?? null,
    before: "low",
    first: "high",
    second: "max",
    // The agent's answer to the set is the confirmed list, as a delta: nothing
    // is guessed in between.
    optimistic: false,
    hasPreference: true,
    unbound: "refused",
    reported: (value) =>
      delta({ kind: "config_options_updated", config_options: [thought(value)] }),
    unoffered: {
      arrange: () => {},
      pick: () => void actions().setAcpConfigOption(TAB, "verbosity", "high"),
    },
  },
];

/** A handler that answers when the test says so. */
function held() {
  let settle: { resolve: () => void; reject: (reason: unknown) => void } | undefined;
  const promise = new Promise<null>((resolve, reject) => {
    settle = { resolve: () => resolve(null), reject };
  });
  return { promise, resolve: () => settle!.resolve(), reject: (r: unknown) => settle!.reject(r) };
}

beforeEach(() => {
  localStorage.clear();
  toastError.mockClear();
  tauri.reset();
  useChatStore.setState({ sessions: {}, activeSessionId: null });
});

describe.each(KNOBS)("picking a session's $name", (knob) => {
  const bound = () => {
    actions().createSession(TAB, knob.agent);
    actions().setAcpBinding(TAB, KEY.agent_id, KEY.session_id, "/tmp");
    knob.seed();
    tauri.invoke.mockClear();
  };
  const pushes = () => tauri.calls(knob.cmd).map((call) => call.args);

  it("shows the pick, pushes it to the agent once and remembers it", async () => {
    bound();
    expect(knob.shown()).toBe(knob.before);

    knob.pick(knob.first);
    if (knob.optimistic) expect(knob.shown(), "before the agent answers").toBe(knob.first);
    await flush();

    expect(pushes()).toEqual([{ key: KEY, ...knob.args(knob.first) }]);
    expect(knob.shown()).toBe(knob.optimistic ? knob.first : knob.before);
    expect(knob.remembered()).toBe(knob.hasPreference ? knob.first : null);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("takes a refused pick back, says why once, and does not remember it", async () => {
    bound();
    tauri.handleRaw({
      [knob.cmd]: () => {
        throw "the agent said no";
      },
    });

    knob.pick(knob.first);
    await flush();

    expect(knob.shown()).toBe(knob.before);
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("the agent said no");
    expect(knob.remembered()).toBeNull();
  });

  it("leaves a newer pick alone when an older one is refused late", async () => {
    bound();
    const first = held();
    tauri.handleRaw({
      [knob.cmd]: (args) =>
        JSON.stringify(args).includes(`"${knob.first}"`) ? first.promise : null,
    });

    knob.pick(knob.first);
    knob.pick(knob.second);
    await flush();
    first.reject("too late");
    await flush();

    expect(pushes()).toHaveLength(2);
    if (knob.optimistic) expect(knob.shown()).toBe(knob.second);
    expect(knob.remembered()).toBe(knob.hasPreference ? knob.second : null);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("goes back to what the agent has when two picks in a row are refused", async () => {
    bound();
    const first = held();
    const second = held();
    tauri.handleRaw({
      [knob.cmd]: (args) =>
        JSON.stringify(args).includes(`"${knob.first}"`) ? first.promise : second.promise,
    });

    knob.pick(knob.first);
    knob.pick(knob.second);
    first.reject("no");
    await flush();
    second.reject("no");
    await flush();

    expect(knob.shown()).toBe(knob.before);
    expect(knob.remembered()).toBeNull();
  });

  it(`a pick before the session is bound is ${knob.unbound}`, async () => {
    actions().createSession(TAB, knob.agent);
    knob.seed();
    const before = knob.shown();

    knob.pick(knob.first);
    await flush();

    expect(pushes()).toEqual([]);
    expect(toastError).not.toHaveBeenCalled();
    if (knob.unbound === "refused") {
      expect(knob.shown()).toBe(before);
      expect(knob.remembered()).toBeNull();
    } else {
      // The bind reads it from here and puts the agent on it before the
      // first prompt (`use-agent-bind.test.tsx`).
      expect(knob.shown()).toBe(knob.first);
      expect(knob.remembered()).toBe(knob.hasPreference ? knob.first : null);
    }
  });

  it("follows a change the agent reports, without pushing it back or remembering it", async () => {
    if (!knob.reported) return;
    bound();

    actions().applyAgentDelta(knob.reported(knob.second));
    await flush();

    expect(knob.shown()).toBe(knob.second);
    expect(pushes()).toEqual([]);
    expect(knob.remembered()).toBeNull();
  });

  it("refuses a pick the session does not offer", async () => {
    bound();
    knob.unoffered.arrange();
    actions().setAcpBinding(TAB, KEY.agent_id, KEY.session_id, "/tmp");
    tauri.invoke.mockClear();
    const before = knob.shown();
    const remembered = knob.remembered();

    knob.unoffered.pick();
    await flush();

    expect(pushes()).toEqual([]);
    expect(knob.shown()).toBe(before);
    expect(knob.remembered()).toBe(remembered);
  });
});

// The fold that applies a report only mirrors it. Keeping the report for the
// next launch is the applying action's, after the fold.
describe.each([
  ["one at a time", (env: AgentDelta) => actions().applyAgentDelta(env)],
  [
    "in a frame's batch",
    (env: AgentDelta) => actions().applyAgentBatch({ texts: [], thoughts: [], deltas: [env] }),
  ],
])("the options an agent reports, applied %s", (_name, apply) => {
  const modelSelect = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "opus",
    options: MODELS.map((m) => ({ value: m.id, name: m.name })),
  };

  it("are mirrored, and cached for the agent's next launch", () => {
    actions().createSession(TAB, "codex");
    actions().setAcpBinding(TAB, KEY.agent_id, KEY.session_id, "/tmp");
    const reported = [thought("high"), modelSelect];

    apply(delta({ kind: "config_options_updated", config_options: reported }));

    expect(session().acpConfigOptions).toEqual(reported);
    expect(session().acpCurrentModel).toBe("opus");
    expect(loadCachedAcpConfigOptions("codex")).toEqual(reported);
    expect(loadCachedAcpModels("codex")?.availableModels.map((m) => m.id)).toEqual(
      MODELS.map((m) => m.id),
    );
    expect(tauri.calls()).toEqual([]);
  });

  it("are not cached when no tab holds the session they are about", () => {
    apply(delta({ kind: "config_options_updated", config_options: [thought("high")] }));
    expect(loadCachedAcpConfigOptions("codex")).toBeNull();
  });
});

// ACP audit finding 45: the plan-approval mapping used to apply only to an
// agent whose id was `claude-code`, so the registry's Claude (`claude-acp`),
// which advertises its modes, stayed on "plan" after the user approved a plan
// with "accept edits". It is keyed on the prompt's option ids now, and the
// mode lands in the record the session holds.
describe("a plan-approval choice", () => {
  const CLAUDE_ACP_MODES = [
    { id: "default", name: "Default" },
    { id: "acceptEdits", name: "Accept Edits" },
    { id: "plan", name: "Plan Mode" },
    { id: "bypassPermissions", name: "Bypass Permissions" },
  ];
  const bound = (agent: AgentType) => {
    actions().createSession(TAB, agent);
    actions().setAcpBinding(TAB, KEY.agent_id, KEY.session_id, "/tmp");
    actions().setAcpModes(TAB, "plan", CLAUDE_ACP_MODES, agent);
    tauri.invoke.mockClear();
  };

  it("moves an agent that advertises its modes, whatever its id, off plan", async () => {
    bound("claude-acp");
    actions().applyExitPlanSelection(TAB, "exit-plan-accept-edits");
    await flush();
    expect(session().acpCurrentMode).toBe("acceptEdits");
    expect(tauri.calls("agents_set_mode").map((c) => c.args)).toEqual([
      { key: KEY, modeId: "acceptEdits" },
    ]);
    // Not the user's pick: nothing is remembered for the next session.
    expect(loadLastModePref("claude-acp")).toBeNull();
  });

  it("applies the card's bypass override on the same shape", async () => {
    bound("claude-acp");
    actions().applyExitPlanSelection(TAB, "exit-plan-auto", "bypassPermissions");
    await flush();
    expect(session().acpCurrentMode).toBe("bypassPermissions");
  });

  it("does nothing for an option that is not a plan approval", async () => {
    bound("claude-acp");
    actions().applyExitPlanSelection(TAB, "allow_once", "bypassPermissions");
    await flush();
    expect(session().acpCurrentMode).toBe("plan");
    expect(tauri.calls("agents_set_mode")).toEqual([]);
  });

  it("does not put an agent on a mode it does not advertise", async () => {
    bound("codex");
    actions().setAcpModes(TAB, "auto", ACP_MODES, "codex");
    tauri.invoke.mockClear();
    actions().applyExitPlanSelection(TAB, "exit-plan-accept-edits");
    await flush();
    expect(session().acpCurrentMode).toBe("auto");
    expect(tauri.calls("agents_set_mode")).toEqual([]);
  });
});
