// Setting a session's configuration, through the module's own interface:
// `pick` over an in-memory agents backend, an in-memory session and an
// in-memory preference store. No store, no Tauri, no DOM.
//
// The table over every knob, through the store's actions, is
// `../stores/chat-store.configuration.test.ts`. This suite is for what is
// easier to say here: what `pick` answers, what a knob's descriptor decides,
// and the order things happen in.

import { beforeEach, describe, expect, it } from "vitest";
import type { ChatSession } from "@/types/agent";
import type { SessionKey } from "@/types/agents";
import {
  KNOBS,
  createSessionConfiguration,
  type ConfigurationAgentsPort,
  type SessionConfiguration,
} from "./session-configuration";

const TAB = "tab-1";
const KEY: SessionKey = { agent_id: "agent-1", session_id: "acp-1" };

/** One push the fake backend received. */
type Push = { cmd: keyof ConfigurationAgentsPort; value: unknown; configId?: string };

let sessions: Record<string, ChatSession>;
let pushes: Push[];
/** Decides how the backend answers a push. Default: it accepts. */
let answer: (push: Push) => Promise<void>;
let prefs: { modes: Record<string, string | null>; effort?: string; options: unknown[] };
/** Option values remembered from earlier sessions, per agent. */
let remembered: Record<string, Record<string, boolean | string>>;
let refusals: string[];
let configuration: SessionConfiguration;

const session = () => sessions[TAB]!;

/** A session on `agentType`, bound unless told otherwise. */
function open(agentType: string, fields: Partial<ChatSession> = {}, bound = true) {
  sessions[TAB] = {
    id: TAB,
    agentType,
    ...(bound ? { acpAgentId: KEY.agent_id, acpSessionId: KEY.session_id } : {}),
    ...fields,
  } as ChatSession;
}

function held() {
  let reject!: (reason: unknown) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  sessions = {};
  pushes = [];
  answer = async () => {};
  prefs = { modes: {}, options: [] };
  remembered = {};
  refusals = [];
  const record =
    (cmd: Push["cmd"]) =>
    (key: SessionKey, value: unknown): Promise<void> => {
      expect(key).toEqual(KEY);
      const push = { cmd, value };
      pushes.push(push);
      return answer(push);
    };
  configuration = createSessionConfiguration({
    agents: {
      setMode: record("setMode"),
      setModel: record("setModel"),
      setEffort: record("setEffort"),
      setConfigOption: (key, configId, value) => {
        expect(key).toEqual(KEY);
        const push: Push = { cmd: "setConfigOption", configId, value };
        pushes.push(push);
        return answer(push);
      },
    },
    sessions: {
      get: (tabId) => sessions[tabId],
      update: (tabId, recipe) => {
        const found = sessions[tabId];
        if (found) recipe(found);
      },
    },
    prefs: {
      saveMode: (agentType, mode) => {
        prefs.modes[agentType] = mode;
      },
      saveEffort: (effort) => {
        prefs.effort = effort;
      },
      saveOption: (agentType, configId, value) => {
        prefs.options.push([agentType, configId, value]);
      },
      loadOptions: (agentType) => remembered[agentType] ?? {},
    },
    report: { refused: (message) => refusals.push(message) },
  });
});

