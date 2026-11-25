/**
 * Setting a session's configuration: its permission mode, its model, its
 * reasoning effort and whatever options its agent advertises.
 *
 * Every one of them is the same sequence, so it is written once (`pick`):
 * show the pick in the composer, push it to the agent, take it back and say
 * why if the agent refuses, remember it for the next session. What differs
 * between them is a `Knob`: where the composer reads it, which command pushes
 * it, how it is remembered, and what a pick means before there is a session.
 *
 * Rust holds the agent's actual configuration. What is written here is the
 * composer's mirror of it, and the agent's own reports (`mode_changed`,
 * `model_changed`, `config_options_updated`) overwrite the mirror through the
 * store's delta fold, which pushes nothing back.
 *
 * Capability is discovered (ADR-0002): a knob is offered because the session
 * advertises it. The two exceptions are stated on their knobs.
 *
 * Everything a test needs is a parameter (`SessionConfigurationDeps`). The app
 * has one instance, made beside the chat store it writes to
 * (`sessionConfiguration` in `stores/chat-store.ts`), so that the store's
 * actions can call it without this file importing the store.
 */
import type { ChatSession, ClaudePermissionMode } from "@/types/agent";
import type { SessionKey, SessionModeInfo } from "@/types/agents";
import { modelSelectOf, parseConfigOptions } from "./acp-config-options";
import { saveCachedAcpConfigOptions } from "./acp-config-options-cache";
import { saveCachedAcpModels } from "./acp-models-cache";
import type { agents } from "./agents-api";
import { configOptionPushes, type ConfigOptionPrefs } from "./config-option-prefs";

/** What setting a knob asks of the agents backend (`agents-api.ts`). */
export type ConfigurationAgentsPort = Pick<
  typeof agents,
  "setMode" | "setModel" | "setEffort" | "setConfigOption"
>;

/** Where a pick is remembered for the next session. */
export interface ConfigurationPrefs {
  /** The last mode picked for an agent; `null` forgets it. */
  saveMode: (agentType: string, mode: string | null) => void;
  /** The last reasoning effort picked. One value, whatever the agent. */
  saveEffort: (effort: string) => void;
  /** The last value picked for one of an agent's options. */
  saveOption: (agentType: string, configId: string, value: boolean | string) => void;
  /** Every option value remembered for an agent. */
  loadOptions: (agentType: string) => ConfigOptionPrefs;
}

/** One thing about a session the user can set. */
export interface Knob<V> {
  /** What it is called in a log line. */
  name: string;
  /**
   * Where the composer reads it, when it shows a pick before the agent has
   * answered. Absent for a knob whose only word is the agent's (`option`).
   */
  mirror?: {
    read: (session: ChatSession) => V | undefined;
    /** The user picked `value`. */
    pick: (session: ChatSession, value: V) => void;
    /** The agent refused the pick: back to `value`, the last one it holds
     *  (`undefined` when it held none the composer knew of). */
    restore: (session: ChatSession, value: V | undefined) => void;
  };
  /**
   * What a pick settles beyond its value, once the agent has taken it (or the
   * bind will apply it). A mode pick releases the send hold a failed resume
   * put up (`unrestoredModeId`): only once the agent is actually on a mode the
   * user chose, so a refused pick leaves the hold where it was.
   */
  taken?: (session: ChatSession) => void;
  /** Does this session offer the knob, and this value of it? A pick it does
   *  not offer is refused before anything is shown. */
  offers: (session: ChatSession, value: V) => boolean;
  push: (agents: ConfigurationAgentsPort, key: SessionKey, value: V) => Promise<void>;
  /** How a pick is remembered, once the agent has taken it or the bind has it
   *  to apply. Absent: it is not (`model`). */
  remember?: (prefs: ConfigurationPrefs, session: ChatSession, value: V) => void;
  /**
   * A pick made before the session is bound. `kept-for-bind`: shown and
   * remembered, and the bind puts the agent on it before the first prompt.
   * `refused`: nothing happens, because the knob only exists once the session
   * has advertised it.
   */
  unbound: "kept-for-bind" | "refused";
}

/** The user is on a mode they chose: a send hold a resume put up is over. */
function releaseModeHold(session: ChatSession): void {
  session.unrestoredModeId = undefined;
}

