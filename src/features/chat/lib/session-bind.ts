/**
 * Binding a NEW session to a tab: connect the tab's agent, `session/new`, put
 * the agent in the mode and model the tab picked, and only then expose the
 * binding (which is what releases a held first message).
 *
 * The panel's hook (`hooks/use-agent-bind.ts`) is a thin caller: it attaches
 * while its tab has no session, warms (connects the agent, no session) once
 * the tab is on screen, kicks once the user writes or sends, and detaches.
 * Everything a test needs is a parameter (`SessionBindDeps`).
 *
 * What a tab+agent pair has already been through (a failure reported, the one
 * silent retry spent, sign-in offered) outlives any one mount of the panel, so
 * it lives in the instance `createSessionBind` returns, for as long as that
 * instance does: the app has one (`sessionBind`), a test makes its own or
 * resets the app's.
 *
 * This is one of four ways a session reaches a tab. The other three put an
 * EXISTING session back and do not come through here: `openThread`
 * (`open-thread.ts`), `openAgentSession` (`open-agent-session.ts`) and
 * `rebindDisconnectedSession` (`agent-rebind.ts`). They differ in what they
 * hydrate; `session-resume.test.ts` holds the table. A tab saved with a
 * conversation gets it back through `openThread`'s own load
 * (`restore-tab-session.ts`), so it is not a fifth.
 */
import { toast } from "sonner";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { useAppStore } from "@/features/app/stores/app-store";
import { logEvent } from "@/features/log/lib/log";
import { notifyAgentSignInRequired } from "@/features/notifications/lib/agent-notifier";
import type { AgentInfo } from "@/types/acp";
import { agentTypeFromPluginId, isClaudePermissionMode, pluginIdForAgent } from "@/types/agent";
import { sessionConfiguration, useChatStore } from "../stores/chat-store";
import { bindFailureAction, errInfo, promptSignIn } from "./agent-signin";
import { promptAtlasSignIn } from "./atlas-sign-in-prompt";
import { agents, ensureAgent, resetAgent } from "./agents-api";
import { KNOBS, onClaudeModeList, type SessionConfiguration } from "./session-configuration";
import { projectPathForTab } from "./tab-project";
import { isDeadlineError, progressSince, withDeadline } from "./with-deadline";

/** How long after a first failure the one silent retry runs. */
const BIND_RETRY_MS = 1500;

/** How long a bind hop (connect, `session/new`) may stay silent before it is
 *  noted as stalled. The soft notice only: the transcript's working indicator
 *  carries its own 30 s clock and shows the persistent Restart / Switch
 *  affordance (`StallNotice`); this just puts the stall in the log. */
const BIND_STALL_MS = 30_000;

/** How long a bind hop may stay silent before the renderer gives up on it.
 *  A hop that never settles used to leave the panel's closure-local `pending`
 *  flag set forever, which silently disabled every retry path (focus, sign-in,
 *  silent) — the "Starting Codex" that never ends. Generous because a first
 *  run legitimately downloads Node and `npm install`s the adapter; PR 1 of the
 *  stalled-start plan makes that a per-version cost rather than per-launch. */
const BIND_DEADLINE_MS = 3 * 60_000;

/** How long the bind waits on the remembered options before it exposes the
 *  session without them. They are a nicety the first prompt is worth waiting
 *  a moment for, not a hop the start depends on: an agent that never answers
 *  one must not leave the tab starting for ever. */
const REAPPLY_DEADLINE_MS = 5_000;

/** What the bind asks of the agents backend (`agents-api.ts`). */
export type BindAgentsPort = Pick<
  typeof agents,
  "newSession" | "snapshotMeta" | "killPlugin" | "dropSession"
>;

type ChatState = ReturnType<typeof useChatStore.getState>;