describe("pick", () => {
  it("answers `applied` once the agent has taken the pick", async () => {
    open("codex", { acpCurrentMode: "auto" });

    const outcome = configuration.pick(TAB, KNOBS.acpMode, "read-only");
    expect(session().acpCurrentMode, "shown before the agent answers").toBe("read-only");

    expect(await outcome).toBe("applied");
    expect(pushes).toEqual([{ cmd: "setMode", value: "read-only" }]);
    expect(prefs.modes).toEqual({ codex: "read-only" });
    expect(refusals).toEqual([]);
  });

  it("answers `refused`, puts the composer back and passes on the agent's words", async () => {
    open("codex", { acpCurrentModel: "sonnet" });
    answer = async () => {
      throw "model 'opus' is not in the catalogue";
    };

    expect(await configuration.pick(TAB, KNOBS.model, "opus")).toBe("refused");

    expect(session().acpCurrentModel).toBe("sonnet");
    expect(refusals).toEqual(["model 'opus' is not in the catalogue"]);
  });

  it("leaves the composer alone when the agent has moved it since the pick", async () => {
    open("codex", { acpCurrentMode: "auto" });
    const push = held();
    answer = () => push.promise;

    const outcome = configuration.pick(TAB, KNOBS.acpMode, "read-only");
    // The agent reports a mode of its own while the push is out.
    session().acpCurrentMode = "full-access";
    push.reject("busy");

    expect(await outcome).toBe("refused");
    expect(session().acpCurrentMode).toBe("full-access");
  });

  it("goes back to the last pick the agent took, not to the one before the refusal", async () => {
    open("codex", { acpCurrentMode: "auto" });
    const outs = [held(), held(), held()];
    answer = () => outs[pushes.length - 1]!.promise;

    const first = configuration.pick(TAB, KNOBS.acpMode, "read-only");
    const second = configuration.pick(TAB, KNOBS.acpMode, "full-access");
    const third = configuration.pick(TAB, KNOBS.acpMode, "auto");
    // The answers come back out of order.
    outs[1]!.reject("busy");
    outs[0]!.resolve();
    outs[2]!.reject("busy");

    expect(await Promise.all([first, second, third])).toEqual(["applied", "refused", "refused"]);
    expect(session().acpCurrentMode).toBe("read-only");
    expect(refusals).toHaveLength(2);
  });

  it("a refused first pick shows nothing again, when nothing was showing", async () => {
    open("codex");
    answer = async () => {
      throw "no";
    };

    await configuration.pick(TAB, KNOBS.model, "opus");

    expect(session().acpCurrentModel).toBeUndefined();
  });

  it("answers `kept-for-bind` for a pick with no session to push to", async () => {
    open("codex", {}, false);

    expect(await configuration.pick(TAB, KNOBS.acpMode, "read-only")).toBe("kept-for-bind");

    expect(pushes).toEqual([]);
    // The bind reads the pick from the flag, and pushes it before the first prompt.
    expect(session()).toMatchObject({ acpCurrentMode: "read-only", acpModeExplicit: true });
    expect(prefs.modes).toEqual({ codex: "read-only" });
  });

  it("answers `refused` for a tab that has no session", async () => {
    expect(await configuration.pick("nobody", KNOBS.model, "opus")).toBe("refused");
    expect(pushes).toEqual([]);
  });
});

describe("a pick the session does not offer", () => {
  const WEB = { id: "web", name: "Web search", type: "boolean", currentValue: false };
  const THOUGHT = {
    id: "thought",
    name: "Thinking",
    type: "select",
    currentValue: "low",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
    ],
  };
  /** Each opens its session, then answers the pick to make on it. */
  const cases: [string, () => () => Promise<unknown>][] = [
    [
      "a mode the agent did not advertise",
      () => {
        open("codex", {
          acpCurrentMode: "auto",
          acpAvailableModes: [{ id: "auto", name: "Auto" }],
        });
        return () => configuration.pick(TAB, KNOBS.acpMode, "yolo");
      },
    ],
    [
      "Claude's permission mode, on another agent's session",
      () => {
        open("codex");
        return () => configuration.pick(TAB, KNOBS.claudeMode, "bypassPermissions");
      },
    ],
    [
      "the effort level, on a session that is not the native agent's",
      () => {
        open("codex");
        return () => configuration.pick(TAB, KNOBS.effort, "high");
      },
    ],
    [
      "an empty model id",
      () => {
        open("codex", { acpCurrentModel: "sonnet" });
        return () => configuration.pick(TAB, KNOBS.model, "");
      },
    ],
    [
      "an option the agent did not advertise",
      () => {
        open("codex", { acpConfigOptions: [WEB] });
        return () => configuration.pick(TAB, KNOBS.option("verbosity"), "high");
      },
    ],
    [
      "a value an advertised option does not take",
      () => {
        open("codex", { acpConfigOptions: [THOUGHT] });
        return () => configuration.pick(TAB, KNOBS.option("thought"), "max");
      },
    ],
    [
      "a value of the wrong kind for an advertised option",
      () => {
        open("codex", { acpConfigOptions: [WEB] });
        return () => configuration.pick(TAB, KNOBS.option("web"), "yes");
      },
    ],
  ];

  it.each(cases)(
    "%s: refused, with nothing shown, pushed or remembered",
    async (_name, arrange) => {
      const pick = arrange();
      const before = structuredClone(session());

      expect(await pick()).toBe("refused");

      expect(session()).toEqual(before);
      expect(pushes).toEqual([]);
      expect(prefs).toEqual({ modes: {}, options: [] });
      expect(refusals).toEqual([]);
    },
  );

  it("a mode is taken on trust while the agent has advertised none yet", async () => {
    open("codex", { acpAvailableModes: [] });
    expect(await configuration.pick(TAB, KNOBS.acpMode, "read-only")).toBe("applied");
  });
});