/**
 * Is this session on Atlas's own permission-mode record
 * (`claudePermissionMode`, the `CLAUDE_PERMISSION_MODES` list) rather than the
 * modes its agent advertises (`acpCurrentMode`)? Read off the session — the
 * record is there or it is not — so no branch downstream names an agent
 * (ADR-0002). Which sessions start on it is decided once, when the tab is
 * given its agent (`startsOnClaudeModeList`).
 */
export function onClaudeModeList(
  session: Pick<ChatSession, "claudePermissionMode"> | undefined,
): boolean {
  return session?.claudePermissionMode !== undefined;
}

/**
 * The one place an agent type decides which mode record a tab starts on. It
 * is the legacy native Claude type only (`claude-code`, spawned from
 * `claude-code-ts`), which predates ACP mode advertisement; every installable
 * agent, the registry's Claude (`claude-acp`) included, advertises its modes
 * and so starts on the advertised record. Everything else asks the session
 * (`onClaudeModeList`).
 */
export function startsOnClaudeModeList(agentType: string | undefined): boolean {
  return agentType === "claude-code";
}

/**
 * Atlas's own permission-mode record (`onClaudeModeList`). The list is
 * Atlas's (`CLAUDE_PERMISSION_MODES`), not one the agent advertises, so the
 * knob is offered to a session that holds that record.
 */
const claudeMode: Knob<ClaudePermissionMode> = {
  name: "permission mode",
  mirror: {
    read: (session) => session.claudePermissionMode ?? "default",
    pick: (session, mode) => {
      session.claudePermissionMode = mode;
      session.claudePermissionModeExplicit = true;
    },
    restore: (session, mode) => {
      session.claudePermissionMode = mode ?? "default";
    },
  },
  taken: releaseModeHold,
  offers: (session) => onClaudeModeList(session),
  push: (agents, key, mode) => agents.setMode(key, mode),
  // "default" means "defer to the CLI's own configured default": picking it
  // drops the remembered pick rather than storing it.
  remember: (prefs, session, mode) => {
    if (session.agentType) prefs.saveMode(session.agentType, mode === "default" ? null : mode);
  },
  unbound: "kept-for-bind",
};

/**
 * The mode a plan approval selected. A decision about this session, so it is
 * not the user's pick: nothing is remembered and the explicit flag is left
 * alone.
 *
 * Offered by the session's shape, not its agent (ADR-0002, ACP audit finding
 * 45): the approval prompt's option ids name the mode
 * (`exitPlanModeForOption`), and the session takes it when it is on Atlas's
 * own record, or when its agent advertises that mode (or nothing yet, taken
 * at its word as `acpMode` is). The registry's Claude (`claude-acp`) is on
 * the advertised record, and was the agent this used to skip.
 */
const planExitMode: Knob<ClaudePermissionMode> = {
  // The same name as `claudeMode`: they write the same pill, so their pushes
  // are one sequence (see `Flight`).
  name: claudeMode.name,
  mirror: {
    read: (session) =>
      onClaudeModeList(session)
        ? session.claudePermissionMode
        : (session.acpCurrentMode as ClaudePermissionMode | undefined),
    pick: (session, mode) => {
      if (onClaudeModeList(session)) session.claudePermissionMode = mode;
      session.acpCurrentMode = mode;
    },
    restore: (session, mode) => {
      if (onClaudeModeList(session)) session.claudePermissionMode = mode ?? "default";
      else session.acpCurrentMode = mode;
    },
  },
  offers: (session, mode) => onClaudeModeList(session) || acpMode.offers(session, mode),
  push: claudeMode.push,
  unbound: "kept-for-bind",
};

/** A mode the agent advertises (`acpAvailableModes`). Remembered per agent. */
const acpMode: Knob<string> = {
  name: "mode",
  mirror: {
    read: (session) => session.acpCurrentMode,
    pick: (session, mode) => {
      session.acpCurrentMode = mode;
      session.acpModeExplicit = true;
    },
    restore: (session, mode) => {
      session.acpCurrentMode = mode;
    },
  },
  taken: releaseModeHold,
  // An id the agent did not advertise is rejected (`invalidParams`). An agent
  // that has advertised nothing yet is taken at its word.
  offers: (session, mode) => {
    const modes = session.acpAvailableModes ?? [];
    return !!mode && (modes.length === 0 || modes.some((m) => m.id === mode));
  },
  push: (agents, key, mode) => agents.setMode(key, mode),
  // Claude's modes have their own record, written by `claudeMode`.
  remember: (prefs, session, mode) => {
    if (session.agentType && !onClaudeModeList(session)) {
      prefs.saveMode(session.agentType, mode);
    }
  },
  unbound: "kept-for-bind",
};