export interface SessionBindDeps {
  agents: BindAgentsPort;
  /** Where a session is put on the tab's picks (`session-configuration.ts`). */
  configuration: Pick<SessionConfiguration, "settleMode" | "apply" | "reapplyRememberedOptions">;
  /** Connect the plugin's agent process, or hand back the live one. */
  connect: (pluginId: string) => Promise<AgentInfo>;
  /** Forget the cached agent of a plugin whose connection was just killed. */
  forgetAgent: (pluginId: string) => void;
  /** The chat store, read at an action boundary. */
  chat: () => Pick<ChatState, "sessions" | "queues" | "agentStartingStatus" | "actions">;
  /** The project root a tab lives in: the session's cwd unless the tab was
   *  asked to start somewhere else (`bindCwd`). */
  projectPath: (tabId: string) => string;
  /** What the agent is called in a message to the user. */
  agentLabel: (agentType: string | undefined) => string;
  /** Where a failure is said. */
  report: {
    log: typeof logEvent;
    error: (message: string) => void;
    /** Open the sign-in dialog (`promptSignIn`). */
    signIn: typeof promptSignIn;
    /** The same offer as a banner, for a user who is looking elsewhere. */
    signInBanner: (tabId: string, agentType: string) => void;
    /** Offer Atlas's own sign-in (`promptAtlasSignIn`). */
    atlasSignIn: () => void;
  };
}

/** A panel's handle on its tab's in-flight attempt — see `TabBind.epoch`. */
export interface BindControl {
  /** Restart: abandon the attempt in flight and start a new one, with the
   *  tab+agent's failure history cleared. */
  retry: () => void;
  /** Stop: let go of the attempt in flight, so the next kick binds again. */
  abandon: () => void;
  /** Make sure an attempt is running. */
  kick: () => void;
  /** The tab is on screen. A new chat connects its agent and starts no
   *  session: the session is the user's to start, by writing or sending
   *  (`kick`). A saved conversation is reloaded. */
  warm: () => void;
}

/** One mounted panel's hold on its tab's bind. */
export interface BindAttachment extends BindControl {
  /** The user asked this tab for a session (wrote, or sent) and none is
   *  bound yet. Outlives one attachment, so that a panel attaching again at
   *  once (the tab switched agent mid-start) carries the start on for the
   *  new agent; gone with the tab's last panel, and on Stop. */
  wanted: () => boolean;
  /** The panel is gone, or its tab is bound: whatever the attempt in flight
   *  answers from here on is dropped. */
  detach: () => void;
}

export interface SessionBind {
  /** Hold `tabId`'s bind for one mounted panel. Nothing runs until `kick`. */
  attach(tabId: string): BindAttachment;
  /** Forget every tab+agent's failure history and drop every attempt in
   *  flight. For tests that share the app's instance. */
  reset(): void;
}

/** One tab's bind, for as long as a panel holds it. */
interface TabBind {
  /** Mounted panels attached to the tab. At zero nobody wants the bind. */
  holders: number;
  /** An attempt is in flight. */
  pending: boolean;
  /** Attempt generation. `retry`/`abandon` bump it, which makes the
   *  in-flight attempt stale: its later steps bail, and its `finally` no
   *  longer owns `pending`. That is what lets a Restart start a NEW attempt
   *  while the hung one is still parked on the backend, and what lets Stop
   *  free the tab so the next send binds again. */
  epoch: number;
}