describe("what is remembered", () => {
  it("is the pick the agent took last, whichever answer came back first", async () => {
    open("codex", { acpCurrentMode: "auto" });
    const outs = [held(), held()];
    answer = () => outs[pushes.length - 1]!.promise;

    const first = configuration.pick(TAB, KNOBS.acpMode, "read-only");
    const second = configuration.pick(TAB, KNOBS.acpMode, "full-access");
    outs[1]!.resolve();
    await second;
    outs[0]!.resolve();
    await first;

    expect(prefs.modes).toEqual({ codex: "full-access" });
  });

  it("is not a pick the agent refused", async () => {
    open("atlas-agent", { nativeEffort: "low" });
    answer = async () => {
      throw "no";
    };

    await configuration.pick(TAB, KNOBS.effort, "high");

    expect(prefs.effort).toBeUndefined();
    expect(session().nativeEffort).toBe("low");
    expect(refusals).toEqual(["no"]);
  });
});

describe("settleMode: a session that has just been opened", () => {
  const MODES = [
    { id: "read-only", name: "Read only" },
    { id: "auto", name: "Auto" },
  ];
  const reported = (current_mode: string | null, available_modes = MODES) => ({
    current_mode,
    available_modes,
  });

  it("is put on the pick, once, when the agent is somewhere else", async () => {
    expect(await configuration.settleMode(KEY, "read-only", reported("auto"))).toEqual({
      effective: "read-only",
      honoured: true,
    });
    expect(pushes).toEqual([{ cmd: "setMode", value: "read-only" }]);
  });

  it("is left alone when the agent is already on the pick", async () => {
    expect(await configuration.settleMode(KEY, "auto", reported("auto"))).toEqual({
      effective: "auto",
      honoured: true,
    });
    expect(pushes).toEqual([]);
  });

  it("stays in the agent's mode when nothing was picked", async () => {
    expect(await configuration.settleMode(KEY, undefined, reported("auto"))).toEqual({
      effective: "auto",
      honoured: false,
    });
    expect(pushes).toEqual([]);
  });

  it("skips a pick the agent no longer advertises, without asking", async () => {
    expect(await configuration.settleMode(KEY, "yolo", reported("auto"))).toEqual({
      effective: "auto",
      honoured: false,
    });
    expect(pushes).toEqual([]);
  });

  it("answers the agent's mode when the agent refuses the pick, and tells nobody", async () => {
    answer = async () => {
      throw "busy";
    };
    expect(await configuration.settleMode(KEY, "read-only", reported("auto"))).toEqual({
      effective: "auto",
      honoured: false,
    });
    expect(refusals).toEqual([]);
  });

  // #36: pushing it was refused, and a resume then held every send over a
  // mode the session could never be put in.
  it("pushes nothing to a session that advertises no modes, and holds nothing back", async () => {
    expect(await configuration.settleMode(KEY, "read-only", reported(null, []))).toEqual({
      effective: null,
      honoured: true,
    });
    expect(pushes).toEqual([]);
  });

  it("asks nothing of a session with no modes when nothing was picked", async () => {
    expect(await configuration.settleMode(KEY, undefined, reported(null, []))).toEqual({
      effective: null,
      honoured: false,
    });
    expect(pushes).toEqual([]);
  });
});