/**
 * The model. Not remembered: a new session starts on the agent's own default.
 * Not checked against the advertised list either, which a tab that has just
 * switched agent does not have yet; the agent refuses an id it does not know.
 */
const model: Knob<string> = {
  name: "model",
  mirror: {
    read: (session) => session.acpCurrentModel,
    pick: (session, id) => {
      session.acpCurrentModel = id;
    },
    restore: (session, id) => {
      session.acpCurrentModel = id;
    },
  },
  offers: (_session, id) => !!id,
  push: (agents, key, id) => agents.setModel(key, id),
  unbound: "kept-for-bind",
};

/**
 * The native agent's reasoning effort. Offered by agent id, like the pill that
 * sets it: the engine does not advertise it as an option. Remembered once for
 * the app, not per agent.
 */
const effort: Knob<string> = {
  name: "reasoning effort",
  mirror: {
    read: (session) => session.nativeEffort,
    pick: (session, level) => {
      session.nativeEffort = level;
    },
    restore: (session, level) => {
      session.nativeEffort = level;
    },
  },
  offers: (session) => session.agentType === "atlas-agent",
  push: (agents, key, level) => agents.setEffort(key, level),
  remember: (prefs, _session, level) => prefs.saveEffort(level),
  unbound: "kept-for-bind",
};

/**
 * An option the agent advertises (`acpConfigOptions`). Nothing is shown until
 * the agent answers: its answer to the set is the confirmed list, which
 * arrives as a `config_options_updated` delta, so guessing in between would
 * only flicker the control when the agent disagrees.
 */
function option(configId: string): Knob<boolean | string> {
  return {
    name: `option "${configId}"`,
    // Only an option this session advertises, and only a value it takes.
    offers: (session, value) => {
      const knob = parseConfigOptions(session.acpConfigOptions).find((o) => o.id === configId);
      if (!knob) return false;
      if (knob.kind === "boolean") return typeof value === "boolean";
      return typeof value === "string" && knob.choices.some((choice) => choice.id === value);
    },
    push: (agents, key, value) => agents.setConfigOption(key, configId, value),
    remember: (prefs, session, value) => {
      if (session.agentType) prefs.saveOption(session.agentType, configId, value);
    },
    unbound: "refused",
  };
}

/**
 * The mode a session should actually end up in.
 *
 * `requested` is the user's explicit pick, or undefined when they never made
 * one. A pick the agent does not advertise is dropped in favour of whatever
 * the agent reports, because sending it would be rejected and would leave the
 * picker stuck on a mode id that does not exist. So is a pick for a session
 * that advertises no modes at all: it has no mode to be put in, and a
 * `session/set_mode` would only be refused.
 */
export function resolveEffectiveMode(
  requested: string | undefined,
  currentMode: string | null,
  availableModes: readonly SessionModeInfo[],
): string | null {
  if (!requested) return currentMode;
  return availableModes.some((m) => m.id === requested) ? requested : currentMode;
}

export const KNOBS = { claudeMode, planExitMode, acpMode, model, effort, option };

/** The option list an agent reported for one of its sessions. */
export interface AdvertisedOptions {
  agentType: string;
  configOptions: unknown[];
}

/**
 * Keep what an agent reported for the next launch, so its pills are there
 * before its first session answers (#36). An empty list is kept too: a live
 * session saying "no knobs" is an answer, and remembering it is what stops the
 * next cold start from spinning to re-learn it. The model list rides on the
 * same blob (`modelSelectOf`), so it is cached from here as well.
 *
 * The store's delta fold only mirrors the report; the action that ran the fold
 * calls this afterwards.
 */
export function cacheAdvertisedOptions({ agentType, configOptions }: AdvertisedOptions): void {
  saveCachedAcpConfigOptions(agentType, configOptions);
  const models = modelSelectOf(configOptions);
  if (models) saveCachedAcpModels(agentType, { availableModels: models.availableModels });
}

/**
 * `applied`: the agent took it. `kept-for-bind`: there is no session yet, the
 * bind will apply it. `refused`: the session does not offer it, or the agent
 * said no.
 */
export type PickOutcome = "applied" | "kept-for-bind" | "refused";

export interface SessionConfigurationDeps {
  agents: ConfigurationAgentsPort;
  /** The chat store's sessions: read one, or write to one's mirror. */
  sessions: {
    get: (tabId: string) => ChatSession | undefined;
    update: (tabId: string, recipe: (session: ChatSession) => void) => void;
  };
  prefs: ConfigurationPrefs;
  /** Where a refusal is said, in the agent's words. */
  report: { refused: (message: string) => void };
}