export function createSessionBind(deps: SessionBindDeps): SessionBind {
  /** Tab+agent pairs whose bind failure has already been surfaced, so the
   *  focus-triggered retry doesn't re-toast the same error on every focus.
   *  Cleared for a pair once its bind finally succeeds. */
  const reportedBindFailures = new Set<string>();
  /** Tab+agent keys whose automatic bind has already been retried once after a
   *  failure. The mount-time bind is not something the user did, and its first
   *  failure at boot has a known transient cause: every mounted chat panel
   *  binds at once, and the native engine's in-process start is not reentrant —
   *  a second concurrent start on the same engine home failed with "starting
   *  the in-process app-server runtime", which then surfaced as an error toast
   *  on a launch that was otherwise fine (the manager's connect dedupe, ATL-226,
   *  closes the race itself; this is the belt to that brace). One silent retry
   *  absorbs a transient; a failure that repeats is reported as before. */
  const retriedBinds = new Set<string>();
  /** Tab+agent pairs we have ALREADY walked through sign-in once.
   *
   *  Without this the sign-in flow loops forever: the retry callback clears
   *  `reportedBindFailures` so the rebind can report afresh, so a rebind that
   *  fails on auth AGAIN re-opens the dialog, and completing it retries, and so
   *  on. That is not hypothetical — plenty of registry agents advertise an auth
   *  method that does not actually authenticate them (`autohand`'s only method is
   *  `npm install -g autohand-cli`, which installs a CLI and leaves the agent
   *  still demanding a login). Offering the dialog once and then showing the
   *  agent's own message is the honest end state.
   *
   *  Cleared alongside `reportedBindFailures` when a bind finally succeeds, so a
   *  genuine re-auth later in the session still gets the dialog. */
  const signInAttempted = new Set<string>();
  /** The bind each tab's mounted panels share. Gone with its last panel. */
  const tabs = new Map<string, TabBind>();
  /** Tabs whose user asked for a session that is not bound yet
   *  (`BindAttachment.wanted`). */
  const wanted = new Set<string>();

  /** Await a bind hop, logging once if it stalls. The hop itself is untouched —
   *  the deadline that actually ends it is `withDeadline`. */
  async function watchStall<T>(hop: Promise<T>, label: string, tabId: string): Promise<T> {
    const timer = setTimeout(() => {
      deps.report.log({
        source: "atlas",
        kind: "agent-bind",
        summary: `${label}: bind stalled (no answer after ${BIND_STALL_MS / 1000}s)`,
        status: "failure",
        payload: { tabId },
      });
    }, BIND_STALL_MS);
    try {
      return await hop;
    } finally {
      clearTimeout(timer);
    }
  }

  function attach(tabId: string): BindAttachment {
    // The attempt belongs to the TAB, not to this mount: every panel holding
    // the tab shares one. Each used to keep its own `pending`, so two panels
    // on one tab (the layout has three places that mount a chat panel) each
    // ran `session/new`, and the second binding orphaned the first session.
    const tab: TabBind = tabs.get(tabId) ?? { holders: 0, pending: false, epoch: 0 };
    tabs.set(tabId, tab);
    tab.holders += 1;
    let detached = false;

    const ensureBound = async () => {
      if (tab.holders === 0) return;
      wanted.add(tabId);
      if (tab.pending) return;
      tab.pending = true;
      const myEpoch = ++tab.epoch;
      const stale = () => myEpoch !== tab.epoch;
      /** A session `session/new` made that no tab holds yet. An attempt that
       *  ends before binding it (Stop, Restart, an agent switch mid-bind, a
       *  failure after the create) drops it in `finally`: nothing else knows
       *  it exists, so it would live in the backend until the agent quits
       *  (ACP audit finding 11). */
      let orphan: { agent_id: string; session_id: string } | null = null;
      try {
        // Bind to THIS session's chosen agent (Claude by default, or Codex),
        // not a single global default — so per-tab agents run in parallel.
        const at = deps.chat().sessions[tabId]?.agentType;
        const pluginId = pluginIdForAgent(at);
        const label = deps.agentLabel(at);
        const agent = await watchStall(
          withDeadline(
            deps.connect(pluginId),
            BIND_DEADLINE_MS,
            `${label} has not finished connecting`,
            // A first run downloads Node and `npm install`s the adapter, which
            // can outlast the deadline on a slow disk or connection (Defender
            // scanning node_modules on Windows). While the install keeps
            // restating its status (it ticks with the elapsed time) the job
            // is alive and the deadline re-arms; a status that stops moving
            // is a hang, and the deadline fires. Either way the install
            // itself is a backend job that outlives this connect, so a
            // retry joins it rather than restarting it.
            progressSince(() => deps.chat().agentStartingStatus[pluginId]),
          ),
          label,
          tabId,
        );
        if (stale()) return;
        // Resolve cwd from THIS tab's project, not the global currentProject:
        // background projects keep their chat panels mounted, so a bind that
        // fires after a project switch (failed-bind retry, agent change)
        // would otherwise create the session against the WRONG repo — and a
        // "/" fallback would dodge the running-project eviction guard. A tab
        // asked to start in a worktree (`bindCwd`) starts there.
        const cwd = deps.chat().sessions[tabId]?.bindCwd || deps.projectPath(tabId);
        const init = await watchStall(
          withDeadline(
            deps.agents.newSession(agent.agent_id, cwd),
            BIND_DEADLINE_MS,
            `${label} has not answered \`session/new\``,
          ),
          label,
          tabId,
        );
        const key = init.key;
        orphan = key;
        if (stale()) return;
        // Guard against an agent switch that landed mid-bind: if the tab's
        // agentType changed since we picked `pluginId`, this binding is for the
        // wrong agent — abandon it so we don't clobber the tab with a stale
        // (e.g. Codex) session under the newly-chosen agent. The panel
        // re-attaches on an agent change, and that attempt binds the right one.
        const nowAt = deps.chat().sessions[tabId]?.agentType;
        if (pluginIdForAgent(nowAt) !== pluginId) return;
        // Apply the tab's permission mode BEFORE exposing the binding.
        // `setAcpBinding` is what flushes any queued send, so if we set the
        // mode after it the first turn can race ahead of (e.g.)
        // bypassPermissions and still trigger a stray prompt on turn one.
        // Awaiting here guarantees the agent is in the right mode first.
        const session = deps.chat().sessions[tabId];
        // Which record the tab's pick lives in is the session's own
        // (`onClaudeModeList`), never the agent's id (ADR-0002). An unset or
        // undeclared pick means the user has not overridden the agent: it
        // keeps the mode it resolved from its own user-level config.
        const ownRecord = onClaudeModeList(session);
        const requestedMode = ownRecord
          ? session?.claudePermissionModeExplicit
            ? (session.claudePermissionMode ?? "default")
            : undefined
          : session?.acpModeExplicit
            ? session.acpCurrentMode
            : undefined;
        // The same call the resume path makes, so a mode means the same
        // thing whether a session is new or reopened (`resume-mode.ts`). A
        // pick the agent refuses leaves it in its own mode, and that is the
        // mode seeded below.
        const settled = await deps.configuration.settleMode(key, requestedMode ?? undefined, init);
        if (stale()) return;
        const effectiveMode = settled.effective ?? init.current_mode;
        // Seed the store before binding: binding is the point at which queued
        // sends become eligible, so the first prompt sees the agent's actual
        // default instead of a hard-coded Atlas fallback.
        if (!stale()) {
          const actions = deps.chat().actions;
          if (ownRecord) {
            if (isClaudePermissionMode(effectiveMode)) {
              actions.hydrateClaudePermissionMode(tabId, effectiveMode);
            }
          } else if (init.available_modes.length > 0) {
            actions.setAcpModes(tabId, settled.effective, init.available_modes, nowAt);
          }
          // The picker shows the AGENT's mode now, which the user never
          // chose: it is not a pick the next resume should ask for. (On the
          // own record, `hydrateClaudePermissionMode` drops its flag the same
          // way.)
          if (requestedMode && !settled.honoured && !ownRecord) {
            actions.dropAcpModePick(tabId);
          }
        }
        // A model picked before there was a session — the composer's agent +
        // model picker switches agent and model in one pick — is applied here,
        // for the same reason as the mode: the first prompt must run on it.
        // `switchChatAgent` clears the model, so a set one is a pick — or, on
        // a rebind, the model the conversation was already on.
        const pickedModel = deps.chat().sessions[tabId]?.acpCurrentModel;
        if (pickedModel) {
          const taken = await deps.configuration.apply(key, KNOBS.model, pickedModel);
          if (stale()) return;
          // Refused (ACP audit finding 40): the agent stays on its own model, so the picker
          // must not keep showing this one. Dropping the pick is what lets the
          // snapshot below seed the model the agent is actually on.
          if (!taken && deps.chat().sessions[tabId]?.acpCurrentModel === pickedModel) {
            deps.chat().actions.dropAcpModelPick(tabId);
            deps.report.log({
              source: "atlas",
              kind: "agent-bind",
              summary: `${label}: refused the model ${pickedModel}; staying on its own`,
              status: "failure",
              payload: { tabId },
            });
          }
        }
        // The tab's session, once the binding below is out. Until then the
        // attempt can only be let go (`stale`); after it, binding is exactly
        // what makes the panel let go of the bind (its effect re-runs on
        // `acpSessionId`), so `stale()` is always true and the question is
        // whether the tab has moved to ANOTHER session.
        let exposed = false;
        const moved = () => deps.chat().sessions[tabId]?.acpSessionId !== key.session_id;
        const letGo = () => (exposed ? moved() : stale());
        // What the user remembers for this agent goes in before the binding
        // too, and for the same reason as the mode and the model: a first
        // prompt held for the bind is released by it, and ran on the agent's
        // defaults while the pills showed the remembered values. The native
        // agent's reasoning effort is on the tab already (its pill seeds it
        // from the saved one); the option picks (#33) are in the prefs.
        const remembered = (async () => {
          const starting = deps.chat().sessions[tabId];
          const effort = starting?.nativeEffort;
          if (starting && effort && KNOBS.effort.offers(starting, effort)) {
            await deps.configuration.apply(key, KNOBS.effort, effort);
            if (letGo()) return;
          }
          if (!nowAt) return;
          await deps.configuration.reapplyRememberedOptions(
            nowAt,
            key,
            async () => (await deps.agents.snapshotMeta(key)).config_options ?? [],
            letGo,
          );
        })();
        // Never in the way of the bind: a refusal is only logged (`apply`),
        // and one that does not answer is left to finish behind the binding,
        // which is where all of this used to run.
        try {
          await withDeadline(
            remembered,
            REAPPLY_DEADLINE_MS,
            `${label} has not taken its remembered options`,
          );
        } catch (err) {
          console.warn("binding without the remembered options:", err);
        }
        if (stale()) return;
        deps.chat().actions.setAcpBinding(tabId, agent.agent_id, key.session_id, cwd);
        exposed = true;
        orphan = null;
        wanted.delete(tabId);
        // Bound successfully — re-arm the failure toast so a LATER breakage
        // (agent crashes, gets uninstalled) is reported again rather than
        // swallowed by the earlier dedupe. Same for the sign-in offer: a token
        // that expires later in the session deserves the dialog again.
        reportedBindFailures.delete(`${tabId}:${pluginId}`);
        signInAttempted.delete(`${tabId}:${pluginId}`);
        retriedBinds.delete(`${tabId}:${pluginId}`);
        // The attempt is over here, and what follows is seeding the tab from
        // the session it now holds. `stale()` is the wrong question for that
        // (see `exposed`): guarding on it skipped everything below on every
        // bind. What can go wrong from here is the tab moving to ANOTHER
        // session before the snapshot is back (`moved`).
        // Seed the composer mode picker from the freshly-created session's
        // advertised modes (Codex: read-only / auto / full-access). The modes
        // are seeded into the Rust SessionState by `new_session`, so the
        // snapshot here already carries them. Claude ignores these in favour
        // of its own permission pill.
        try {
          const snap = await deps.agents.snapshotMeta(key);
          if (!moved()) {
            // Defensive `?.` — a snapshot from an older agent build may omit
            // these arrays; a throw here used to silently skip ALL seeding.
            const modes = snap.available_modes ?? [];
            const models = snap.available_models ?? [];
            // Only seed when the agent actually advertised modes, so we never
            // clobber the optimistic cached modes with an empty set.
            if (modes.length > 0) {
              deps
                .chat()
                .actions.setAcpModes(
                  tabId,
                  snap.current_mode,
                  modes,
                  agentTypeFromPluginId(snap.plugin_id),
                );
            }
            // Seed the ACP model picker (Claude Code / Codex) from the snapshot's
            // advertised models. Empty when the agent exposes no model selection.
            if (models.length > 0) {
              deps.chat().actions.setAcpModels(tabId, snap.current_model, models);
            }
            // Seed the slash-command list the same way. An
            // `available_commands_update` fired between `session/new` and the
            // binding is dropped by the delta router (no tab matches yet), and
            // nothing re-emits it — the snapshot is the recovery path, exactly
            // as for modes/models. Rust buffers pre-install notifications, so
            // by the time this snapshot lands the commands are in state.
            // The source agent rides along so a snapshot that raced an agent
            // switch is dropped instead of landing the OLD agent's commands
            // (Claude's skills, most visibly) under the new agent's picker.
            deps
              .chat()
              .actions.setAcpAvailableCommands(
                tabId,
                snap.available_commands ?? [],
                agentTypeFromPluginId(snap.plugin_id),
              );
            // And the config-option knobs (#32). The `session/new`
            // advertisement lives only in the backend cell — a follow-up
            // notification is optional and most agents never send one, so
            // without this the effort pill and every other knob simply never
            // appeared. This also heals the early-delta drop: any
            // `config_options_updated` emitted before the tab was bound is
            // re-covered by this snapshot, which is fetched after bind. The
            // remembered picks re-applied above are answered that way, so
            // this is also what puts them in the pills.
            deps
              .chat()
              .actions.setAcpConfigOptions(
                tabId,
                snap.config_options ?? [],
                agentTypeFromPluginId(snap.plugin_id),
              );
            // Boot finished (with or without modes) — drop the loading state.
            deps.chat().actions.setAcpModesPending(tabId, false);
          }
        } catch (err) {
          console.warn("snapshot for modes failed:", err);
          if (!moved()) deps.chat().actions.setAcpModesPending(tabId, false);
        }
      } catch (err) {
        console.warn("Agent session creation failed:", err);
        // Bind failed (couldn't set the agent up / spawn error). This used to
        // be console-only, so a user whose agent wouldn't start just saw a dead
        // composer with no reason given. The backend's message is the useful
        // one — `explain_spawn_failure` names the agent and the fix (check your
        // connection, or sign in with `cursor-agent login`). Deduped per
        // tab+agent because the focus handler retries this bind.
        if (!stale()) {
          deps.chat().actions.setAcpModesPending(tabId, false);
          const at = deps.chat().sessions[tabId]?.agentType;
          const key = `${tabId}:${pluginIdForAgent(at)}`;
          // The attempt is over, so is its "Installing …" text. A connect that
          // was killed (deadline, Stop) is aborted mid-install and never sends
          // the backend's own clear, which left the label stuck.
          deps.chat().actions.setAgentStartingStatus(pluginIdForAgent(at), null);
          // The log panel gets every failure, deduped or not: the dedupe below
          // is about not re-toasting, and a failure that reaches neither the
          // toast nor the log is one nobody can diagnose.
          deps.report.log({
            source: "atlas",
            kind: "agent-bind",
            summary: `${deps.agentLabel(at)}: bind failed — ${errInfo(err).message.slice(0, 200)}`,
            status: "failure",
            payload: { tabId, agent: at, kind: errInfo(err).kind },
          });
          // The hop outlived the client deadline. The backend future is still
          // parked, so a retry would only join it: kill the plugin's
          // connection (by plugin id — there is no session to kill by) and
          // forget the cached agent, so the next attempt is a fresh connect.
          // A three-minute hang is not the boot transient the silent retry
          // exists for either, so that is spent too and the failure reports.
          if (isDeadlineError(err)) {
            const timedOutPlugin = pluginIdForAgent(at);
            deps.agents
              .killPlugin(timedOutPlugin)
              .catch((e) => console.warn("killPlugin after bind timeout failed:", e));
            deps.forgetAgent(timedOutPlugin);
            retriedBinds.add(key);
          }
          // First failure of an automatic bind: try once more, quietly, before
          // telling anyone. `pending` is released in `finally` below, so the
          // delayed call is not coalesced away.
          if (!retriedBinds.has(key)) {
            retriedBinds.add(key);
            setTimeout(() => {
              if (!stale()) void ensureBound();
            }, BIND_RETRY_MS);
            return;
          }
          // The first message held for this bind cannot go out yet: drop the
          // "starting" state and keep it held, idle, beside the failure
          // reported below. Its bubble stays in the transcript, and the next
          // bind that lands (a retry, a sign-in, the next send's kick) sends
          // it as it was — with its images (ACP audit finding 73) and as that bubble (ACP audit finding 81). The
          // queue it used to be parked in carries text only: the images were
          // dropped, and the prompt was drawn a second time when it drained.
          // No loop: a held message only goes out on a bind landing.
          const held = deps.chat().sessions[tabId]?.pendingSend;
          if (held) deps.chat().actions.updateSessionStatus(tabId, "idle");
          // A message is waiting on this bind: the user is watching, so the
          // failure is reported even if an earlier one for this tab+agent
          // already was. The dedupe exists to stop the focus-retry
          // re-toasting into the void, not to hide the reason a send never
          // went out.
          const waiting = !!held || (deps.chat().queues[tabId]?.length ?? 0) > 0;
          if (waiting || !reportedBindFailures.has(key)) {
            reportedBindFailures.add(key);
            // Cursor (and friends) reject `session/new` when signed out, so the
            // "you need to sign in" case lands HERE, not on the turn-failure
            // route that raises `atlas:auth-required`. Offer the one-click fix
            // instead of dumping a raw protocol error, and rebind once it lands.
            // Only ONCE per tab+agent — see `signInAttempted`.
            const action = bindFailureAction({
              agentType: at,
              err,
              alreadyAttempted: signInAttempted.has(key),
            });
            if (action === "sign-in" && at) {
              signInAttempted.add(key);
              // `reason` is what lets the dialog offer in-app key entry rather
              // than the agent's own (often unusable) auth methods.
              deps.report.signIn(at, {
                reason: errInfo(err).message,
                onSignedIn: () => {
                  reportedBindFailures.delete(key);
                  void ensureBound();
                },
                // Dismissed without signing in: re-arm reporting, and the
                // offer (ACP audit finding 72). The dedupe key used to stay set forever,
                // silently swallowing every subsequent bind failure for this
                // tab+agent; and with the offer spent, the next failure said
                // the agent "still reports no credentials after signing in"
                // to a user who never signed in, with no way back to the dialog.
                onDismissed: () => {
                  reportedBindFailures.delete(key);
                  signInAttempted.delete(key);
                },
              });
              // The dialog is up; if the user is away it is also a banner.
              deps.report.signInBanner(tabId, at);
            } else if (action === "atlas-sign-in") {
              // Signed out of Atlas: the native agent cannot fetch its model
              // list without an Atlas token. Not an error — an automatic bind
              // (opening a tab, focus) says nothing; a send that is now stuck
              // in the queue gets the one thing that unblocks it.
              if (waiting) deps.report.atlasSignIn();
            } else if (action === "silent") {
              // The composer is already showing why (`AiGrantBar`, and "No
              // models" in the picker). A toast would be a third copy of a
              // setup problem, re-raised on every rebind.
            } else if (action === "signed-in-but-refused" && at) {
              // Signed in already and STILL refused. Say so, and surface the
              // agent's own words — it is the only thing that can explain what
              // else it wants.
              deps.report.error(
                `${deps.agentLabel(at)} still reports no credentials after signing in. ` +
                  `It said: ${errInfo(err).message}`,
              );
            } else {
              // `errInfo`, not String(err): these commands reject with a
              // structured `{message, kind}`, which stringifies to
              // "[object Object]".
              deps.report.error(errInfo(err).message);
            }
          }
        }
      } finally {
        if (orphan) {
          const { agent_id, session_id } = orphan;
          void deps.agents.dropSession(agent_id, session_id).catch(() => {});
        }
        // A superseded attempt does not release the flag: the attempt that
        // replaced it owns `pending` now.
        if (myEpoch === tab.epoch) tab.pending = false;
      }
    };

    /** Connect the tab's agent ahead of the session the user may start, so
     *  that start costs only `session/new`, and let the mode pill show the
     *  agent's cached modes instead of loading. Silent: a connect that fails
     *  is retried, and reported, by the bind a write or a send starts. */
    const warm = () => {
      if (tab.holders === 0 || tab.pending) return;
      const session = deps.chat().sessions[tabId];
      if (!session || session.acpSessionId) return;
      deps.chat().actions.setAcpModesPending(tabId, false);
      void deps.connect(pluginIdForAgent(session.agentType)).catch(() => {});
    };

    /** Make the attempt in flight stale and free the tab for the next one. */
    const supersede = () => {
      tab.epoch += 1;
      tab.pending = false;
    };

    return {
      retry: () => {
        supersede();
        const at = deps.chat().sessions[tabId]?.agentType;
        const key = `${tabId}:${pluginIdForAgent(at)}`;
        reportedBindFailures.delete(key);
        signInAttempted.delete(key);
        retriedBinds.delete(key);
        void ensureBound();
      },
      abandon: () => {
        // Stop: the user let go of this start, so nothing carries it on.
        wanted.delete(tabId);
        supersede();
      },
      kick: () => void ensureBound(),
      warm,
      wanted: () => wanted.has(tabId),
      detach: () => {
        if (detached) return;
        detached = true;
        tab.holders -= 1;
        if (tab.holders > 0) return;
        // Nobody is waiting for it any more: whatever the attempt answers is
        // dropped. A panel that mounts later starts from a clean entry.
        supersede();
        if (tabs.get(tabId) === tab) tabs.delete(tabId);
        // The request goes with the panel, unless one attaches again at once:
        // an agent switch detaches and re-attaches in the same commit, and
        // carries the start on (`wanted`). A panel that mounts later must not
        // start a session nobody is asking for any more.
        setTimeout(() => {
          if (!tabs.has(tabId)) wanted.delete(tabId);
        }, 0);
      },
    };
  }

  return {
    attach,
    reset() {
      for (const tab of tabs.values()) tab.epoch += 1;
      tabs.clear();
      wanted.clear();
      reportedBindFailures.clear();
      retriedBinds.clear();
      signInAttempted.clear();
    },
  };
}

/** The app's instance. */
export const sessionBind = createSessionBind({
  agents,
  configuration: sessionConfiguration,
  // Called through, not captured: a test that mocks one of these modules
  // narrowly need not define what its code path never reaches.
  connect: (pluginId) => ensureAgent(pluginId),
  forgetAgent: (pluginId) => resetAgent(pluginId),
  chat: () => useChatStore.getState(),
  projectPath: (tabId) =>
    projectPathForTab(tabId) ?? useAppStore.getState().currentProject?.path ?? "/",
  agentLabel: (agentType) => agentMeta(agentType).label,
  report: {
    log: (entry) => logEvent(entry),
    error: (message) => void toast.error(message),
    signIn: (agentType, opts) => promptSignIn(agentType, opts),
    signInBanner: (tabId, agentType) => notifyAgentSignInRequired(tabId, agentType),
    atlasSignIn: () => promptAtlasSignIn(),
  },
});