describe("reapplyRememberedOptions: a session that has just advertised its options", () => {
  const select = (id: string, currentValue: string, values: string[]) => ({
    id,
    name: id,
    type: "select",
    currentValue,
    options: values.map((value) => ({ value, name: value })),
  });
  const ADVERTISED = [
    select("thought", "low", ["low", "high"]),
    select("verbosity", "terse", ["terse", "chatty"]),
    { id: "web", name: "Web search", type: "boolean", currentValue: true },
  ];
  /** How often the session was asked for its option list. */
  let reads = 0;
  const advertised = async () => {
    reads += 1;
    return ADVERTISED;
  };
  beforeEach(() => {
    reads = 0;
  });

  it("pushes each remembered pick once, and nothing the session does not take", async () => {
    remembered.codex = {
      thought: "high",
      // Already there.
      web: true,
      // A value this agent no longer offers.
      verbosity: "poetic",
      // An option this agent no longer advertises.
      sandbox: "strict",
    };

    await configuration.reapplyRememberedOptions("codex", KEY, advertised, () => false);

    expect(pushes).toEqual([{ cmd: "setConfigOption", configId: "thought", value: "high" }]);
    expect(prefs.options, "re-applying is not a pick").toEqual([]);
  });

  it("carries on past a refusal, quietly", async () => {
    remembered.codex = { thought: "high", verbosity: "chatty" };
    answer = async (push) => {
      if (push.configId === "thought") throw "no";
    };

    await configuration.reapplyRememberedOptions("codex", KEY, advertised, () => false);

    expect(pushes.map((push) => push.configId)).toEqual(["thought", "verbosity"]);
    expect(refusals).toEqual([]);
  });

  it("stops once the tab has moved to another session", async () => {
    remembered.codex = { thought: "high", verbosity: "chatty" };

    // Moved after the first push went out.
    await configuration.reapplyRememberedOptions("codex", KEY, advertised, () => pushes.length > 0);

    expect(pushes).toHaveLength(1);
  });

  it("pushes nothing when the tab moved while the options were being read", async () => {
    remembered.codex = { thought: "high" };
    await configuration.reapplyRememberedOptions("codex", KEY, advertised, () => true);
    expect(pushes).toEqual([]);
  });

  it("pushes nothing for an agent with nothing remembered, and does not read its options", async () => {
    await configuration.reapplyRememberedOptions("codex", KEY, advertised, () => false);
    expect(pushes).toEqual([]);
    expect(reads).toBe(0);
  });

  it("re-applies nothing, quietly, when the options cannot be read", async () => {
    remembered.codex = { thought: "high" };
    await configuration.reapplyRememberedOptions(
      "codex",
      KEY,
      async () => {
        throw "busy";
      },
      () => false,
    );
    expect(pushes).toEqual([]);
    expect(refusals).toEqual([]);
  });
});

describe("reapply", () => {
  it("pushes the value a bound session holds, and remembers nothing", async () => {
    open("atlas-agent", { nativeEffort: "high" });

    await configuration.reapply(TAB, KNOBS.effort, "high");

    expect(pushes).toEqual([{ cmd: "setEffort", value: "high" }]);
    expect(prefs.effort).toBeUndefined();
  });

  it("seeds the composer of a session that is not bound yet, and pushes nothing", async () => {
    open("atlas-agent", {}, false);

    await configuration.reapply(TAB, KNOBS.effort, "medium");

    expect(session().nativeEffort).toBe("medium");
    expect(pushes).toEqual([]);
  });

  it("only logs a refusal: the user picked nothing just now", async () => {
    open("atlas-agent", { nativeEffort: "high" });
    answer = async () => {
      throw "no";
    };

    await configuration.reapply(TAB, KNOBS.effort, "high");

    expect(refusals).toEqual([]);
    expect(session().nativeEffort).toBe("high");
  });

  it("does nothing on a session that does not offer the knob", async () => {
    open("codex");
    await configuration.reapply(TAB, KNOBS.effort, "high");
    expect(pushes).toEqual([]);
    expect(session().nativeEffort).toBeUndefined();
  });
});