/** What an agent said about a session's modes on `session/new` or
 *  `session/load`. */
export interface ReportedModes {
  current_mode: string | null;
  available_modes: readonly SessionModeInfo[];
}

/** The mode an opened session is in, and whether it is the one asked for. */
export interface SettledMode {
  effective: string | null;
  /**
   * The pick holds: the session is on it, or it offers no modes, so there is
   * no mode it could be on instead and nothing for a resume to hold sends
   * over. False when nothing was asked for.
   */
  honoured: boolean;
}

export interface SessionConfiguration {
  /** The user picked `value` for `knob` on `tabId`'s session. The composer
   *  shows it before this returns; the answer says how it ended. */
  pick<V>(tabId: string, knob: Knob<V>, value: V): Promise<PickOutcome>;
  /**
   * Put a session that has just been opened (new or resumed) in the mode asked
   * for it, before the composer shows anything. `reported` is what the agent
   * said on `session/new` or `session/load`.
   *
   * Answers the mode the session is in, and whether that is the one asked
   * for: a pick the agent does not advertise, or refuses, leaves the session
   * in the agent's own mode, and the caller shows that.
   */
  settleMode(
    key: SessionKey,
    requested: string | undefined,
    reported: ReportedModes,
  ): Promise<SettledMode>;
  /**
   * Push a value to a session by its key, with no composer involved: the
   * bind's, for a session it has not exposed yet. A refusal is only logged.
   * Answers whether the agent took it.
   */
  apply<V>(key: SessionKey, knob: Knob<V>, value: V): Promise<boolean>;
  /**
   * Re-apply the option picks remembered for `agentType` to a session that
   * has just been opened: only options it advertises, only values it takes,
   * nothing where it already sits there (`configOptionPushes`). Stops early
   * when `stop` says the tab has moved on.
   *
   * `advertised` reads the session's option list, and is only asked when
   * something is remembered for the agent: the bind calls this before it
   * exposes the session, so that read is a round trip a first prompt waits
   * on. A list that cannot be read re-applies nothing, quietly.
   *
   * Each push is answered with the confirmed list as a delta. The composer
   * only follows it for a session its tab is bound to; the bind's caller
   * reads the list again once it is.
   */
  reapplyRememberedOptions(
    agentType: string,
    key: SessionKey,
    advertised: () => Promise<unknown>,
    stop: () => boolean,
  ): Promise<void>;
  /**
   * Put the agent back on a value the tab already holds, once its session is
   * bound. Not a pick: nothing is remembered, the user's flags are left alone,
   * and a refusal is only logged, as the bind's own pushes are.
   */
  reapply<V>(tabId: string, knob: Knob<V>, value: V): Promise<void>;
  /** Forget what is in flight. For tests that share the app's instance. */
  reset(): void;
}

const keyOf = (session: ChatSession): SessionKey | null =>
  session.acpAgentId && session.acpSessionId
    ? { agent_id: session.acpAgentId, session_id: session.acpSessionId }
    : null;

/**
 * The picks of one knob on one tab that the agent has not answered yet.
 *
 * A refusal has to put the composer back on what the agent HOLDS, and with
 * two picks out that is not "what showed before this pick": the pick before
 * may itself be refused. So the value is taken once, when the first pick goes
 * out (nothing was in flight, the composer showed the agent's), and moves only
 * when the agent accepts one.
 */
interface Flight {
  /** The latest pick's number. Only that pick's refusal touches the composer. */
  latest: number;
  /** Pushes not yet answered. At zero the entry is dropped. */
  out: number;
  /** What the agent holds, and the pick that put it there (0: none of these). */
  held: unknown;
  heldBy: number;
}

export function createSessionConfiguration(deps: SessionConfigurationDeps): SessionConfiguration {
  const flights = new Map<string, Flight>();

  async function pick<V>(tabId: string, knob: Knob<V>, value: V): Promise<PickOutcome> {
    const session = deps.sessions.get(tabId);
    if (!session) return "refused";
    // Not offered, not picked: nothing is shown, pushed or remembered. The
    // composer only lists what the session offers, so this is the guard for
    // every other caller (a shortcut, a programmatic pick, a stale menu).
    if (!knob.offers(session, value)) return "refused";
    const key = keyOf(session);
    if (!key && knob.unbound === "refused") return "refused";

    const { mirror } = knob;
    const shown = mirror?.read(session);
    if (mirror) deps.sessions.update(tabId, (s) => mirror.pick(s, value));
    const { taken } = knob;
    if (!key) {
      knob.remember?.(deps.prefs, session, value);
      if (taken) deps.sessions.update(tabId, taken);
      return "kept-for-bind";
    }

    const flightKey = `${tabId}\u0000${knob.name}`;
    const flight = flights.get(flightKey) ?? { latest: 0, out: 0, held: shown, heldBy: 0 };
    flights.set(flightKey, flight);
    const mine = ++flight.latest;
    flight.out += 1;
    try {
      await knob.push(deps.agents, key, value);
      // Whichever pick the agent took, it is on one the user chose.
      if (taken) deps.sessions.update(tabId, taken);
      // Pushes reach the agent in order, so the latest accepted one is what
      // it holds, whichever answer came back first.
      if (mine > flight.heldBy) {
        flight.held = value;
        flight.heldBy = mine;
        // Remembered only now: a pick the agent refused would otherwise be
        // where the next session starts.
        knob.remember?.(deps.prefs, session, value);
      }
      return "applied";
    } catch (err) {
      console.warn(`setting the ${knob.name} failed:`, err);
      // The pick is already showing. Leaving it there is the composer lying:
      // the native agent refuses a mid-turn mode switch precisely because the
      // running turn keeps the permissions it started with (#61). Roll it
      // back and say why, unless something newer is showing: a later pick, or
      // a change the agent reported.
      if (mirror && mine === flight.latest) {
        const held = flight.held as V | undefined;
        deps.sessions.update(tabId, (s) => {
          if (Object.is(mirror.read(s), value)) mirror.restore(s, held);
        });
      }
      deps.report.refused(typeof err === "string" ? err : String(err));
      return "refused";
    } finally {
      flight.out -= 1;
      if (flight.out === 0 && flights.get(flightKey) === flight) flights.delete(flightKey);
    }
  }

  async function settleMode(
    key: SessionKey,
    requested: string | undefined,
    reported: ReportedModes,
  ): Promise<SettledMode> {
    const effective = resolveEffectiveMode(
      requested,
      reported.current_mode,
      reported.available_modes,
    );
    // A session with no modes has none to put the pick in, and none more
    // permissive than it either: nothing is pushed, and nothing is held.
    if (reported.available_modes.length === 0) {
      return { effective: reported.current_mode, honoured: !!requested };
    }
    const honoured = !!requested && effective === requested;
    if (!effective || effective === reported.current_mode) return { effective, honoured };
    try {
      await deps.agents.setMode(key, effective);
      return { effective, honoured };
    } catch (err) {
      // The agent is the authority. If it would not take the mode, the picker
      // has to show what the agent has rather than what we wanted it to have.
      console.warn("setting the mode of an opened session failed:", err);
      return { effective: reported.current_mode, honoured: false };
    }
  }

  async function apply<V>(key: SessionKey, knob: Knob<V>, value: V): Promise<boolean> {
    try {
      await knob.push(deps.agents, key, value);
      return true;
    } catch (err) {
      console.warn(`applying the ${knob.name} failed:`, err);
      return false;
    }
  }

  async function reapplyRememberedOptions(
    agentType: string,
    key: SessionKey,
    advertised: () => Promise<unknown>,
    stop: () => boolean,
  ): Promise<void> {
    const remembered = deps.prefs.loadOptions(agentType);
    if (Object.keys(remembered).length === 0) return;
    let options: unknown;
    try {
      options = await advertised();
    } catch (err) {
      console.warn("reading the options to re-apply the remembered picks failed:", err);
      return;
    }
    if (stop()) return;
    for (const push of configOptionPushes(options, remembered)) {
      await apply(key, option(push.configId), push.value);
      if (stop()) return;
    }
  }

  async function reapply<V>(tabId: string, knob: Knob<V>, value: V): Promise<void> {
    const session = deps.sessions.get(tabId);
    if (!session || !knob.offers(session, value)) return;
    const { mirror } = knob;
    if (mirror) deps.sessions.update(tabId, (s) => mirror.restore(s, value));
    const key = keyOf(session);
    if (key) await apply(key, knob, value);
  }

  return {
    pick,
    settleMode,
    apply,
    reapplyRememberedOptions,
    reapply,
    reset() {
      flights.clear();
    },
  };
}