describe("what a knob decides", () => {
  it("a mode pick is the user's: it is marked explicit and releases a held resume", async () => {
    open("codex", { acpCurrentMode: "auto", unrestoredModeId: "read-only" });
    await configuration.pick(TAB, KNOBS.acpMode, "auto");
    expect(session()).toMatchObject({ acpModeExplicit: true, unrestoredModeId: undefined });

    open("claude-code", { claudePermissionMode: "default", unrestoredModeId: "plan" });
    await configuration.pick(TAB, KNOBS.claudeMode, "plan");
    expect(session()).toMatchObject({
      claudePermissionMode: "plan",
      claudePermissionModeExplicit: true,
      unrestoredModeId: undefined,
    });
  });

  // #56: the hold was released when the pick was SHOWN, and a refusal only
  // put the pill back, so a refused pick let sends through in the agent's own
  // mode, the one the hold was there to stop.
  it("a refused mode pick keeps a held resume held", async () => {
    answer = async () => {
      throw "busy";
    };
    open("codex", {
      acpCurrentMode: "auto",
      acpAvailableModes: [
        { id: "auto", name: "Auto" },
        { id: "read-only", name: "Read only" },
      ],
      unrestoredModeId: "read-only",
    });
    expect(await configuration.pick(TAB, KNOBS.acpMode, "read-only")).toBe("refused");
    expect(session()).toMatchObject({ acpCurrentMode: "auto", unrestoredModeId: "read-only" });

    open("claude-code", { claudePermissionMode: "default", unrestoredModeId: "plan" });
    expect(await configuration.pick(TAB, KNOBS.claudeMode, "plan")).toBe("refused");
    expect(session()).toMatchObject({ claudePermissionMode: "default", unrestoredModeId: "plan" });
  });

  it("a held resume is released while the pick is out only once the agent takes it", async () => {
    const out = held();
    answer = () => out.promise;
    open("codex", { acpCurrentMode: "auto", unrestoredModeId: "read-only" });

    const outcome = configuration.pick(TAB, KNOBS.acpMode, "read-only");
    expect(session().unrestoredModeId).toBe("read-only");
    out.resolve();
    await outcome;
    expect(session().unrestoredModeId).toBeUndefined();
  });

  it("a mode picked before the bind releases a held resume: the bind applies it", async () => {
    open("codex", { unrestoredModeId: "read-only" }, false);
    expect(await configuration.pick(TAB, KNOBS.acpMode, "read-only")).toBe("kept-for-bind");
    expect(session().unrestoredModeId).toBeUndefined();
  });

  it("picking Claude's `default` forgets the remembered mode rather than storing it", async () => {
    open("claude-code", { claudePermissionMode: "default" });
    await configuration.pick(TAB, KNOBS.claudeMode, "bypassPermissions");
    expect(prefs.modes).toEqual({ "claude-code": "bypassPermissions" });

    await configuration.pick(TAB, KNOBS.claudeMode, "default");
    expect(prefs.modes).toEqual({ "claude-code": null });
  });

  it("a plan approval's mode is the session's, not the user's: nothing is remembered", async () => {
    open("claude-code", { claudePermissionMode: "plan" });

    expect(await configuration.pick(TAB, KNOBS.planExitMode, "acceptEdits")).toBe("applied");

    expect(pushes).toEqual([{ cmd: "setMode", value: "acceptEdits" }]);
    expect(session()).toMatchObject({
      claudePermissionMode: "acceptEdits",
      acpCurrentMode: "acceptEdits",
    });
    expect(session().claudePermissionModeExplicit).toBeUndefined();
    expect(prefs.modes).toEqual({});
  });

  it("the model is not remembered", async () => {
    open("codex");
    await configuration.pick(TAB, KNOBS.model, "opus");
    expect(prefs).toEqual({ modes: {}, options: [] });
  });

  it("the effort is remembered once, whatever the agent", async () => {
    open("atlas-agent");
    await configuration.pick(TAB, KNOBS.effort, "high");
    expect(pushes).toEqual([{ cmd: "setEffort", value: "high" }]);
    expect(prefs.effort).toBe("high");
  });

  it("an option shows nothing until the agent answers, and is remembered per agent", async () => {
    const advertised = [{ id: "web", name: "Web search", type: "boolean", currentValue: false }];
    open("codex", { acpConfigOptions: advertised });

    expect(await configuration.pick(TAB, KNOBS.option("web"), true)).toBe("applied");

    expect(pushes).toEqual([{ cmd: "setConfigOption", configId: "web", value: true }]);
    expect(session().acpConfigOptions).toBe(advertised);
    expect(prefs.options).toEqual([["codex", "web", true]]);
  });

  it("an option cannot be picked before the session has advertised it", async () => {
    open("codex", {}, false);
    expect(await configuration.pick(TAB, KNOBS.option("web"), true)).toBe("refused");
    expect(pushes).toEqual([]);
    expect(prefs.options).toEqual([]);
  });
});
