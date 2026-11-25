import { create } from "zustand";
import { agents } from "../lib/agents-api";
import type { InjectedPrompt } from "../lib/injected-prompt";
import { isDraft, original } from "immer";
// Without auto-freeze: a long session's `messages` is frozen whole per update
// otherwise, which costs JavaScriptCore milliseconds a batch (see the file).
import { immerUnfrozen as immer } from "@/lib/immer-unfrozen";
import type {
  ChatSession,
  ChatMessage,
  AgentStatus,
  MessageRole,
  ClaudePermissionMode,
  SwitchableAgent,
  AgentType,
  PendingSend,
  Subagent,
  PlanStep,
} from "@/types/agent";
import { CLAUDE_PERMISSION_MODES, isBusyAgentStatus, pluginIdForAgent } from "@/types/agent";
import type { PendingPermission } from "@/types/acp";
import type {
  AgentDelta,
  ToolCall as AgentToolCall,
  ToolCallStatus,
  ImageAttachment,
  SessionModeInfo,
  PendingElicitationWire,
  PendingPermissionWire,
  QueuedPrompt,
} from "@/types/agents";
import { splitAtlasContext } from "../lib/atlas-context";
import { stopReasonHaltsQueue } from "../lib/queue-halt";
import {
  clearCachedAcpModes,
  loadCachedAcpModes,
  saveCachedAcpModes,
} from "../lib/acp-modes-cache";
import { loadLastModePref, saveLastModePref } from "../lib/last-mode-pref";
import { modeSelectOf, modelSelectOf } from "../lib/acp-config-options";
import { exitPlanModeForOption, exitPlanOptionRestartsSession } from "../lib/exit-plan-modes";
import { loadConfigOptionPrefs, saveConfigOptionPref } from "../lib/config-option-prefs";
import {
  KNOBS,
  cacheAdvertisedOptions,
  createSessionConfiguration,
  onClaudeModeList,
  startsOnClaudeModeList,
  type AdvertisedOptions,
} from "../lib/session-configuration";
import {
  loadCachedAcpConfigOptions,
  saveCachedAcpConfigOptions,
} from "../lib/acp-config-options-cache";
import {
  clearCachedAcpModels,
  loadCachedAcpModels,
  saveCachedAcpModels,
} from "../lib/acp-models-cache";
import { resolveModelLabel } from "../lib/model-label";
import { agentForNewSession } from "../lib/default-agent";
import { invalidateLoad } from "../lib/load-tokens";
import { loadCachedContextUsage, saveCachedContextUsage } from "../lib/context-usage-cache";
import { saveNativeEffort } from "../lib/native-model-pref";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { extractPlanMarkdown, type PlanRecord } from "../lib/plans";
import { extractNextSteps, stripNextStepsDirective } from "../lib/next-steps";
import { foldTurnFiles, turnFilesOfToolCall } from "../lib/turn-files";
import { toolCallFacts } from "../lib/tool-changes";
import { inlineQueuedText, type QueuedContent } from "../lib/queued-text";
import type { MentionData } from "../lib/mentions";
import type { TurnFile, TurnInterruption } from "@/types/agent";
import { emitWindowEvent } from "@/lib/window-events";

/** `firstUserContent` is a preview field, never the full text — see the note
 *  at its appendMessage write. 200 chars covers every consumer (they slice to
 *  ≤80) with headroom. */
const FIRST_USER_PREVIEW_CHARS = 200;
const firstUserPreview = (prose: string): string => prose.slice(0, FIRST_USER_PREVIEW_CHARS);

/** The prefix of a queue id that marks an add still on its way to Rust
 *  (`lib/session-send.ts` mints them). */
const PENDING_QUEUE_ID = "pending:";

/** Rebuild the adaptive per-turn `turnSummary` (files read/modified) from a
 *  loaded transcript's tool calls. `turnSummary` is computed live at
 *  turn_finished and NOT persisted, so a resumed/switched session (the chat is a
 *  singleton tab, so navigating reloads from disk) would otherwise show no
 *  adaptive card. Walk each turn (a run of assistant messages after a user
 *  message) and freeze the accumulated files onto its trailing assistant
 *  message — the same slot the live path uses. Mutates in place. */
function reconstructTurnSummaries(messages: ChatMessage[]): void {
  const flushTurn = (start: number, end: number) => {
    const touched: TurnFile[] = [];
    let lastAsst = -1;
    for (let i = start; i < end; i++) {
      const m = messages[i];
      if (m.role !== "assistant") continue;
      lastAsst = i;
      for (const tc of m.toolCalls) {
        for (const file of turnFilesOfToolCall(toolCallFacts(tc))) touched.push(file);
      }
    }
    if (lastAsst >= 0) {
      const files = foldTurnFiles(touched);
      if (files.length > 0) {
        messages[lastAsst].turnSummary = {
          turnSeq: 0, // reconstructed — not tied to a live turn
          files,
          repoAtTurn: false,
        };
      }
      // Restore agent-generated chips from the reply's <next_steps> block.
      const chips = extractNextSteps(messages[lastAsst].content);
      if (chips.length > 0) {
        messages[lastAsst].suggestions = { turnSeq: 0, status: "ready", chips };
      }
    }
  };
  let turnStart = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user" && i > turnStart) {
      flushTurn(turnStart, i);
      turnStart = i;
    }
  }
  flushTurn(turnStart, messages.length);
}

/** Hydrate the per-agent persisted mode preference (last explicit pick) into
 *  a freshly-created / freshly-switched tab. A restored pick is marked
 *  explicit so the chat panel pushes it to the agent at session create (after
 *  revalidating against the advertised modes); no pick means "defer to the
 *  agent's own configured default" — never an Atlas-side override. */
/**
 * Drop everything the Usage pill reads. Usage belongs to ONE backend session:
 * the moment a tab stops pointing at that session — a "New Chat" reset in
 * place, an agent switch, a rebind to a different session — the numbers must
 * go with it, or the next session wears the previous one's context gauge,
 * token split and cost until its own first turn overwrites them.
 */
function forgetSessionUsage(sess: ChatSession): void {
  sess.usage = undefined;
  sess.contextUsage = undefined;
  sess.lastUsageSnapshot = undefined;
  sess.pendingSavedTokens = undefined;
  sess.compacting = undefined;
  sess.rateLimits = undefined;
}

function applyPersistedModePref(sess: ChatSession, agentType: AgentType): void {
  const pref = loadLastModePref(agentType);
  if (onClaudeModeList(sess)) {
    const valid = !!pref && (CLAUDE_PERMISSION_MODES as readonly string[]).includes(pref);
    sess.claudePermissionMode = valid ? (pref as ClaudePermissionMode) : "default";
    sess.claudePermissionModeExplicit = valid;
    return;
  }
  // Generic ACP agents: only trust the pick against the optimistic cached
  // mode list (or when nothing is cached yet) — an id the live agent turns
  // out not to advertise would stick the picker on its "Mode" fallback.
  // Session-create revalidates against the real advertised list either way.
  const cached = loadCachedAcpModes(agentType);
  const valid =
    !!pref &&
    (!cached ||
      cached.availableModes.length === 0 ||
      cached.availableModes.some((m) => m.id === pref));
  sess.acpModeExplicit = valid;
  if (valid && pref) sess.acpCurrentMode = pref;
}

// `pushNativeCompressToAgent` stood here, pushing the RTK compression toggle
// through `agents_set_compress`. Both are gone (#54): the ported engine has no
// tool-output compressor, so there was nothing on the other end of the command.

/** The paths in a wire call's ACP `locations` (`[{ path, line? }]`), or
 *  undefined when it carried none — the field stays absent rather than an
 *  empty array, like the other optional tool-call fields. */
export function toolLocations(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const paths: string[] = [];
  for (const l of raw) {
    const path = (l as { path?: unknown } | null)?.path;
    if (typeof path === "string" && path.length > 0) paths.push(path);
  }
  return paths.length > 0 ? paths : undefined;
}

/** What a call's card shows as its result. `result` is the flattened text of
 *  the call's `content`; an agent may report a result only as `rawOutput`
 *  (an MCP tool's whole answer, for one), and with no content and no
 *  structured block that is the only account of what the call did, so it is
 *  shown rather than an empty card (ACP audit finding 100). A string goes as it is,
 *  anything else as JSON. */
export function toolResultText(tc: AgentToolCall): string | null {
  if (tc.result) return tc.result;
  if (tc.content_blocks?.length) return tc.result;
  const raw = tc.raw_output;
  if (raw === undefined || raw === null) return tc.result;
  if (typeof raw === "string") return raw || tc.result;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return tc.result;
  }
}

/** One wire plan entry as the plan pill and the thread hold it. `priority`
 *  is kept as the agent gave it (ACP: high / medium / low) — it was dropped
 *  here before (ACP audit finding 102). */
function toPlanStep(
  e: { content: string; status: string; priority?: string | null },
  idx: number,
): PlanStep {
  return {
    id: `plan-${idx}`,
    description: e.content,
    status: (e.status as PlanStep["status"]) ?? "pending",
    ...(e.priority ? { priority: e.priority } : {}),
  };
}

/** Convert an atlas-agents wire ToolCall into the in-store ChatMessage shape. */
function toChatToolCall(tc: AgentToolCall): ChatMessage["toolCalls"][number] {
  return {
    id: tc.id,
    toolName: tc.tool_name,
    // Preserve the ACP `kind` so bash/execute calls can be recognised
    // reliably (the bash-history panel + bash-styled cards key off it).
    kind: tc.kind ?? null,
    arguments: (tc.arguments ?? {}) as Record<string, unknown>,
    result: toolResultText(tc),
    // Only present when the agent reported a diff/terminal block; the Rust
    // side omits the field entirely when empty.
    contentBlocks: tc.content_blocks,
    // Only present when the agent said this call belongs to a subagent, which
    // is the only thing distinguishing a child's work from its parent's: both
    // arrive on one session, interleaved.
    parentToolCallId: tc.parent_tool_call_id,
    locations: toolLocations(tc.locations),
    // Rust's times, which survive a reload. Spread only when present:
    // `Object.assign` onto an existing call must not blank a start with an
    // `undefined`.
    ...(tc.started_at_ms !== undefined ? { startedAt: tc.started_at_ms } : {}),
    ...(tc.ended_at_ms !== undefined ? { endedAt: tc.ended_at_ms } : {}),
    status:
      tc.status === "pending"
        ? "pending"
        : tc.status === "running"
          ? "running"
          : tc.status === "failed"
            ? "failed"
            : "completed",
    duration: null,
  };
}

interface ChatState {
  sessions: Record<string, ChatSession>;
  /**
   * Pending ACP permission requests, keyed by acpSessionId. Each list is
   * FIFO — the modal renders the head. Cleared on respond / agent_disconnect.
   */
  pendingPermissions: Record<string, PendingPermission[]>;
  /**
   * Per-tab queued prompts, as the composer's strip renders them. For a bound
   * session this mirrors Rust's queue (the turn controller owns and drains it;
   * `queue_changed` keeps this current), followed by any items typed while the
   * tab had no session to queue them in. See `lib/session-send.ts`.
   */
  queues: Record<string, string[]>;
  /**
   * Parallel to `queues`: each item's Rust queue id, `null` for an item held
   * locally until the next bind, or a `pending:` marker for an add on its way.
   * Missing or short means local (code that writes `queues` alone).
   */
  queueIds: Record<string, (string | null)[]>;
  /**
   * Parallel to `queues`: what each item was sent as — the typed text, its
   * mentions and its images — so the agent gets the message a direct send
   * would have sent, and an agent switch or a restart onto a new session
   * hands on all of it (ACP audit findings 78 and 80). `null` (or missing)
   * for an item the window did not write: a remote driver's, or one a
   * snapshot reported; its strip text is then the whole of what is known.
   */
  queueContent: Record<string, (QueuedContent | null)[]>;
  /**
   * Per-tab composer draft. Mirrors the CodeMirror text body so a tab
   * switch (which unmounts MessageInput) doesn't drop what the user was
   * typing. Cleared on submit. Plain text only — mentions live in the
   * editor's document and rebind to fresh chip nodes when the draft
   * reloads on remount.
   */
  drafts: Record<string, string>;
  activeSessionId: string | null;
  /**
   * The manager's live loading status per PLUGIN id ("Downloading Node.js…",
   * "Installing @agentclientprotocol/codex-acp 1.11.0…") while that plugin's
   * connect is in flight. Keyed by plugin, not tab: the status belongs to the
   * one connection every tab on that agent is waiting for, and there is no
   * session to key it by until the connect finishes. Rendered in place of the
   * generic "Starting {agent}" label; an entry is removed when the manager
   * sends `null`.
   */
  agentStartingStatus: Record<string, string>;
}

interface ChatActions {
  actions: {
    /** `pendingRestore`: the agent session the tab is saved as showing, to be
     *  loaded when the tab is first shown (`ChatSession.pendingRestore`). */
    createSession: (tabId: string, agentType?: SwitchableAgent, pendingRestore?: string) => void;
    setPendingRestore: (tabId: string, sessionId: string | undefined) => void;
    /** Re-bind a fresh (message-less) chat to a different agent. Clears the ACP
     *  binding so the chat panel re-creates a session with the new agent. */
    switchChatAgent: (tabId: string, agentType: SwitchableAgent) => void;
    /** Sync the composer's agent label to an ALREADY-bound session's real
     *  agent (e.g. resuming a history session whose agent differs from the
     *  tab's current selection). Unlike `switchChatAgent` this does NOT clear
     *  the ACP binding — the session stays attached to its live agent process,
     *  so it never spawns a fresh chat. */
    setSessionAgentType: (tabId: string, agentType: SwitchableAgent) => void;
    setActiveSession: (id: string | null) => void;
    /** Returns the new row's id. For a user row it doubles as the client
     *  message id a send carries, so the prompt's `user_message` delta adopts
     *  this row rather than drawing another. */
    addMessage: (
      sessionId: string,
      role: MessageRole,
      content: string,
      attachments?: ImageAttachment[],
      /** See `ChatMessage.trustedMentionPaths`. */
      trustedMentionPaths?: string[],
    ) => string | undefined;
    /** Append the prompt Atlas sent the agent of ACP session `acpSessionId`
     *  on its own (`atlas:session-prompt-injected`) to that session's tab, if
     *  one is open. A user-role message marked `injected`, so it draws as its
     *  own row and never counts as the user's. */
    addInjectedPrompt: (
      acpSessionId: string,
      text: string,
      injected: InjectedPrompt,
      at: string,
    ) => void;
    appendToolCall: (sessionId: string, toolName: string, input: Record<string, unknown>) => void;
    updateLastAssistantMessage: (sessionId: string, content: string) => void;
    updateSessionStatus: (sessionId: string, status: AgentStatus) => void;
    /** Mark a session as stop-requested (Stop clicked, terminal not yet in). */
    setStopping: (sessionId: string, on: boolean) => void;
    /** See `ChatSession.pendingSend`. `undefined` clears it. */
    setPendingSend: (sessionId: string, pending: PendingSend | undefined) => void;
    /** Flag/clear "the backing agent process died" (drives Restart + rebind). */
    setDisconnected: (sessionId: string, on: boolean) => void;
    /** The user force-killed the agent from the composer. */
    noteAgentKilled: (sessionId: string) => void;
    setSessionTitle: (sessionId: string, title: string) => void;
    setTranscriptLoading: (sessionId: string, loading: boolean) => void;
    /** Mark a resumed session as bound-but-not-yet-loaded. See
     *  `ChatSession.resumePending` — gates sending, not reading. */
    setResumePending: (sessionId: string, pending: boolean) => void;
    clearSession: (sessionId: string) => void;
    /** Where the tab's next bind opens its session (see `ChatSession.bindCwd`). */
    setBindCwd: (tabId: string, cwd: string) => void;
    removeSession: (sessionId: string) => void;
    /** Drop several sessions at once (used when a project is DISCARDED from
     *  the hot set — frees its chat history from RAM; reloaded cold on revisit). */
    removeSessions: (sessionIds: string[]) => void;
    /** Drop all chat sessions, queues, and pending permissions. Used when
     *  the user switches projects so dead acpSessionIds from the old
     *  project's `.atlas/` don't linger and cause ghost-bound tabs. */
    resetSessions: () => void;
    cycleClaudePermissionMode: (sessionId: string) => void;
    /** Reflect the mode the agent chose during session creation without
     *  treating it as an Atlas user override or sending a second RPC. */
    hydrateClaudePermissionMode: (sessionId: string, mode: ClaudePermissionMode) => void;
    setClaudePermissionMode: (sessionId: string, mode: ClaudePermissionMode) => void;
    /** A plan-approval option was answered: adopt the mode it selects (or
     *  `override`, for Atlas's own "approve and bypass") and push it to the
     *  agent, since the Claude adapter applies it silently. Not persisted as
     *  the user's preference — it is a per-session decision. */
    applyExitPlanSelection: (
      sessionId: string,
      optionId: string,
      override?: ClaudePermissionMode,
    ) => void;
    /** Seed the generic ACP mode state (current + available list) from a
     *  session snapshot. Used for non-Claude agents (e.g. Codex). */
    setAcpModes: (
      sessionId: string,
      currentMode: string | null,
      availableModes: SessionModeInfo[],
      /** Agent the snapshot came from (`agentTypeFromPluginId(snap.plugin_id)`).
       *  When it disagrees with the tab's current agent the seed is stale and is
       *  dropped — see the action for the cross-agent bug that motivated it. */
      sourceAgentType?: AgentType,
    ) => void;
    /** Pick a generic ACP session mode and push it to the bound agent.
     *  The Codex equivalent of `setClaudePermissionMode`. */
    setAcpMode: (sessionId: string, modeId: string) => void;
    /** Forget this tab's ACP mode pick (not the saved preference): a resume
     *  could not apply it, so the picker now shows the agent's own mode, which
     *  the user never chose. */
    dropAcpModePick: (sessionId: string) => void;
    /** Forget this tab's model pick: the agent refused it, so the next
     *  snapshot's current model (`setAcpModels`) is what the picker shows. */
    dropAcpModelPick: (sessionId: string) => void;
    /** Set or clear (`undefined`) the mode a resume could not restore. A mode
     *  pick clears it too. See `ChatSession.unrestoredModeId`. */
    setUnrestoredMode: (sessionId: string, modeId: string | undefined) => void;
    /** Set an agent-advertised config option (P2.2). Optimistic locally; the
     *  agent's own `config_option_update` is the authority and overwrites it. */
    /** Close an answered/dismissed elicitation (P3.3) and show the next one
     *  waiting. With `requestId`, that one (shown or waiting); without, the
     *  one shown. */
    clearElicitation: (sessionId: string, requestId?: string) => void;
    setAcpConfigOption: (
      sessionId: string,
      configId: string,
      value: boolean | string,
    ) => Promise<void>;
    /** Toggle the non-Claude mode-picker loading state. Set false once the
     *  session boot resolves (modes confirmed, or bind failed) so the composer's
     *  picker never hangs on its loading spinner. */
    setAcpModesPending: (sessionId: string, pending: boolean) => void;
    /** Seed the ACP model list (Claude Code / Codex) + current model from a
     *  session snapshot's `available_models`. Caches per agentType. */
    setAcpModels: (
      sessionId: string,
      currentModel: string | null,
      availableModels: SessionModeInfo[],
    ) => void;
    /** Replace the model list on EVERY session of an agent type at once — the
     *  native agent's picker Refresh (ADR-0007), whose list belongs to the
     *  agent rather than to one session. Never touches a session's current
     *  model. Caches per agentType like `setAcpModels`. */
    setAcpModelsForAgent: (agentType: string, availableModels: SessionModeInfo[]) => void;
    /** Pick an ACP model and push it to the bound agent (`session/set_model`). */
    setAcpModel: (sessionId: string, modelId: string) => void;
    /** Seed the ACP slash-command list from a session snapshot's
     *  `available_commands` — the recovery path for `available_commands_update`
     *  deltas that raced ahead of the binding (or a resume) and were dropped
     *  by the session router. Never clobbers a non-empty live list with an
     *  empty snapshot. */
    setAcpAvailableCommands: (
      sessionId: string,
      commands: unknown[],
      sourceAgentType?: AgentType,
    ) => void;
    /** Apply a snapshot's config options — the ONLY way an agent's initial
     *  knobs reach the frontend, since `session/new`'s advertisement lives in
     *  the backend cell and a follow-up notification is optional (#32). */
    setAcpConfigOptions: (tabId: string, options: unknown[], sourceAgentType?: string) => void;
    /** Native agent: set the reasoning-effort level and push it. */
    setNativeEffort: (sessionId: string, effort: string) => void;
    /** Native agent: toggle RTK tool-output compression and push it. */
    replaceMessages: (
      sessionId: string,
      messages: Array<{
        /** The snapshot's own id. Kept, so painting the same conversation
         *  again (a rebind's repaint) keys every unchanged row the same and
         *  React keeps it mounted. Absent only for a path that has none. */
        id?: string;
        role: MessageRole;
        content: string;
        timestamp?: string;
        /** The timestamp is a replay's, not when the message was said. */
        timestampApproximate?: boolean;
        /** Producing model recovered from the snapshot/transcript, so the
         *  per-message badge survives session reloads. */
        model?: string | null;
        /** Images a user message carried, restored from the snapshot. */
        attachments?: ImageAttachment[];
        /** The turn's wall time and how it stopped, on the message that
         *  ends it (snapshot `worked_ms` / `stop_reason`). */
        workedMs?: number;
        stopReason?: string;
        /** How the message reads (a thought, prose, tool work), and a
         *  thought's text, as the live stream gave them. */
        mode?: ChatMessage["mode"];
        thinking?: string;
        toolCalls?: Array<{
          /** The agent's own tool call id, when the caller has it. Optional
           *  only because not every paint path carries one; a caller that has
           *  it MUST pass it — it is the key later deltas are matched on. */
          id?: string;
          toolName: string;
          kind?: string | null;
          arguments: Record<string, unknown>;
          result?: string | null;
          /** How the tool call actually ended. Absent means unknown, which is
           *  the only case that may be assumed completed. */
          status?: ToolCallStatus;
          /** Epoch ms the call was first seen and first settled, as Rust
           *  stamped them. */
          startedAt?: number;
          endedAt?: number;
          /** The diff and terminal blocks, the paths it touched, and the
           *  subagent launch it belongs to, as the live stream gave them. */
          contentBlocks?: ChatMessage["toolCalls"][number]["contentBlocks"];
          locations?: string[];
          parentToolCallId?: string | null;
        }>;
      }>,
      /** The painting snapshot's `as_of_seq`. A delta held while the
       *  transcript loaded (see `setTranscriptLoading`) at or below it is
       *  already in these messages, and is dropped instead of applied. */
      asOfSeq?: number,
    ) => void;
    /** Restore live (non-transcript) session state from a `session/load`
     *  snapshot: the backend's current status and the current turn's live plan.
     *  `replaceMessages` only restores the persisted thread; without this a
     *  session switched-away-from and back shows idle + no plan even while its
     *  backend turn is still running a plan. */
    hydrateSessionSnapshot: (
      tabId: string,
      status: AgentStatus,
      plan: Array<{ content: string; status: string; priority?: string | null }>,
      /** The session's delegated children, from the same snapshot. Absent on
       *  the metadata-only read, like `messages`; an empty array is a session
       *  that delegated nothing, and both clear what the rebind left. */
      subagents?: Subagent[],
      /** What else the snapshot says is live: open permission prompts and
       *  elicitations (so a reload mid-prompt can still answer), the turn
       *  queue, the hold. See `snapshotLive`. */
      live?: SnapshotLive,
    ) => void;
    /** Mirror the composer's plain text into the per-tab draft slot. */
    setDraft: (tabId: string, text: string) => void;
    /** Set/patch the adaptive next-step suggestions on a turn's trailing
     *  message. `turnSeq` is the stale guard — a late async result for a
     *  superseded turn is dropped. */
    setTurnSuggestions: (
      tabId: string,
      messageId: string,
      turnSeq: number,
      patch: {
        status: "idle" | "loading" | "ready" | "error";
        chips?: string[];
      },
    ) => void;
    /** Drop a draft (on submit, or when its tab closes). */
    clearDraft: (tabId: string) => void;
    /**
     * Add an item to the strip. The queue holds strings, so every queued send
     * passes the mentions it was sent with and its pastes', cites' and review
     * comments' text goes into the string (`inlineQueuedText`): a bare
     * `@paste:<id>` or `@cite:<id>` would reach the agent with nothing behind
     * it. Required, so no queue path can skip it. `id` is the item's Rust
     * queue id or a `pending:` marker; omitted, the item is local (held until
     * the next bind). Pure state — `lib/session-send.ts` decides where an item
     * goes.
     */
    enqueueMessage: (
      sessionId: string,
      text: string,
      mentions: readonly MentionData[],
      id?: string | null,
      attachments?: ImageAttachment[],
    ) => void;
    removeQueueItem: (sessionId: string, index: number) => void;
    editQueueItem: (sessionId: string, index: number, text: string) => void;
    shiftQueue: (sessionId: string) => string | null;
    clearQueue: (sessionId: string) => void;
    /** Lift the window's record of a failed turn's queue halt (audit #77):
     *  the user resumed it. */
    clearQueueHalt: (sessionId: string) => void;
    /** Re-key the item carrying id `from` (a pending marker) as `to`. */
    setQueueItemId: (sessionId: string, from: string, to: string | null) => void;
    setQueueItemIdAt: (sessionId: string, index: number, id: string | null) => void;
    /** Every item becomes local (the session its ids named is gone). */
    setAllQueueItemsLocal: (sessionId: string) => void;
    /** Write in the whole text of items whose strip text is only the head a
     *  `queue_changed` delta carried, from a snapshot's queue (by item id). */
    fillQueueText: (sessionId: string, queue: QueuedPrompt[]) => void;
    // ── ACP bindings ────────────────────────────────────────────────────
    setAcpBinding: (
      tabId: string,
      agentId: string,
      acpSessionId: string,
      /** Project root the session was created with — stamps `workingDirectory`. */
      cwd?: string,
    ) => void;
    /**
     * Apply one `atlas:acp` event to whichever chat tab owns its acpSessionId.
     * Phase-1 handles `agent_message_chunk` (text) and `tool_call`; everything
     * else is silently ignored until phase-2 widgets land.
     */
    /**
     * Apply an `atlas:agents` SessionDelta from the Rust-side manager. This
     * is the single bridge between the Rust SessionState and the chat-store —
     * status/turn lifecycle, text/thinking chunks, tool-call upserts, plan
     * updates, mode/model changes, available_commands. Permission requests
     * flow through `pushPermission` from the agent event router.
     */
    applyAgentDelta: (env: AgentDelta) => void;
    /**
     * RAF-coalesced fast path for streaming text. Called by the global ACP
     * listener once per animation frame instead of per chunk.
     */
    appendAssistantText: (acpSessionId: string, text: string) => void;
    /** RAF-coalesced fast path for `agent_thought_chunk`. */
    appendAssistantThought: (acpSessionId: string, text: string) => void;
    /**
     * Apply a frame's worth of buffered events in a SINGLE immer pass.
     * On a "read 30 files" turn the adapter emits ~60 `tool_call` /
     * `tool_call_update` events plus a stream of text chunks. Calling
     * `applyAgentDelta` (which is its own `set(...)`) per event paid an
     * immer snapshot + subscriber notification per event — at 60 events
     * that's 60 full structural-share passes over `s.sessions[tid]`
     * and 60 `MessagesList` re-renders with `measureElement` work.
     * Batching collapses that to 1 immer pass + 1 re-render per frame.
     *
     * The caller (`agent-event-router.ts`) is expected to:
     *  - Dedupe `tool_call_upserted` by `(session, tool_call.id)` so
     *    only the latest state for each tool call lands.
     *  - Pass text/thought as merged-per-session strings (same as the
     *    old per-event RAF flush did).
     *  - Pass other deltas in wire order — they're applied verbatim.
     */
    applyAgentBatch: (batch: {
      texts: Array<{ sessionId: string; text: string }>;
      thoughts: Array<{ sessionId: string; text: string }>;
      deltas: AgentDelta[];
    }) => void;
    pushPermission: (req: PendingPermission) => void;
    popPermission: (acpSessionId: string, requestId: string) => void;
    clearPermissionsForAgent: (agentId: string) => void;
    /** Drop every pending permission for a specific ACP session.
     *  Called on Stop so a modal left over from the cancelled turn
     *  doesn't linger and trick the user into clicking Allow on a
     *  request the agent already abandoned. */
    clearPermissionsForSession: (acpSessionId: string) => void;
    /** Record (or, with `null`, clear) the manager's loading status for a
     *  plugin — see `ChatState.agentStartingStatus`. */
    setAgentStartingStatus: (pluginId: string, status: string | null) => void;
    /**
     * The connection for `pluginId` is gone (its child died, or its connect
     * failed) while tabs on that agent were still waiting to be bound. Deltas
     * route by `session_id`, and an unbound tab has none, so without this a
     * tab sitting on "Starting {agent}" never learned the process it was
     * waiting for had already exited. For every tab on that plugin that has no
     * `acpSessionId` and is holding a first message or starting: the held
     * message goes back to the queue chip, the status drops to idle, and the
     * tab is flagged `disconnected` so the Restart banner (and the next send's
     * rebind) take over. Returns nothing; safe to call for a plugin no tab is on.
     */
    failPendingBinds: (pluginId: string, reason?: string) => void;
    /**
     * The agent behind `pluginId` was uninstalled, bound tabs included. The
     * backend dropped its connection without a delta (there is no session to
     * route one by), so this records what one would have: every tab on that
     * plugin drops to idle, a held first message goes back to the queue, and
     * the tab is flagged disconnected with `reason` so the banner can offer a
     * switch instead of a restart that cannot succeed. Untouched tabs are the
     * caller's to re-point (`removed-agents.ts`).
     */
    noteAgentRemoved: (pluginId: string, reason: string) => void;
    /**
     * `pluginId` was restarted onto `version`. Rust already sent each bound
     * tab `agent_disconnected`; this records why, so the banner says the
     * agent was updated instead of that it exited. Tabs not yet bound need
     * nothing — their bind starts the new version.
     */
    noteAgentUpdated: (pluginId: string, version: string) => void;
  };
}

/** The live state a session snapshot carries beyond its transcript. */
export interface SnapshotLive {
  agentId?: string;
  /** The turn the session is on in Rust (`SessionSnapshot.turn_seq`). */
  turnSeq?: number;
  pendingPermissions?: PendingPermissionWire[];
  pendingElicitation?: PendingElicitationWire | null;
  queue?: QueuedPrompt[];
  held?: boolean;
}

/** One strip item: what it shows, its Rust id (or pending marker, or `null`
 *  for local), and what it was sent as (see `ChatState.queueContent`). */
export interface QueueItem {
  text: string;
  id: string | null;
  content: QueuedContent | null;
}

/** The tab's strip, the three parallel arrays zipped. */
export function queueItemsOf(
  s: Pick<ChatState, "queues" | "queueIds" | "queueContent">,
  tabId: string,
): QueueItem[] {
  const texts = s.queues[tabId] ?? [];
  const ids = s.queueIds[tabId] ?? [];
  // Trusted only when it lines up: content left from a strip something wrote
  // without it (`queues` set alone) must not attach to the wrong item.
  const stored = s.queueContent?.[tabId];
  const content = stored?.length === texts.length ? stored : [];
  return texts.map((text, i) => ({ text, id: ids[i] ?? null, content: content[i] ?? null }));
}

/** Write the tab's strip; an empty one is dropped. Every queue write goes
 *  through here, so the parallel arrays cannot drift apart. */
function writeQueue(s: ChatState, tabId: string, items: QueueItem[]): void {
  if (items.length === 0) {
    dropQueue(s, tabId);
    return;
  }
  s.queues[tabId] = items.map((q) => q.text);
  s.queueIds[tabId] = items.map((q) => q.id);
  s.queueContent[tabId] = items.map((q) => q.content);
}

function dropQueue(s: ChatState, tabId: string): void {
  delete s.queues[tabId];
  delete s.queueIds[tabId];
  delete s.queueContent[tabId];
}

/** A held first message going back to the strip, as a local item. */
function requeueHeld(s: ChatState, tabId: string, held: PendingSend): void {
  writeQueue(s, tabId, [
    ...queueItemsOf(s, tabId),
    {
      text: inlineQueuedText(held.content, held.mentions ?? []),
      id: null,
      content: {
        text: held.content,
        mentions: [...(held.mentions ?? [])],
        ...(held.attachments?.length ? { attachments: held.attachments } : {}),
      },
    },
  ]);
}

/** Tabs whose strip shows the head of an item Rust has whole, and which are
 *  already asking for the rest (`refillQueue`). */
const refilling = new Set<string>();

/**
 * Mirror Rust's queue into the strip, keeping the tab's local items after it.
 *
 * A `queue_changed` delta carries only the head of a long prompt
 * (`truncated`). The strip must never trade the whole text it has for that
 * head (ACP audit finding 78): an Edit, an agent switch and a restart onto a
 * new session all read the strip. So an item the window already holds keeps
 * its text and content, matched by id; an add still on its way (a pending
 * marker) is matched to the first local item Rust now lists whose text it
 * starts with, which is exactly what the cut does. An add Rust does not list
 * yet stays, after Rust's items. An item only a truncated delta has told the
 * window about is fetched whole from a snapshot (`refillQueue`).
 */
function mirrorQueue(s: ChatState, tabId: string, queue: QueuedPrompt[]): void {
  const old = queueItemsOf(s, tabId);
  const byId = new Map<string, QueueItem>();
  for (const q of old) if (q.id && !q.id.startsWith(PENDING_QUEUE_ID)) byId.set(q.id, q);
  const pending = old.filter((q) => q.id?.startsWith(PENDING_QUEUE_ID));
  const local = old.filter((q) => q.id === null);
  let preview = false;
  const mirrored = queue.map((w): QueueItem => {
    const known = byId.get(w.id);
    if (known) return { ...known, id: w.id };
    if (w.origin.kind === "local") {
      const at = pending.findIndex((p) => p.text.startsWith(w.text));
      if (at >= 0) {
        const [mine] = pending.splice(at, 1);
        return { ...mine, id: w.id };
      }
    }
    if (w.truncated) preview = true;
    return { text: w.text, id: w.id, content: null };
  });
  writeQueue(s, tabId, [...mirrored, ...pending, ...local]);
  if (preview) refillQueue(s, tabId);
}

/** Ask Rust for the whole text of the strip's cut items. Off the reducer: a
 *  snapshot is an IPC round trip, applied through `fillQueueText`. */
function refillQueue(s: ChatState, tabId: string): void {
  const session = s.sessions[tabId];
  if (!session?.acpAgentId || !session.acpSessionId || refilling.has(tabId)) return;
  const key = { agent_id: session.acpAgentId, session_id: session.acpSessionId };
  refilling.add(tabId);
  queueMicrotask(() => {
    agents
      .snapshotMeta(key)
      .then((snap) => {
        if (snap.queue) useChatStore.getState().actions.fillQueueText(tabId, snap.queue);
      })
      .catch((err) => console.warn("could not read the whole queue:", err))
      .finally(() => refilling.delete(tabId));
  });
}

/**
 * Deltas for a tab whose transcript is still loading, by tab id, in arrival
 * order. A resume binds the tab before the agent has replayed the session
 * (`open-thread.ts`), so anything announced in that window used to land on a
 * tab still showing its skeleton: a half-built transcript that spent the
 * window's one-time settle (`use-transcript-window.ts`) before the real paint
 * arrived, and was then replaced wholesale by it. They wait here instead, and
 * `setTranscriptLoading(tab, false)` applies the ones the painting snapshot
 * had not seen. Module state, not store state: nothing renders from it.
 */
const heldForPaint = new Map<string, AgentDelta[]>();
/** The `as_of_seq` of the snapshot that painted a loading tab (see
 *  `replaceMessages`), until its held deltas are released. */
const paintedThrough = new Map<string, number>();

/**
 * Which of a session's agent-advertised lists its live agent has already
 * delivered non-empty, as `${acpSessionId}:${list}`. It is what tells the two
 * kinds of empty answer apart (ACP audit finding 39): an empty snapshot of a session that
 * already said it has commands/models/knobs is a stale read and is ignored,
 * while an empty answer from a session that never said otherwise is the
 * agent's verdict and replaces whatever was there — a list seeded from the
 * per-agent cache, or another session's. Keyed by ACP session, so a rebind
 * starts unheard. Module state, not store state: nothing renders from it.
 */
type AdvertisedList = "modes" | "models" | "commands" | "options";
const heardLive = new Set<string>();

function noteHeard(acpSessionId: string | undefined, list: AdvertisedList, n: number): void {
  if (acpSessionId && n > 0) heardLive.add(`${acpSessionId}:${list}`);
}

/** Whether an empty answer for `list` is a stale read rather than a verdict.
 *  An unbound tab has no session to answer for it, so its list is kept. */
function emptyIsStale(acpSessionId: string | undefined, list: AdvertisedList): boolean {
  return !acpSessionId || heardLive.has(`${acpSessionId}:${list}`);
}

function forgetHeld(tabId: string): void {
  heldForPaint.delete(tabId);
  paintedThrough.delete(tabId);
}

/** Hold `env` if its tab is still loading its transcript. */
function holdForPaint(s: ChatState, env: AgentDelta): boolean {
  const tid = findTabByAcpSession(s.sessions, env.session_id, env.agent_id);
  if (!tid || !s.sessions[tid].transcriptLoading) return false;
  const held = heldForPaint.get(tid);
  if (held) held.push(env);
  else heldForPaint.set(tid, [env]);
  return true;
}

/**
 * The chat tab running `acpSessionId`, or null.
 *
 * ACP scopes a session id to its connection, so two agents can both answer
 * `"1"` (#86). Given `agentId` (the host's handle, `acpAgentId`), a tab bound
 * to another agent is never the answer; a tab whose agent is not known yet
 * (restored, not rebound) still is, after any tab bound to that agent.
 */
export function findTabByAcpSession(
  sessions: Record<string, ChatSession>,
  acpSessionId: string,
  agentId?: string,
): string | null {
  let unbound: string | null = null;
  for (const [tid, s] of Object.entries(sessions)) {
    if (s.acpSessionId !== acpSessionId) continue;
    if (!agentId || s.acpAgentId === agentId) return tid;
    if (!s.acpAgentId) unbound ??= tid;
  }
  return unbound;
}

/**
 * When a permission request carries a plan (Claude Code ExitPlanMode), persist
 * it to the per-project plans store together with the user message that
 * triggered it and a timestamp. Fire-and-forget; never blocks the permission
 * UI. Rust dedups by (session, plan) so a re-delivered permission is a no-op.
 */
async function capturePlanIfPresent(
  req: PendingPermission,
  sessions: Record<string, ChatSession>,
): Promise<void> {
  const plan = extractPlanMarkdown(req.toolCall);
  if (!plan) return;

  const tabId = findTabByAcpSession(sessions, req.acpSessionId, req.agentId);
  const session = tabId ? sessions[tabId] : undefined;

  // Original user message = the most recent user message in the session.
  // Prefer the clean prose (atlas-context wrapper stripped) for display.
  let userMessage = "";
  if (session) {
    for (let i = session.messages.length - 1; i >= 0; i--) {
      const m = session.messages[i];
      if (m.role === "user") {
        userMessage = m.atlasProse ?? m.content;
        break;
      }
    }
  }

  const { projectPathForTab } = await import("../lib/tab-project");
  const projectPath = (tabId ? projectPathForTab(tabId) : null) ?? session?.workingDirectory;
  if (!projectPath) return;

  const record: PlanRecord = {
    id: `plan-${req.requestId}`,
    sessionId: req.acpSessionId ?? null,
    sessionTitle: session?.title ?? null,
    userMessage,
    plan,
    timestamp: new Date().toISOString(),
  };

  try {
    await invoke("plans_append", { projectPath, record });
    // Let an open Plans panel refresh without re-opening.
    emitWindowEvent("atlas:plan-saved");
  } catch {
    /* non-fatal — persistence failure shouldn't affect the permission flow */
  }
}

let messageCounter = 0;
function nextMessageId(): string {
  messageCounter += 1;
  return `msg-${Date.now()}-${messageCounter.toString(36)}`;
}

function makeAssistantTextMessage(content: string): ChatMessage {
  return {
    id: nextMessageId(),
    role: "assistant",
    content,
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: new Date().toISOString(),
    mode: "text",
  };
}

function makeAssistantThinkingMessage(thinking: string): ChatMessage {
  return {
    id: nextMessageId(),
    role: "assistant",
    content: "",
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: new Date().toISOString(),
    mode: "thinking",
    thinking,
  };
}

function makeAssistantToolMessage(toolCall: ChatMessage["toolCalls"][number]): ChatMessage {
  return {
    id: nextMessageId(),
    role: "assistant",
    content: "",
    toolCalls: [toolCall],
    fileChanges: [],
    plan: null,
    timestamp: new Date().toISOString(),
    mode: "tool",
  };
}

/** Find the message + tool call entry across all messages by toolCallId. */
function findToolCall(
  session: ChatSession,
  toolCallId: string,
): { msg: ChatMessage; tc: ChatMessage["toolCalls"][number] } | null {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    const tc = m.toolCalls.find((t) => t.id === toolCallId);
    if (tc) return { msg: m, tc };
  }
  return null;
}

/**
 * Whether this tool call id is certainly new to the session, answered without
 * `findToolCall`'s scan.
 *
 * That scan runs on drafts, so proving an id ABSENT walks every message of the
 * session through immer: a proxy per message, per `toolCalls` array and per
 * call, all to be finalized again. It is the common case, too: every call's
 * first sighting. The state the batch started from is plain frozen data: still
 * one pass over the session's calls, but with nothing allocated and nothing
 * for immer to finalize.
 *
 * `added` closes the gap between the two: the calls this batch has already
 * appended, which the starting state cannot know about. The two deltas that
 * add a call (`tool_call_upserted`, and `message_appended` for a message that
 * arrives carrying some) both record it there, so "absent at the start and
 * not added since" is exact. A third one must do the same. Anything this
 * cannot vouch for answers false, and the caller scans as before.
 */
function isNewToolCall(session: ChatSession, toolCallId: string, added?: Set<string>): boolean {
  if (!added || added.has(toolCallId) || !isDraft(session)) return false;
  const before = original(session);
  if (!before) return false;
  return !before.messages.some((m) => m.toolCalls.some((t) => t.id === toolCallId));
}

/** ACP's `StopReason` values: each ends a turn normally. */
const NORMAL_STOP_REASONS = new Set([
  "end_turn",
  "cancelled",
  "max_tokens",
  "max_turn_requests",
  "refusal",
]);

/** Human-readable end-of-turn notice for a stop reason, or null when the
 *  outcome speaks for itself (P2.4).
 *
 *  Exported for tests. The strings say what HAPPENED and what to do, because
 *  the raw ACP token (`max_turn_requests`) means nothing to a user. */
export function stopReasonNotice(stopReason: string): string | null {
  switch (stopReason) {
    case "max_tokens":
      return "(the reply was cut off — the model hit its output token limit)";
    case "max_turn_requests":
      return "(the agent stopped — it hit the maximum number of model requests for one turn)";
    case "refusal":
      // ACP: the refused prompt and everything after it are left out of the
      // next prompt, and the client should show that (audit #21).
      return "(the agent declined this request — it, and anything after it in this turn, won't be in what the agent sees next)";
    // `end_turn` is a normal finish; `cancelled` already renders its own UI.
    // Anything unknown is left alone rather than guessed at — inventing a
    // description for a stop reason a future adapter added would be worse than
    // saying nothing.
    default:
      return null;
  }
}

/**
 * Freeze a held sleep (`sleptMidTurn`) onto the turn's trailing assistant
 * message as its `interruption` — the way `usage` and `turnSummary` are frozen
 * at turn end, so the transcript draws it after the reply it may have cut
 * short. A turn the sleep cut off before any output has no such message, so
 * one is added with no content: it renders nothing but the record.
 */
function recordInterruption(
  session: ChatSession,
  outcome: TurnInterruption["outcome"],
  error?: string,
): void {
  const slept = session.sleptMidTurn;
  if (!slept) return;
  session.sleptMidTurn = undefined;
  const interruption: TurnInterruption = {
    cause: "sleep",
    sleptSecs: slept.sleptSecs,
    outcome,
    ...(error ? { error } : {}),
  };
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === "user") break;
    if (m.role === "assistant") {
      m.interruption = interruption;
      return;
    }
  }
  const host = makeAssistantTextMessage("");
  host.interruption = interruption;
  session.messages.push(host);
}

/** An agent session's title until the agent names it. Atlas calls them
 *  sessions — never chats or threads — and so does every label built on this. */
export const UNTITLED_SESSION = "New session";

export const useChatStore = create<ChatState & ChatActions>()(
  immer((set, get) => ({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    queueIds: {},
    queueContent: {},
    drafts: {},
    activeSessionId: null,
    agentStartingStatus: {},
    actions: {
      // No explicit agent → the last one the user picked, else the
      // `defaultAgent` setting, else Atlas Agent (`agentForNewSession`).
      // Never hard-code an ACP agent here: on a fresh install that produces
      // a permanently disabled composer with no way to reach another agent.
      createSession: (tabId, agentType = agentForNewSession(), pendingRestore) =>
        set((s) => {
          if (s.sessions[tabId]) return;
          s.sessions[tabId] = {
            id: tabId,
            title: UNTITLED_SESSION,
            messages: [],
            agentType,
            model: "",
            status: "idle",
            workingDirectory: "",
            tasks: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            // Permission mode is a Claude Code feature; Codex drives its
            // modes generically via ACP (acpCurrentMode).
            claudePermissionMode: startsOnClaudeModeList(agentType) ? "default" : undefined,
            claudePermissionModeExplicit: false,
            acpModeExplicit: false,
            ...(pendingRestore ? { pendingRestore } : {}),
            // Optimistically pre-fill a non-Claude agent's mode picker from the
            // persisted cache so switching feels instant; mark pending until the
            // real session confirms (the picker shows a loading state).
            ...(!startsOnClaudeModeList(agentType)
              ? (() => {
                  const cached = loadCachedAcpModes(agentType);
                  return {
                    acpAvailableModes: cached?.availableModes ?? [],
                    acpCurrentMode: cached?.currentMode ?? undefined,
                    acpModesPending: true,
                  };
                })()
              : {}),
            // Models apply to BOTH Claude Code and Codex (ACP `session/new`
            // model picking). Pre-fill from cache; empty for the native agent.
            ...(() => {
              const m = loadCachedAcpModels(agentType);
              return m
                ? {
                    // The list only — the current model belongs to a session,
                    // not to the agent (see `acp-models-cache`).
                    acpAvailableModels: m.availableModels,
                  }
                : {};
            })(),
          };
          s.activeSessionId = tabId;
          // Restore the user's last explicit mode pick for this agent so it
          // survives restarts (marks it explicit; create pushes it after
          // validating against the agent's advertised modes).
          applyPersistedModePref(s.sessions[tabId], agentType);
        }),
      switchChatAgent: (tabId, agentType) =>
        set((s) => {
          // Store-boundary guard: agentType feeds plugin resolution,
          // localStorage cache keys, and Tauri invoke args — a non-string
          // (a leaked DOM event, once) poisons all three. Mirrors the
          // total-by-construction rule on agentMeta().
          if (typeof agentType !== "string") return;
          const sess = s.sessions[tabId];
          if (!sess) return;
          // Drop any pending permissions that belonged to the old binding so a
          // stale request from the previous agent can't render under the new
          // one (agents are pooled per plugin, so the process keeps running —
          // we only clear THIS session's queue, not the agent).
          if (sess.acpSessionId) delete s.pendingPermissions[sess.acpSessionId];
          dropBackendSession(sess);
          sess.agentType = agentType;
          sess.claudePermissionMode = startsOnClaudeModeList(agentType) ? "default" : undefined;
          sess.claudePermissionModeExplicit = false;
          sess.acpModeExplicit = false;
          // Drop the old ACP binding so the chat panel's mount effect re-binds
          // to the newly chosen agent (deps watch acpSessionId + agentType).
          sess.acpAgentId = undefined;
          sess.acpSessionId = undefined;
          sess.acpCurrentMode = undefined;
          sess.acpCurrentModel = undefined;
          // The old agent's consumption is not the new one's either.
          forgetSessionUsage(sess);
          // A dead or removed PREVIOUS agent is not this one's state: the
          // banner that offered "Switch agent" must not outlive the switch.
          sess.disconnected = undefined;
          sess.updatedTo = undefined;
          sess.bindError = undefined;
          sess.unrestoredModeId = undefined;
          // The provider only applies to the native agent; clear it so the
          // composer re-defaults from BYOK keys if the native agent is chosen.
          sess.nativeProvider = undefined;
          // Slash commands are per-agent (ACP `available_commands_update`);
          // the old agent's list must not survive the switch or it renders
          // under the new agent until its own update lands.
          sess.availableCommands = undefined;
          if (onClaudeModeList(sess)) {
            // Atlas's own mode record: clear the old agent's advertised modes
            // so no stale pill.
            sess.acpAvailableModes = [];
            sess.acpModesPending = false;
          } else {
            // Optimistically seed from cache so the pill appears instantly with
            // the right modes; keep pending until the new binding confirms. A
            // cache miss (first-ever use) shows a pure loading state.
            const cached = loadCachedAcpModes(agentType);
            sess.acpAvailableModes = cached?.availableModes ?? [];
            sess.acpCurrentMode = cached?.currentMode ?? undefined;
            sess.acpModesPending = true;
          }
          // Same restore as createSession: the agent's last explicit pick
          // wins over the optimistic cache seed above.
          applyPersistedModePref(sess, agentType);
          // Models apply to both agents — seed from cache (empty for the native agent).
          const cachedModels = loadCachedAcpModels(agentType);
          sess.acpAvailableModels = cachedModels?.availableModels ?? [];
          sess.acpCurrentModel = undefined;
          // The advertised knobs are per-agent too, and this was the one
          // per-agent list the switch never reset — so the Options pill kept
          // rendering the PREVIOUS agent's state until the new binding spoke.
          // Two ways that showed: a settled "Default" carried over from an
          // agent with no knobs and then snapped to "Options" with no loading
          // in between, and (worse) another agent's knobs stayed clickable,
          // writing `set_config_option` for ids the new agent never advertised.
          //
          // Same posture as the modes seed above: optimistically adopt the new
          // agent's cache — including a cached empty list, which is a real
          // "this agent has no knobs" verdict — and leave it `undefined` on a
          // miss, which is exactly the pill's loading state.
          sess.acpConfigOptions = loadCachedAcpConfigOptions(agentType) ?? undefined;
        }),
      setSessionAgentType: (tabId, agentType) =>
        set((s) => {
          const sess = s.sessions[tabId];
          if (!sess) return;
          if (sess.agentType !== agentType) {
            sess.agentType = agentType;
            // Per-agent ACP command list — stale across an agent change.
            sess.availableCommands = undefined;
            // And the per-agent knob list, for the same reason. The resume
            // snapshot's own `setAcpConfigOptions` lands right after; this is
            // what the pill shows meanwhile, and it must not be the previous
            // agent's.
            sess.acpConfigOptions = loadCachedAcpConfigOptions(agentType) ?? undefined;
            sess.claudePermissionMode = startsOnClaudeModeList(agentType) ? "default" : undefined;
            sess.claudePermissionModeExplicit = false;
            sess.acpModeExplicit = false;
            sess.unrestoredModeId = undefined;
            if (onClaudeModeList(sess)) {
              // Atlas's own mode record — clear any stale picker state left
              // by the previously-selected agent so no ghost mode pill shows.
              sess.acpAvailableModes = [];
              sess.acpModesPending = false;
              sess.acpCurrentMode = undefined;
            } else {
              // The previous agent's mode ids mean nothing to this one. Seed
              // from this agent's cache (as `switchChatAgent` does) so the
              // pick below is validated against the right list; the resume
              // snapshot's `setAcpModes` confirms it right after. No pending
              // flag: nothing on the resume path would clear it.
              const cached = loadCachedAcpModes(agentType);
              sess.acpAvailableModes = cached?.availableModes ?? [];
              sess.acpCurrentMode = cached?.currentMode ?? undefined;
            }
            // Same restore as createSession / switchChatAgent: after a
            // restart every resumed ACP thread comes through here (see
            // `resume-mode.ts`). The ACP binding (acpAgentId / acpSessionId)
            // is left intact — this only relabels.
            applyPersistedModePref(sess, agentType);
          }
          // Reseed model state even when the agent type is UNCHANGED. This
          // action only runs from the resume flow, where the tab is being
          // rebound to a different conversation — the previous conversation's
          // `acpCurrentModel` would render raw on the picker and get stamped
          // onto the resumed session's new messages (the wrong-label bug,
          // same-agent variant). The resume snapshot's real models/current
          // land right after via `setAcpModels` (which only seeds current
          // when unset, so clearing here is what lets it take effect).
          sess.nativeProvider = undefined;
          const cachedModels = loadCachedAcpModels(agentType);
          sess.acpAvailableModels = cachedModels?.availableModels ?? [];
          sess.acpCurrentModel = undefined;
        }),
      setActiveSession: (id) =>
        set((s) => {
          s.activeSessionId = id;
        }),
      addMessage: (sessionId, role, content, attachments, trustedMentionPaths) => {
        const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        let added = false;
        set((s) => {
          const session = s.sessions[sessionId];
          if (!session) return;
          added = true;
          // Pre-split for user-composed messages so MessageItem
          // doesn't run regex on every render. No-op for assistant /
          // system messages (they don't carry the Atlas-context
          // suffix).
          const split = role === "user" ? splitAtlasContext(content) : null;
          const msg: ChatMessage = {
            id,
            role,
            content,
            ...(role === "user" ? { clientMessageId: id } : {}),
            ...(attachments?.length ? { attachments } : {}),
            ...(role === "user" && trustedMentionPaths?.length ? { trustedMentionPaths } : {}),
            toolCalls: [],
            fileChanges: [],
            plan: null,
            timestamp: new Date().toISOString(),
            ...(split && split.context !== null
              ? {
                  atlasProse: split.prose,
                  atlasContext: split.context,
                  atlasContextBlockCount: split.blockCount,
                }
              : {}),
          };
          session.messages.push(msg);
          session.updatedAt = new Date().toISOString();
          if (role === "user") {
            // Stored PRE-stripped and PRE-truncated: every consumer is a
            // preview (≤80 chars after their own stripInjectedContext,
            // which is idempotent), and the sidebar's sessionsSignature
            // selector concatenates this field on EVERY store write — an
            // untruncated multi-KB paste made that O(paste bytes) per
            // keystroke and per streaming frame, for every mounted sidebar.
            if (!session.firstUserContent) {
              session.firstUserContent = firstUserPreview(split ? split.prose : content);
            }
            session.userMessageCount = (session.userMessageCount ?? 0) + 1;
            // The ONE row allowed to play the bubble entrance. Resume /
            // replay paths stamp messages "now", so a timestamp heuristic
            // animated whole restored threads (and every row mounted during
            // an early scroll) — id-scoping keeps it to the actual send.
            session.justSentMessageId = msg.id;
          }
        });
        return added ? id : undefined;
      },
      addInjectedPrompt: (acpSessionId, text, injected, at) =>
        set((s) => {
          const tabId = findTabByAcpSession(s.sessions, acpSessionId);
          if (!tabId) return;
          const session = s.sessions[tabId];
          session.messages.push({
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            role: "user",
            content: text,
            toolCalls: [],
            fileChanges: [],
            plan: null,
            timestamp: at,
            injected,
          });
          session.updatedAt = new Date().toISOString();
        }),
      appendToolCall: (sessionId, toolName, input) =>
        set((s) => {
          const session = s.sessions[sessionId];
          if (!session) return;
          for (let i = session.messages.length - 1; i >= 0; i--) {
            if (session.messages[i].role === "assistant") {
              session.messages[i].toolCalls.push({
                id: `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                toolName,
                kind: null,
                arguments: input,
                result: null,
                status: "completed",
                duration: null,
              });
              break;
            }
          }
        }),
      updateLastAssistantMessage: (sessionId, content) =>
        set((s) => {
          const session = s.sessions[sessionId];
          if (!session) return;
          for (let i = session.messages.length - 1; i >= 0; i--) {
            if (session.messages[i].role === "assistant") {
              session.messages[i].content = content;
              break;
            }
          }
        }),
      updateSessionStatus: (sessionId, status) =>
        set((s) => {
          const session = s.sessions[sessionId];
          if (session) session.status = status;
        }),
      setDisconnected: (sessionId, on) =>
        set((s) => {
          const session = s.sessions[sessionId];
          if (!session) return;
          session.disconnected = on || undefined;
          if (!on) session.updatedTo = undefined;
        }),
      setStopping: (sessionId, on) =>
        set((s) => {
          const session = s.sessions[sessionId];
          if (session) session.stopping = on || undefined;
        }),
      // Killing an agent drops its connection, and the exit-watch task that
      // would have produced `agent_disconnected` goes with it. So nothing
      // arrives to end the turn: this records what that delta does, plus the
      // turn terminal Rust normally emits ahead of it (`agent_disconnected`
      // above is written assuming the status is already error). Without the
      // status and tool-call reset the composer keeps offering Stop for a
      // process that no longer exists, underneath a Restart banner.
      //
      // The transcript is deliberately untouched — the conversation survives
      // and `acpSessionId` is what a restart resumes from.
      noteAgentKilled: (sessionId) =>
        set((s) => {
          const session = s.sessions[sessionId];
          if (!session) return;
          session.status = "error";
          session.stopping = undefined;
          session.retryStatus = undefined;
          for (const message of session.messages) {
            for (const tool of message.toolCalls)
              if (tool.status === "pending" || tool.status === "running") tool.status = "failed";
          }
          session.inflightToolIds = undefined;
          session.disconnected = true;
        }),
      setPendingSend: (sessionId, pending) =>
        set((s) => {
          const session = s.sessions[sessionId];
          if (session) session.pendingSend = pending;
        }),
      setSessionTitle: (sessionId, title) =>
        set((s) => {
          const session = s.sessions[sessionId];
          if (session) session.title = title;
        }),
      setTranscriptLoading: (sessionId, loading) => {
        // Whatever was held belongs to the load this ends (or to one a new
        // load supersedes, which starts over).
        const held = heldForPaint.get(sessionId);
        const floor = paintedThrough.get(sessionId);
        heldForPaint.delete(sessionId);
        paintedThrough.delete(sessionId);
        const advertised: AdvertisedOptions[] = [];
        set((s) => {
          const session = s.sessions[sessionId];
          if (!session) return;
          session.transcriptLoading = loading;
          if (loading || !held) return;
          // In arrival order, after the paint: only what the snapshot that
          // painted had not seen yet.
          const added = new Set<string>();
          for (const env of held) {
            if (floor !== undefined && env.seq <= floor) continue;
            applyDeltaToDraft(s, env, added, advertised);
          }
        });
        advertised.forEach(cacheAdvertisedOptions);
      },
      setResumePending: (sessionId, pending) =>
        set((s) => {
          const session = s.sessions[sessionId];
          if (session) session.resumePending = pending;
        }),
      setPendingRestore: (tabId, sessionId) =>
        set((s) => {
          const session = s.sessions[tabId];
          if (session) session.pendingRestore = sessionId;
        }),
      clearSession: (sessionId) => set((s) => resetToNewChat(s, sessionId)),
      setBindCwd: (tabId, cwd) =>
        set((s) => {
          const session = s.sessions[tabId];
          if (session) session.bindCwd = cwd;
        }),
      cycleClaudePermissionMode: (sessionId) => {
        const session = get().sessions[sessionId];
        if (!session) return;
        const i = CLAUDE_PERMISSION_MODES.indexOf(session.claudePermissionMode ?? "default");
        const next = CLAUDE_PERMISSION_MODES[(i + 1) % CLAUDE_PERMISSION_MODES.length];
        void sessionConfiguration.pick(sessionId, KNOBS.claudeMode, next);
      },
      hydrateClaudePermissionMode: (sessionId, mode) =>
        set((s) => {
          const session = s.sessions[sessionId];
          if (!session) return;
          session.claudePermissionMode = mode;
          session.claudePermissionModeExplicit = false;
        }),
      setClaudePermissionMode: (sessionId, mode) =>
        void sessionConfiguration.pick(sessionId, KNOBS.claudeMode, mode),
      applyExitPlanSelection: (sessionId, optionId, override) => {
        const session = get().sessions[sessionId];
        if (!session) return;
        // Keyed on the approval prompt's shape, not the agent (ADR-0002, ACP
        // audit finding 45): only a plan-approval option id names a mode, and
        // the permission card offers its own bypass action on that same
        // shape, so an override only ever arrives with one. Which record the
        // mode lands in is the session's own (`KNOBS.planExitMode`).
        if (!exitPlanModeForOption(optionId)) return;
        const mode = override ?? exitPlanModeForOption(optionId);
        if (!mode || !KNOBS.planExitMode.offers(session, mode)) return;
        // A clear-context choice restarts the session; the adapter publishes
        // the mode itself once the replacement is up, and a set_mode sent
        // into the restart is refused. The plain choices are applied by the
        // CLI alone — push so the adapter's own bookkeeping (which builds the
        // NEXT approval prompt from it) agrees, and so an override actually
        // takes effect.
        if (exitPlanOptionRestartsSession(optionId) && !override) {
          set((s) => {
            const sess = s.sessions[sessionId];
            if (sess) KNOBS.planExitMode.mirror?.pick(sess, mode);
          });
          return;
        }
        void sessionConfiguration.pick(sessionId, KNOBS.planExitMode, mode);
      },
      setAcpModes: (sessionId, currentMode, availableModes, sourceAgentType) => {
        const at = get().sessions[sessionId]?.agentType;
        // Modes are per-agent, and a snapshot can outlive the binding it came
        // from: `setSessionAgentType` relabels a tab WITHOUT clearing its ACP
        // binding, so a snapshot fetched off the previous agent's still-bound
        // session can land after the tab already says "codex". Applying it
        // wrote Claude's modes into the Codex picker AND its cache, leaving
        // Codex on a mode id it doesn't have — the pill fell back to "Mode"
        // and every pick was rejected by the agent. Callers pass the agent the
        // snapshot actually came from (its `plugin_id`); a mismatch is stale
        // by definition, so drop it rather than reconcile it.
        if (sourceAgentType && at && sourceAgentType !== at) return;
        const acp = get().sessions[sessionId]?.acpSessionId;
        // An empty list from a session that never advertised modes is the
        // agent's answer, and the cached list must go with it (ACP audit finding 39): kept, it
        // seeded the next session's picker with modes no agent offers.
        const clearCache = availableModes.length === 0 && !emptyIsStale(acp, "modes");
        noteHeard(acp, "modes", availableModes.length);
        set((s) => {
          const session = s.sessions[sessionId];
          if (!session) return;
          session.acpAvailableModes = availableModes;
          // Don't clobber a user-driven mode the store already reflects when
          // the snapshot carries no current (null) — only seed when present.
          if (currentMode) session.acpCurrentMode = currentMode;
          // Whatever we end up with must be one of THIS list's modes. An
          // optimistically-seeded (cached) current that the live agent doesn't
          // advertise is exactly how the picker got stuck showing "Mode":
          // `find` misses, the label falls back, and nothing ever clears it.
          if (
            availableModes.length > 0 &&
            !availableModes.some((m) => m.id === session.acpCurrentMode)
          ) {
            session.acpCurrentMode = currentMode ?? availableModes[0].id;
          }
          // The real session has now confirmed its modes — drop the loading
          // state regardless of whether they matched the optimistic cache.
          if (availableModes.length > 0) session.acpModesPending = false;
        });
        // Persist the confirmed modes so the next switch to this agent is
        // instant. Done outside the immer pass (side effect, not state).
        if (availableModes.length > 0 && at && !onClaudeModeList(get().sessions[sessionId])) {
          saveCachedAcpModes(at, {
            currentMode: currentMode ?? null,
            availableModes,
          });
        } else if (clearCache && at) {
          clearCachedAcpModes(at);
        }
      },
      setAcpModesPending: (sessionId, pending) =>
        set((s) => {
          const session = s.sessions[sessionId];
          if (session) session.acpModesPending = pending;
        }),
      setAcpMode: (sessionId, modeId) =>
        void sessionConfiguration.pick(sessionId, KNOBS.acpMode, modeId),
      dropAcpModePick: (sessionId) =>
        set((s) => {
          const session = s.sessions[sessionId];
          if (session) session.acpModeExplicit = false;
        }),
      dropAcpModelPick: (sessionId) =>
        set((s) => {
          const session = s.sessions[sessionId];
          if (session) session.acpCurrentModel = undefined;
        }),
      setUnrestoredMode: (sessionId, modeId) =>
        set((s) => {
          const session = s.sessions[sessionId];
          if (session) session.unrestoredModeId = modeId;
        }),
      clearElicitation: (sessionId, requestId) =>
        set((s) => {
          const session = s.sessions[sessionId];
          if (session) closeElicitation(session, requestId);
        }),
      setAcpConfigOption: async (sessionId, configId, value) => {
        await sessionConfiguration.pick(sessionId, KNOBS.option(configId), value);
      },
      setAcpAvailableCommands: (sessionId, commands, sourceAgentType) => {
        // Same stale-snapshot hazard `setAcpModes`/`setAcpConfigOptions` are
        // guarded for, with a worse symptom: a tab relabelled to another
        // agent keeps its old binding until the rebind lands, so a snapshot
        // fetched off that binding writes the OLD agent's commands under the
        // new label. Claude advertises its *skills* as commands, which is
        // how the native agent's picker showed the user's Claude skills and
        // none of its own commands.
        const at = get().sessions[sessionId]?.agentType;
        if (sourceAgentType && at && sourceAgentType !== at) return;
        set((s) => {
          const session = s.sessions[sessionId];
          if (!session) return;
          // An empty snapshot must not erase a list this session's agent
          // already delivered; it MAY end the picker's loading state
          // (undefined→[]) for agents that genuinely advertise nothing, and it
          // does replace a list no live answer of this session stands behind
          // (ACP audit finding 39).
          if (
            commands.length === 0 &&
            (session.availableCommands?.length ?? 0) > 0 &&
            emptyIsStale(session.acpSessionId, "commands")
          ) {
            return;
          }
          noteHeard(session.acpSessionId, "commands", commands.length);
          session.availableCommands = commands;
        });
      },
      setAcpConfigOptions: (tabId, options, sourceAgentType) => {
        const at = get().sessions[tabId]?.agentType;
        // Same stale-snapshot hazard `setAcpModes` was versioned for: a tab
        // relabelled to another agent keeps its old binding, so a snapshot
        // fetched off that binding can land under the new label — and would
        // write the OLD agent's knobs into the new agent's pill and cache.
        // Callers pass the agent the snapshot actually came from; a mismatch
        // is stale by definition, so drop it.
        if (sourceAgentType && at && sourceAgentType !== at) return;
        set((s) => {
          const session = s.sessions[tabId];
          if (!session) return;
          // An empty snapshot must not erase a list this session's agent
          // already delivered; it MAY end the undefined loading state (this
          // agent advertises no knobs), and it replaces a list only the cache
          // stood behind (ACP audit finding 39). Same rule as the commands list above.
          if (
            options.length === 0 &&
            (session.acpConfigOptions?.length ?? 0) > 0 &&
            emptyIsStale(session.acpSessionId, "options")
          ) {
            return;
          }
          noteHeard(session.acpSessionId, "options", options.length);
          session.acpConfigOptions = options;
        });
        // Survive the next restart (#36) — modes and models already do;
        // without this the Options pill died with the process. Outside the
        // immer pass (side effect, not state), like the sibling caches.
        //
        // Cache what actually LANDED, not what was passed: the guard above may
        // have rejected this call, and an empty list that survived it is a real
        // verdict ("this agent has no knobs") the pill renders instantly next
        // launch instead of spinning for it.
        //
        // Note there is no agent-id condition here. `claude-code` used to be
        // excluded, which is why the pill took seconds to appear for exactly
        // the agent most people run — a spawn-time snapshot cached nothing, so
        // every cold start waited on a live delta. Capability, never identity
        // (ADR-0002).
        const landed = get().sessions[tabId]?.acpConfigOptions;
        if (at && landed !== undefined) {
          saveCachedAcpConfigOptions(at, landed);
        }
      },
      setAcpModels: (sessionId, currentModel, availableModels) => {
        let clearCache = false;
        set((s) => {
          const session = s.sessions[sessionId];
          if (!session) return;
          // Never clobber a good list with an empty snapshot. A snapshot
          // taken before the agent's config options landed — or from an
          // agent that advertises no model select at all — carries [] while
          // the session may already have the real list, and the picker hides
          // itself whenever the list is empty.
          //
          // That is a stale read only once this session's agent has delivered
          // a list. Before that, an empty answer is the agent's verdict, and a
          // list seeded from the cache (or left by another session) goes, the
          // cached copy with it (ACP audit finding 39).
          if (
            availableModels.length === 0 &&
            (session.acpAvailableModels?.length ?? 0) > 0 &&
            emptyIsStale(session.acpSessionId, "models")
          ) {
            return;
          }
          clearCache = availableModels.length === 0 && !!session.acpSessionId;
          noteHeard(session.acpSessionId, "models", availableModels.length);
          session.acpAvailableModels = availableModels;
          // Only seed the current model from the snapshot when it carries one;
          // never clobber a user-driven selection the store already reflects.
          if (currentModel && !session.acpCurrentModel) {
            session.acpCurrentModel = currentModel;
          }
        });
        // Persist for instant pre-fill on the next switch/resume (ACP
        // `session/load` doesn't re-advertise models).
        const at = get().sessions[sessionId]?.agentType;
        if (availableModels.length > 0 && at) {
          saveCachedAcpModels(at, { availableModels });
        } else if (clearCache && at) {
          clearCachedAcpModels(at);
        }
      },
      setAcpModelsForAgent: (agentType, availableModels) => {
        set((s) => {
          for (const session of Object.values(s.sessions)) {
            if (session.agentType !== agentType) continue;
            session.acpAvailableModels = availableModels;
          }
        });
        if (availableModels.length > 0) {
          saveCachedAcpModels(agentType, { availableModels });
        }
      },
      setAcpModel: (sessionId, modelId) =>
        void sessionConfiguration.pick(sessionId, KNOBS.model, modelId),
      setNativeEffort: (sessionId, effort) =>
        void sessionConfiguration.pick(sessionId, KNOBS.effort, effort),
      replaceMessages: (sessionId, messages, asOfSeq) =>
        set((s) => {
          const session = s.sessions[sessionId];
          if (!session) return;
          if (asOfSeq !== undefined) paintedThrough.set(sessionId, asOfSeq);
          const minted = Date.now();
          session.messages = messages.map((m, i) => {
            const split = m.role === "user" ? splitAtlasContext(m.content) : null;
            return {
              id: m.id ?? `msg-${minted}-${i}`,
              role: m.role,
              content: m.content,
              // Keep the agent's own id and outcome when the caller has
              // them. Re-minting both is what made every tool call in a
              // resumed transcript render as succeeded, failed ones included
              // (ATL-220). The fallbacks stand only for a paint path that
              // genuinely has neither.
              toolCalls: (m.toolCalls ?? []).map((tc, j) => ({
                id: tc.id ?? `tc-${Date.now()}-${i}-${j}`,
                toolName: tc.toolName,
                kind: tc.kind ?? null,
                arguments: tc.arguments,
                result: tc.result ?? null,
                status: tc.status ?? ("completed" as const),
                duration: null,
                ...(tc.startedAt !== undefined ? { startedAt: tc.startedAt } : {}),
                ...(tc.endedAt !== undefined ? { endedAt: tc.endedAt } : {}),
                // What the live path keeps (`toChatToolCall`). Dropped here, an
                // edit reported as a diff reopened as a bare "Edit", and a
                // child's calls fell back into its parent's stream (audit #97).
                contentBlocks: tc.contentBlocks,
                locations: tc.locations,
                parentToolCallId: tc.parentToolCallId ?? undefined,
              })),
              // A thought reopened as an empty reply without these (audit #6).
              ...(m.mode ? { mode: m.mode } : {}),
              ...(m.thinking ? { thinking: m.thinking } : {}),
              fileChanges: [],
              plan: null,
              timestamp: m.timestamp ?? new Date().toISOString(),
              ...(m.timestampApproximate ? { timestampApproximate: true } : {}),
              ...(m.role === "assistant" && m.model ? { model: m.model } : {}),
              ...(m.attachments?.length ? { attachments: m.attachments } : {}),
              ...(m.role === "assistant" && m.workedMs !== undefined
                ? { workedMs: m.workedMs }
                : {}),
              ...(m.role === "assistant" && m.stopReason !== undefined
                ? { stopReason: m.stopReason }
                : {}),
              ...(split && split.context !== null
                ? {
                    atlasProse: split.prose,
                    atlasContext: split.context,
                    atlasContextBlockCount: split.blockCount,
                  }
                : {}),
            };
          });
          // Rebuild the adaptive per-turn cards (files read/modified) from the
          // loaded tool calls — turnSummary is runtime-only, so without this a
          // resumed/switched session shows no adaptive card.
          reconstructTurnSummaries(session.messages);
          // Restore the ACP context gauge (not in the on-disk transcript) and
          // re-attach it to the trailing assistant message so its turn card
          // shows the last-known context usage after a switch / restart.
          if (session.acpSessionId) {
            const cachedCtx = loadCachedContextUsage(session.acpSessionId);
            if (cachedCtx) {
              session.contextUsage = cachedCtx;
              for (let i = session.messages.length - 1; i >= 0; i--) {
                if (session.messages[i].role === "assistant") {
                  session.messages[i].contextUsage = { ...cachedCtx };
                  break;
                }
              }
            }
          }
          // Recompute the cached preview/count from the loaded transcript
          // so the sidebar doesn't have to scan messages on every chunk.
          // Same stripped+truncated form as appendMessage (see note there).
          const firstUserRaw = messages.find((m) => m.role === "user")?.content;
          session.firstUserContent =
            firstUserRaw !== undefined
              ? firstUserPreview(splitAtlasContext(firstUserRaw).prose)
              : undefined;
          session.userMessageCount = messages.reduce((n, m) => n + (m.role === "user" ? 1 : 0), 0);
          // Intentionally NOT touching `updatedAt`. This action is called
          // when loading a historical transcript from disk into a tab —
          // viewing isn't activity, so it shouldn't bump the sort order
          // in the sidebar. Real activity (addMessage, applyAcpEvent's
          // streaming chunks, etc.) bumps it elsewhere.
        }),
      hydrateSessionSnapshot: (tabId, status, plan, subagents, live) =>
        set((s) => {
          const session = s.sessions[tabId];
          if (!session) return;
          if (live) hydrateLive(s, tabId, live);
          // Adopt the backend's live status (a still-running session switched
          // back to must show as running, not idle). Live deltas from the
          // still-attached backend take over from here.
          session.status = status;
          // Re-derive the docked live plan from the snapshot (same shape as
          // the `plan_updated` delta). Cleared on the switch-away rebind, so
          // this is what makes an active plan REAPPEAR when switching back.
          session.livePlan = plan.length > 0 ? plan.map(toPlanStep) : undefined;
          // Re-seed the children the same way. This is what makes a resumed
          // or switched-back-to chat show its delegated work as subagents
          // rather than as the bare launching tool calls — the rebind above
          // cleared them, and live deltas only describe what changes FROM
          // here, so a finished child would otherwise never be re-announced.
          //
          // ABSENT and EMPTY are different, and the difference is load-bearing:
          // `agents_snapshot_meta` omits `subagents` exactly as it omits
          // `messages`, so treating absent as empty would wipe a live
          // session's children on every metadata refresh. Only an array that
          // is present — and says the session has none — clears.
          if (subagents) {
            session.subagents =
              subagents.length > 0
                ? Object.fromEntries(subagents.map((child) => [child.toolCallId, child]))
                : undefined;
          }
        }),
      removeSession: (sessionId) => {
        dropBackendSession(get().sessions[sessionId]);
        forgetHeld(sessionId);
        set((s) => {
          // pendingPermissions is keyed by acpSessionId, not tab id — resolve
          // before the session entry goes away (a stale list would resurface
          // as a ghost prompt if the same acp session is later resumed).
          const acp = s.sessions[sessionId]?.acpSessionId;
          if (acp) delete s.pendingPermissions[acp];
          delete s.sessions[sessionId];
          delete s.drafts[sessionId];
          dropQueue(s, sessionId);
          if (s.activeSessionId === sessionId) {
            const keys = Object.keys(s.sessions);
            s.activeSessionId = keys.length > 0 ? keys[0] : null;
          }
        });
      },
      removeSessions: (sessionIds) => {
        for (const id of sessionIds) {
          dropBackendSession(get().sessions[id]);
          forgetHeld(id);
        }
        set((s) => {
          for (const id of sessionIds) {
            // Same acpSessionId-keying note as removeSession above.
            const acp = s.sessions[id]?.acpSessionId;
            if (acp) delete s.pendingPermissions[acp];
            delete s.sessions[id];
            delete s.drafts[id];
            dropQueue(s, id);
            if (s.activeSessionId === id) s.activeSessionId = null;
          }
        });
      },
      resetSessions: () => {
        heldForPaint.clear();
        paintedThrough.clear();
        heardLive.clear();
        set((s) => {
          s.sessions = {};
          s.queues = {};
          s.queueIds = {};
          s.queueContent = {};
          s.drafts = {};
          s.pendingPermissions = {};
          s.activeSessionId = null;
        });
      },
      setDraft: (tabId, text) =>
        set((s) => {
          if (text.length === 0) delete s.drafts[tabId];
          else s.drafts[tabId] = text;
        }),
      clearDraft: (tabId) =>
        set((s) => {
          delete s.drafts[tabId];
        }),
      setTurnSuggestions: (tabId, messageId, turnSeq, patch) =>
        set((s) => {
          const session = s.sessions[tabId];
          if (!session) return;
          // Drop a result belonging to a turn already superseded by a newer
          // send (turnSeq 0 = native/legacy, always current).
          if (turnSeq !== 0 && turnSeq < (session.currentTurnSeq ?? 0)) return;
          const msg = session.messages.find((m) => m.id === messageId);
          if (!msg) return;
          msg.suggestions = {
            turnSeq,
            status: patch.status,
            chips: patch.chips ?? msg.suggestions?.chips ?? [],
          };
        }),
      enqueueMessage: (sessionId, text, mentions, id = null, attachments) =>
        set((s) => {
          writeQueue(s, sessionId, [
            ...queueItemsOf(s, sessionId),
            {
              text: inlineQueuedText(text, mentions),
              id,
              content: {
                text,
                mentions: [...mentions],
                ...(attachments?.length ? { attachments } : {}),
              },
            },
          ]);
        }),
      removeQueueItem: (sessionId, index) =>
        set((s) => {
          if (!s.queues[sessionId]) return;
          writeQueue(
            s,
            sessionId,
            queueItemsOf(s, sessionId).filter((_, i) => i !== index),
          );
        }),
      setQueueItemId: (sessionId, from, to) =>
        set((s) => {
          const items = queueItemsOf(s, sessionId);
          const at = items.findIndex((q) => q.id === from);
          if (at < 0) return;
          // The delta may already have listed the item under `to` without
          // recognising it: the one entry keeps this one's text and content.
          const dup = to === null ? -1 : items.findIndex((q, i) => i !== at && q.id === to);
          if (dup >= 0) {
            items[dup] = { ...items[at], id: to };
            items.splice(at, 1);
          } else {
            items[at] = { ...items[at], id: to };
          }
          writeQueue(s, sessionId, items);
        }),
      setQueueItemIdAt: (sessionId, index, id) =>
        set((s) => {
          const items = queueItemsOf(s, sessionId);
          if (index < 0 || index >= items.length) return;
          items[index] = { ...items[index], id };
          writeQueue(s, sessionId, items);
        }),
      setAllQueueItemsLocal: (sessionId) =>
        set((s) => {
          const items = queueItemsOf(s, sessionId);
          if (!items.length) return;
          writeQueue(
            s,
            sessionId,
            items.map((q) => ({ ...q, id: null })),
          );
        }),
      fillQueueText: (sessionId, queue) =>
        set((s) => {
          const whole = new Map(queue.filter((q) => !q.truncated).map((q) => [q.id, q.text]));
          const items = queueItemsOf(s, sessionId);
          let changed = false;
          const next = items.map((q) => {
            const text = q.id && !q.content ? whole.get(q.id) : undefined;
            if (text === undefined || text === q.text) return q;
            changed = true;
            return { ...q, text };
          });
          if (changed) writeQueue(s, sessionId, next);
        }),
      editQueueItem: (sessionId, index, text) =>
        set((s) => {
          const items = queueItemsOf(s, sessionId);
          if (index < 0 || index >= items.length) return;
          // Rewritten by hand: the text is the prompt now. Images stay.
          const attachments = items[index].content?.attachments;
          items[index] = {
            ...items[index],
            text,
            content: { text, mentions: [], ...(attachments ? { attachments } : {}) },
          };
          writeQueue(s, sessionId, items);
        }),
      shiftQueue: (sessionId) => {
        let head: string | null = null;
        set((s) => {
          const items = queueItemsOf(s, sessionId);
          if (items.length === 0) return;
          head = items[0].text;
          writeQueue(s, sessionId, items.slice(1));
        });
        return head;
      },
      clearQueue: (sessionId) =>
        set((s) => {
          dropQueue(s, sessionId);
        }),
      clearQueueHalt: (sessionId) =>
        set((s) => {
          const session = s.sessions[sessionId];
          if (session) session.queueHalted = undefined;
        }),

      appendAssistantText: (acpSessionId, text) =>
        set((s) => {
          appendTextToDraft(s, acpSessionId, text);
        }),
      appendAssistantThought: (acpSessionId, text) =>
        set((s) => {
          appendThoughtToDraft(s, acpSessionId, text);
        }),
      applyAgentBatch: ({ texts, thoughts, deltas }) => {
        const advertised: AdvertisedOptions[] = [];
        set((s) => {
          // Single immer pass for everything buffered in this frame.
          // Order is: text → thoughts → deltas. Within deltas, wire
          // order is preserved by the caller (`agent-delta-batch.ts`);
          // `tool_call_upserted` events are deduped there before
          // arriving so we never apply the same tool-call id twice.
          for (const { sessionId, text } of texts) {
            appendTextToDraft(s, sessionId, text);
          }
          for (const { sessionId, text } of thoughts) {
            appendThoughtToDraft(s, sessionId, text);
          }
          const addedToolCalls = new Set<string>();
          for (const env of deltas) {
            if (holdForPaint(s, env)) continue;
            applyDeltaToDraft(s, env, addedToolCalls, advertised);
          }
        });
        advertised.forEach(cacheAdvertisedOptions);
      },
      setAcpBinding: (tabId, agentId, acpSessionId, cwd) =>
        set((s) => {
          const session = s.sessions[tabId];
          if (!session) return;
          if (
            session.acpSessionId &&
            (session.acpSessionId !== acpSessionId || session.acpAgentId !== agentId)
          )
            dropBackendSession(session);
          // One agent session, one tab. Every delta goes to the FIRST tab
          // holding the session (`findTabByAcpSession`), so a second holder
          // never hears from it again: its status stays wherever it was, a
          // "running" one forever, and the sidebar, which reads any holder,
          // said "Working" for a turn that had long finished. The tab binding
          // now is the one the user is looking at, so the old holder lets go
          // and becomes a new chat. The agent session itself stays open: it is
          // this tab's now. Another agent's session that happens to share the
          // id is another conversation (#86), and its tab keeps it.
          for (const [otherId, other] of Object.entries(s.sessions)) {
            if (
              otherId !== tabId &&
              other.acpSessionId === acpSessionId &&
              (!other.acpAgentId || other.acpAgentId === agentId)
            ) {
              resetToNewChat(s, otherId, true);
            }
          }
          // A (re)bind points the tab at a DIFFERENT backend session — a
          // freshly spawned SessionActor whose `turn_seq` counter restarts at
          // 1 (turn_seq is not persisted; new / resumed / project-switched
          // sessions all reconstruct it from 0). The frontend `currentTurnSeq`
          // is a monotonic high-water mark that only ratchets UP (see the
          // status handler), so a value retained from the PREVIOUS session —
          // e.g. after ⌥N launches a new session in a new project, or "New
          // Chat" resets the singleton tab in place — would make every
          // terminal of the new session (idle / turn_finished at turn_seq 1)
          // look stale via `isStaleTurn` and get dropped, stranding the
          // composer 'running' forever. Reset the high-water mark (and the
          // previous session's live per-turn scratch) whenever the bound
          // session identity changes.
          //
          // The SAME session id gets a fresh counter too: Rust gives every
          // bind its own record, starting at 0 (`SessionRegistry::bind`), and
          // a rebind after the agent died or was updated keeps the id. Reset
          // only on a changed id, the restarted agent's turns (1, 2, ...) all
          // read as stale behind the old mark, and the tab said "Working"
          // forever (audit #2). A snapshot read after the bind sets the exact
          // value back (`hydrateLive`).
          session.currentTurnSeq = 0;
          session.turnScratch = undefined;
          if (session.acpSessionId !== acpSessionId) {
            session.livePlan = undefined;
            // Per backend session, like the plan: the snapshot for the
            // session being bound re-seeds them (`hydrateSessionSnapshot`),
            // and without this a resumed chat would show the previous
            // binding's children until its own first delta.
            session.subagents = undefined;
            // Usage is per backend session; a different one starts from
            // nothing (its cached context gauge is restored by
            // `replaceMessages`, keyed on the new id).
            forgetSessionUsage(session);
            // The hold belonged to the session that had it (Universal RC's
            // room, the developer toggle). Carried onto a fresh session it
            // would skip the stop-confirm on close and leave a busy agent
            // running headless; Rust re-announces a real hold through the
            // snapshot and `hold_changed`.
            session.held = undefined;
          }
          session.acpAgentId = agentId;
          session.acpSessionId = acpSessionId;
          // A bind that landed supersedes whatever the last one died of.
          session.bindError = undefined;
          // Stamp the session's project root the moment it's bound (the agent
          // was created with this cwd). Without it `workingDirectory` stays ""
          // and the chat never lands in the project "Chats" list / running
          // counts. Callers pass the project path they used for the session.
          if (cwd) session.workingDirectory = cwd;
        }),
      pushPermission: (req) => {
        set((s) => {
          const list = s.pendingPermissions[req.acpSessionId] ?? [];
          s.pendingPermissions[req.acpSessionId] = [...list, req];
        });
        // Persist the plan (if this permission carries one) for the Plans
        // panel — captures every plan made, even if later rejected.
        void capturePlanIfPresent(req, get().sessions);
      },
      popPermission: (acpSessionId, requestId) =>
        set((s) => {
          const list = s.pendingPermissions[acpSessionId];
          if (!list) return;
          const next = list.filter((r) => r.requestId !== requestId);
          if (next.length === 0) delete s.pendingPermissions[acpSessionId];
          else s.pendingPermissions[acpSessionId] = next;
        }),
      clearPermissionsForAgent: (agentId) =>
        set((s) => {
          for (const sid of Object.keys(s.pendingPermissions)) {
            const list = s.pendingPermissions[sid].filter((r) => r.agentId !== agentId);
            if (list.length === 0) delete s.pendingPermissions[sid];
            else s.pendingPermissions[sid] = list;
          }
        }),
      clearPermissionsForSession: (acpSessionId) =>
        set((s) => {
          delete s.pendingPermissions[acpSessionId];
        }),
      applyAgentDelta: (env) => {
        const advertised: AdvertisedOptions[] = [];
        set((s) => {
          if (holdForPaint(s, env)) return;
          applyDeltaToDraft(s, env, new Set(), advertised);
        });
        advertised.forEach(cacheAdvertisedOptions);
      },
      setAgentStartingStatus: (pluginId, status) =>
        set((s) => {
          if (status === null || status === "") {
            if (pluginId in s.agentStartingStatus) delete s.agentStartingStatus[pluginId];
            return;
          }
          if (s.agentStartingStatus[pluginId] !== status) s.agentStartingStatus[pluginId] = status;
        }),
      failPendingBinds: (pluginId, reason) =>
        set((s) => {
          delete s.agentStartingStatus[pluginId];
          for (const [tabId, session] of Object.entries(s.sessions)) {
            if (session.acpSessionId) continue;
            if (pluginIdForAgent(session.agentType) !== pluginId) continue;
            const starting = !!session.pendingSend || session.status === "running";
            if (!starting) continue;
            const held = session.pendingSend;
            if (held) {
              session.pendingSend = undefined;
              requeueHeld(s, tabId, held);
            }
            session.status = "idle";
            session.stopping = undefined;
            session.retryStatus = undefined;
            session.inflightToolIds = undefined;
            session.acpModesPending = false;
            session.disconnected = true;
            if (reason) session.bindError = reason;
          }
        }),
      noteAgentUpdated: (pluginId, version) =>
        set((s) => {
          for (const session of Object.values(s.sessions)) {
            if (pluginIdForAgent(session.agentType) !== pluginId) continue;
            if (!session.acpSessionId) continue;
            session.updatedTo = version;
          }
        }),
      noteAgentRemoved: (pluginId, reason) =>
        set((s) => {
          delete s.agentStartingStatus[pluginId];
          for (const [tabId, session] of Object.entries(s.sessions)) {
            if (pluginIdForAgent(session.agentType) !== pluginId) continue;
            const held = session.pendingSend;
            if (held) {
              session.pendingSend = undefined;
              requeueHeld(s, tabId, held);
            }
            session.status = "idle";
            session.stopping = undefined;
            session.retryStatus = undefined;
            session.inflightToolIds = undefined;
            session.acpModesPending = false;
            session.disconnected = true;
            session.bindError = reason;
          }
        }),
    },
  })),
);

/**
 * Keep every tab's `turnStartedAt` in step with its status: stamped once when
 * the status enters a busy state (running/waiting — a turn paused on a
 * permission is still the same turn), cleared to null when it leaves one.
 *
 * One subscription rather than a stamp at each status write, because the
 * status is written from a dozen places (status / turn_finished / turn_failed
 * deltas, the resume snapshot, kill, disconnect, bind failure…) and a writer
 * that forgot the stamp would leave a timer counting forever. Each pass reads
 * a handful of scalars and writes only on a transition. Registered at module
 * load, so it is the store's first listener: its nested `setState` lands
 * before any component reads the change, and no render sees a busy tab
 * without a start.
 */
function turnStartsOutOfStep(state: ChatState): boolean {
  for (const session of Object.values(state.sessions)) {
    if (isBusyAgentStatus(session.status) !== (session.turnStartedAt != null)) return true;
  }
  return false;
}

useChatStore.subscribe((state) => {
  if (!turnStartsOutOfStep(state)) return;
  const now = Date.now();
  useChatStore.setState((s) => {
    for (const session of Object.values(s.sessions)) {
      const busy = isBusyAgentStatus(session.status);
      if (busy && session.turnStartedAt == null) session.turnStartedAt = now;
      else if (!busy && session.turnStartedAt != null) session.turnStartedAt = null;
    }
  });
});

/**
 * The app's one path for setting a session's mode, model, effort and options
 * (`lib/session-configuration.ts`). Made here, beside the store whose sessions
 * it mirrors picks into, so the store's actions can call it.
 */
export const sessionConfiguration = createSessionConfiguration({
  agents,
  sessions: {
    get: (tabId) => useChatStore.getState().sessions[tabId],
    update: (tabId, recipe) =>
      useChatStore.setState((s) => {
        const session = s.sessions[tabId];
        if (session) recipe(session);
      }),
  },
  prefs: {
    saveMode: saveLastModePref,
    saveEffort: saveNativeEffort,
    saveOption: saveConfigOptionPref,
    loadOptions: loadConfigOptionPrefs,
  },
  report: { refused: (message) => void toast.error(message) },
});

// ── Draft-mutating helpers ────────────────────────────────────────────────
//
// The chat-store hot path applies AgentDeltas inside an immer draft. To
// support both the single-event `applyAgentDelta` and the RAF-coalesced
// `applyAgentBatch` (which runs many events in ONE immer pass for a
// large perf win on tool-heavy turns), the per-event logic lives in
// these standalone functions instead of being inlined into `set(...)`.
// They take the writable draft directly and mutate in place — no
// `set(...)` inside, no return value.

type ChatDraft = ChatState & ChatActions;

/** Stamp the session's current model onto a freshly created assistant message
 *  so the badge records the producing model as a historical fact. Deriving it
 *  at render time from live session state is what leaked labels across agents
 *  (a later model/agent switch relabeled the whole thread). */
function stampProducingModel(
  session: {
    acpCurrentModel?: string;
    acpAvailableModels?: SessionModeInfo[];
    agentType?: string;
  },
  msg: ChatMessage,
): ChatMessage {
  // `session.model` is intentionally NOT a fallback — it's set to "" at
  // creation and never written after, so `acpCurrentModel` is the only real
  // source of the producing model.
  //
  // Stamped as the DISPLAY NAME, resolved here rather than in the row: rows
  // can't read session state without relabelling history on a later switch,
  // and the raw id is a wire token ("default") that means nothing to a reader.
  const m = resolveModelLabel(
    session.acpCurrentModel,
    session.agentType,
    session.acpAvailableModels,
  );
  if (m) msg.model = m;
  return msg;
}

function appendTextToDraft(
  s: ChatDraft,
  acpSessionId: string,
  text: string,
  agentId?: string,
): void {
  if (!text) return;
  const tid = findTabByAcpSession(s.sessions, acpSessionId, agentId);
  if (!tid) return;
  const session = s.sessions[tid];
  // Find the last message that actually renders something, skipping the
  // empty `thinking` markers claude-agent-acp emits between text chunks.
  // Without this, one continuous narration split by such a marker becomes
  // two text messages and the markdown between them (a bold span, a
  // sentence, even mid-word) parses as two broken fragments.
  let last: (typeof session.messages)[number] | undefined;
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    const rendersNothing =
      !m.content?.trim() &&
      !m.thinking?.trim() &&
      m.toolCalls.length === 0 &&
      m.fileChanges.length === 0 &&
      !(m.plan && m.plan.length > 0);
    if (!rendersNothing) {
      last = m;
      break;
    }
  }
  // Append into the trailing text-mode message; otherwise start a new
  // one so a preceding tool/thinking block isn't merged with unrelated
  // narration.
  //
  // NOTE: deliberately not bumping `updatedAt` here. Streaming chunks
  // fire dozens of times per second; touching `updatedAt` each time
  // used to invalidate the sidebar's `hasRunning`/sort memos and
  // re-render every top-level chat consumer per chunk. The sidebar
  // sort still updates correctly via `addMessage` (user send) and the
  // turn-end status flip.
  if (
    last &&
    last.role === "assistant" &&
    (last.mode === "text" || last.mode === undefined) &&
    last.toolCalls.length === 0
  ) {
    last.content += text;
    return;
  }
  session.messages.push(stampProducingModel(session, makeAssistantTextMessage(text)));
}

function appendThoughtToDraft(
  s: ChatDraft,
  acpSessionId: string,
  text: string,
  agentId?: string,
): void {
  if (!text) return;
  const tid = findTabByAcpSession(s.sessions, acpSessionId, agentId);
  if (!tid) return;
  const session = s.sessions[tid];
  const last = session.messages[session.messages.length - 1];
  if (last && last.role === "assistant" && last.mode === "thinking") {
    last.thinking = (last.thinking ?? "") + text;
    return;
  }
  session.messages.push(stampProducingModel(session, makeAssistantThinkingMessage(text)));
}

/** A terminal (idle/error) delta carries the `turn_seq` of the turn it ends.
 *  Reject one whose turn is older than the session's current turn — a newer
 *  send already superseded it (the parallel / queued / wake premature-"done"
 *  class). A missing or 0 `turn_seq` (native agent) is treated as
 *  current, so nothing regresses there. */
/** Fire-and-forget backend teardown for a closed tab's session: the manager
 *  drops the actor + the driver-side guard (M6 — these used to leak for the
 *  whole process lifetime). UI state removal proceeds regardless. */
function dropBackendSession(session: ChatSession | undefined): void {
  if (!session?.acpAgentId || !session.acpSessionId) return;
  void agents.dropSession(session.acpAgentId, session.acpSessionId).catch(() => {});
}

/**
 * Make `tabId` an empty new chat: no transcript, no binding, nothing pending.
 * The agent session it was bound to is left running: whoever cleared the tab
 * either has another tab taking that session or drops it themselves.
 */
function resetToNewChat(s: ChatDraft, tabId: string, preserveBackend = false): void {
  const session = s.sessions[tabId];
  if (session) {
    if (!preserveBackend) dropBackendSession(session);
    session.messages = [];
    session.tasks = [];
    session.status = "idle";
    session.inflightToolIds = undefined;
    session.acpAgentId = undefined;
    session.acpSessionId = undefined;
    forgetSessionUsage(session);
    session.title = UNTITLED_SESSION;
    session.firstUserContent = undefined;
    session.userMessageCount = 0;
    // Reset the turn-identity high-water mark + live per-turn scratch
    // so the next bound session's fresh turn_seq (which restarts at 1)
    // isn't rejected as stale by `isStaleTurn` (see `setAcpBinding`).
    session.currentTurnSeq = 0;
    session.livePlan = undefined;
    // The transcript these belonged to is gone with `messages`;
    // leaving them would hang the old chat's children off the new
    // one's first message.
    session.subagents = undefined;
    session.turnScratch = undefined;
    // Commands belong to the ACP session being dropped; the next
    // binding re-advertises its own list.
    session.availableCommands = undefined;
    // The advertised knobs go with it, for the same reason. Reseeded
    // from this agent's cache rather than blanked, so the Options pill
    // keeps rendering the right list across a clear instead of
    // dropping to a spinner for something we already know.
    session.acpConfigOptions = loadCachedAcpConfigOptions(session.agentType) ?? undefined;
    // The tab no longer points at the session being resumed, so the
    // send gate must drop with it. A resume that gets superseded
    // (New chat / another sidebar click) bails WITHOUT clearing its own
    // flag — deliberately, so it can't un-gate the resume that replaced
    // it — which makes this the single place the flag is guaranteed to
    // reset. Leaving it set would silently queue every future send in
    // this tab forever.
    session.resumePending = false;
    // Another conversation is taking the tab: the saved one is no
    // longer what it should load when shown.
    session.pendingRestore = undefined;
    // A first message still waiting on the old bind belongs to the
    // conversation being dropped, exactly like the queue below.
    session.pendingSend = undefined;
    session.unrestoredModeId = undefined;
    session.bindCwd = undefined;
    // A load the tab was waiting on belongs to the conversation being
    // dropped, and the load superseded by this reset bails without clearing
    // it. Left set, the fresh chat sat on the skeleton forever, and every
    // delta of the session it bound next was held for a paint that would
    // never come (audit #3).
    session.transcriptLoading = false;
    // What the dropped session's agent last said about itself, and the
    // per-turn state of that session. Kept, a fresh chat wore the dead
    // agent's Restart banner, and its first send respawned the agent to
    // reload a session the new chat never had (audit #51).
    session.disconnected = undefined;
    session.updatedTo = undefined;
    session.bindError = undefined;
    session.stopping = undefined;
    session.held = undefined;
    session.retryStatus = undefined;
    session.sleptMidTurn = undefined;
    session.compacting = undefined;
    session.pendingElicitation = undefined;
    session.queuedElicitations = undefined;
    session.justSentMessageId = undefined;
  }
  dropQueue(s, tabId);
  forgetHeld(tabId);
  // Whatever load was on its way into the tab is the old conversation's: it
  // must not paint or bind over the new chat. Covers a session taken by
  // another tab (`setAcpBinding`), whose own load would otherwise take the
  // session back when it lands (audit #47).
  invalidateLoad(tabId);
}

function isStaleTurn(session: ChatSession, turnSeq: number | undefined): boolean {
  if (!turnSeq) return false;
  return turnSeq < (session.currentTurnSeq ?? 0);
}

function applyDeltaToDraft(
  s: ChatDraft,
  env: AgentDelta,
  addedToolCalls?: Set<string>,
  /** Option lists an agent reported in this pass. The fold only mirrors them;
   *  the action that ran it caches them once the pass is over. */
  advertised?: AdvertisedOptions[],
): void {
  const tid = findTabByAcpSession(s.sessions, env.session_id, env.agent_id);
  if (!tid) return;
  const session = s.sessions[tid];
  switch (env.kind) {
    case "status": {
      const seq = env.turn_seq;
      if (env.status === "running" || env.status === "waiting") {
        // Turn start / paused-for-user (plan / permission): adopt the turn
        // identity and stay in an active (busy) state. A running/waiting for
        // an already-superseded turn is dropped like a stale terminal: applied,
        // it would flip a finished session back to busy with nothing left to
        // clear it.
        if (isStaleTurn(session, seq)) return;
        if (seq && seq > (session.currentTurnSeq ?? 0)) {
          session.currentTurnSeq = seq;
          // A turn started: whatever halt the last one put on the queue is
          // over (a resume, a direct send).
          session.queueHalted = undefined;
          // The live plan is NOT cleared here: a plan is the agent's, and it
          // stands until the agent replaces or clears it (`plan_updated`). A
          // plan spanning several turns used to vanish at every prompt
          // (ACP audit finding 102).
          // Start a fresh per-turn files-touched scratch for the adaptive card.
          session.turnScratch = { seq, tools: {} };
          // A sleep notice still held for an older turn missed its place —
          // the new user message is already below it.
          if (session.sleptMidTurn && session.sleptMidTurn.turnSeq < seq) {
            session.sleptMidTurn = undefined;
          }
        }
        session.status = env.status;
        return;
      }
      // idle / error are terminal — drop one for an already-superseded turn.
      if (isStaleTurn(session, seq)) return;
      const terminal = env.status === "idle" ? "idle" : "error";
      // Sweep any tool call still pending/running to a terminal state — a bare
      // `status: idle` (one that arrives without an accompanying turn_finished)
      // must not leave a phantom spinner. Mirrors the turn_finished sweep
      // below. Rust also sweeps authoritatively before emitting the terminal;
      // this is the view-side guard against any residual race.
      for (const msg of session.messages) {
        for (const tc of msg.toolCalls) {
          if (tc.status === "pending" || tc.status === "running") {
            tc.status = terminal === "error" ? "failed" : "completed";
          }
        }
      }
      session.status = terminal;
      session.stopping = undefined;
      session.retryStatus = undefined;
      session.inflightToolIds = undefined;
      // No permission modal survives its turn: the Rust finalize sweep emits
      // permission_resolved for each, but a lost/raced delta must not leave a
      // clickable modal on an idle turn (its click would strand the session).
      delete s.pendingPermissions[env.session_id];
      return;
    }
    case "turn_finished": {
      // Reject a terminal for a turn already superseded by a newer send —
      // don't flip to idle or inject an empty-turn placeholder for stale turns.
      if (isStaleTurn(session, env.turn_seq)) return;
      // A terminal for no turn Rust saw open, landing on a turn that already
      // ended: a late duplicate (a cancel answered behind the stop it raced).
      // Applying it would relabel the finished turn — "Stopped after" on a
      // reply that completed. Rust swallows these; this is the backstop.
      const tail = session.messages[session.messages.length - 1];
      if (
        env.started_at_ms === undefined &&
        tail?.role === "assistant" &&
        tail.stopReason !== undefined
      ) {
        return;
      }
      dropElicitations(session);
      // A refusal or a cap is a failed turn to the turn controller: it halts
      // whatever is queued behind it (audit #77). Anything else lets it drain.
      session.queueHalted =
        stopReasonHaltsQueue(env.stop_reason) && (s.queues[tid]?.length ?? 0) > 0
          ? true
          : undefined;
      // Empty-turn detection: if no assistant content arrived
      // between the last user message and turn-end, insert a
      // placeholder so the UI doesn't show a vanishing spinner.
      let lastUserIdx = -1;
      for (let i = session.messages.length - 1; i >= 0; i--) {
        if (session.messages[i].role === "user") {
          lastUserIdx = i;
          break;
        }
      }
      const responded = session.messages
        .slice(lastUserIdx + 1)
        .some(
          (m) =>
            m.role === "assistant" &&
            ((m.content && m.content.length > 0) ||
              m.toolCalls.length > 0 ||
              (m.thinking && m.thinking.length > 0)),
        );
      if (!responded && env.stop_reason !== "cancelled") {
        const label =
          env.stop_reason === "end_turn"
            ? "(no response — the agent ended its turn without output)"
            : (stopReasonNotice(env.stop_reason) ??
              `(no response — stop_reason: ${env.stop_reason})`);
        session.messages.push(makeAssistantTextMessage(label));
      } else if (responded) {
        // P2.4: an abnormal stop reason has to surface even when output DID
        // arrive — that is precisely when it is invisible otherwise. A
        // `max_tokens` reply is truncated mid-thought and reads like a finished
        // one; a `refusal` reads like the agent simply chose to say that. Only
        // `end_turn` and `cancelled` are self-explanatory, so only they stay
        // silent (cancelled already has its own UI).
        const notice = stopReasonNotice(env.stop_reason);
        if (notice) session.messages.push(makeAssistantTextMessage(notice));
      }
      // Resolve any tool calls still in pending/running state on EVERY
      // terminal, not just cancel. After Stop the driver gate drops further
      // updates; on a normal end a dropped/raced final `tool_call_update`
      // leaves the same phantom loader. The turn is over either way — sweep
      // to a terminal state so no card can spin forever.
      for (const msg of session.messages) {
        for (const tc of msg.toolCalls) {
          if (tc.status === "pending" || tc.status === "running") {
            tc.status = env.stop_reason === "cancelled" ? "failed" : "completed";
          }
        }
      }
      // Stamp the producing model onto this turn's assistant messages. The
      // badge must be a historical fact per message — deriving it from live
      // session state relabels the whole thread when the session's model or
      // agent changes later (the "Claude messages labeled Gemini" leak).
      const producingModel = resolveModelLabel(
        session.acpCurrentModel,
        session.agentType,
        session.acpAvailableModels,
      );
      if (producingModel) {
        for (let i = lastUserIdx + 1; i < session.messages.length; i++) {
          const m = session.messages[i];
          if (m.role === "assistant" && !m.model) m.model = producingModel;
        }
      }
      // Every stop reason ACP defines is a way for a turn to END, not to
      // fail: a token limit, the request cap and a refusal settle idle with a
      // notice saying what happened. Read as errors, they flashed the session
      // "Failed" in the sidebar and recorded the turn as failed (audit #20).
      // A reason ACP does not define is not guessed at.
      session.status = NORMAL_STOP_REASONS.has(env.stop_reason) ? "idle" : "error";
      session.stopping = undefined;
      session.retryStatus = undefined;
      session.inflightToolIds = undefined;
      delete s.pendingPermissions[env.session_id];
      // Per-turn usage footer: derive this turn's tokens/cost as the delta
      // from the previous turn's cumulative snapshot, and attach it to the
      // trailing assistant message so it renders at the end of the turn. Any
      // agent that reports a cumulative split gets it — an ACP agent's
      // per-turn `PromptResponse.usage` is folded into a running total in
      // Rust — so it keys on the usage being there, never on which agent
      // sent it (ADR-0002, ACP audit finding 26).
      if (session.usage) {
        const cum = {
          input: session.usage.input_tokens ?? 0,
          output: session.usage.output_tokens ?? 0,
          cost: session.usage.cost ?? 0,
        };
        const prev = session.lastUsageSnapshot ?? {
          input: 0,
          output: 0,
          cost: 0,
        };
        const turn = {
          input: Math.max(0, cum.input - prev.input),
          output: Math.max(0, cum.output - prev.output),
          cost: Math.max(0, cum.cost - prev.cost),
          saved: session.pendingSavedTokens ?? 0,
        };
        session.lastUsageSnapshot = cum;
        session.pendingSavedTokens = undefined;
        if (turn.input + turn.output > 0) {
          for (let i = session.messages.length - 1; i >= 0; i--) {
            if (session.messages[i].role === "assistant") {
              session.messages[i].usage = turn;
              break;
            }
          }
        }
      }
      // Agents that stream a cumulative context-window gauge: snapshot the
      // latest onto the trailing assistant message so its turn card renders
      // a context gauge beside the per-turn usage. Keyed on the gauge being
      // there, like the usage above.
      if (session.contextUsage) {
        for (let i = session.messages.length - 1; i >= 0; i--) {
          if (session.messages[i].role === "assistant") {
            session.messages[i].contextUsage = { ...session.contextUsage };
            break;
          }
        }
      }
      // Freeze the per-turn files-touched scratch onto the trailing assistant
      // message as `turnSummary` (mirrors the usage attach above). Only here at
      // turn end, so the adaptive card never appears mid-stream. `repoAtTurn` is
      // set by the card component (the store stays free of git/app deps).
      if (session.turnScratch) {
        const files = foldTurnFiles(Object.values(session.turnScratch.tools));
        if (files.length > 0) {
          for (let i = session.messages.length - 1; i >= 0; i--) {
            if (session.messages[i].role === "assistant") {
              session.messages[i].turnSummary = {
                turnSeq: session.turnScratch.seq,
                files,
                repoAtTurn: false,
              };
              break;
            }
          }
        }
        session.turnScratch = undefined;
      }
      // "Worked for 7m 37s" / "Stopped after 12s": the turn's run time as
      // Rust measured it (monotonic, so a sleep or a clock step does not
      // stretch it), and how it ended — the same pair a snapshot puts on the
      // same message, so the header reads the same after a reload.
      //
      // Only onto a message this turn produced. After a rewind (`/undo`) the
      // trailing message can be the PREVIOUS turn's reply, and stamping it
      // would overwrite that turn's own figure with this one's.
      if (responded) {
        const last = session.messages[session.messages.length - 1];
        const ours =
          env.started_at_ms === undefined || Date.parse(last.timestamp) >= env.started_at_ms;
        if (last.role === "assistant" && ours) {
          if (env.worked_ms !== undefined) last.workedMs = env.worked_ms;
          last.stopReason = env.stop_reason;
        }
      }
      // Agent-generated next-step chips: extract the trailing assistant reply's
      // hidden `<next_steps>` block into click-to-send suggestions. The raw
      // content (with the block) stays in the store; the display path strips it.
      for (let i = session.messages.length - 1; i >= 0; i--) {
        const m = session.messages[i];
        if (m.role !== "assistant") continue;
        const chips = extractNextSteps(m.content);
        if (chips.length > 0) {
          m.suggestions = {
            turnSeq: env.turn_seq ?? 0,
            status: "ready",
            chips,
          };
        }
        break;
      }
      recordInterruption(session, env.stop_reason === "cancelled" ? "stopped" : "finished");
      return;
    }
    case "turn_failed": {
      if (isStaleTurn(session, env.turn_seq)) return;
      dropElicitations(session);
      // The turn controller halts a non-empty queue behind a failed turn
      // rather than drain it into the agent that just failed (audit #77).
      if ((s.queues[tid]?.length ?? 0) > 0) session.queueHalted = true;
      // Sweep live tool calls to failed — turn_finished and the bare terminal
      // status both have this guard (no spinner outlives its turn), and this was
      // the one terminal without it. Rust usually pairs TurnFailed with a
      // Status(error) whose sweep covers it, but the view-side guard exists
      // precisely because a paired delta can be lost or raced.
      for (const msg of session.messages) {
        for (const tc of msg.toolCalls) {
          if (tc.status === "pending" || tc.status === "running") tc.status = "failed";
        }
      }
      // Don't hardcode "ACP error" — the native Atlas agent is
      // in-process and shares this error delta, so its provider errors (e.g. a
      // Gemini HTTP 400) were being mislabeled as ACP failures. Use a neutral
      // prefix.
      // After a sleep the failure is almost always the sleep's doing — a dropped
      // stream reports "error decoding response body", which names nothing the
      // user did — so the interruption row leads and carries the agent's words
      // folded, instead of a bare "Error:" line.
      const last = session.messages[session.messages.length - 1];
      if (session.sleptMidTurn) {
        recordInterruption(session, "failed", env.error);
      } else if (
        last?.role === "assistant" &&
        last.interruption?.outcome === "failed" &&
        !last.interruption.error
      ) {
        // The sleep landed between the error status and this delta, and was
        // recorded then; the error joins that record.
        last.interruption = { ...last.interruption, error: env.error };
      } else {
        session.messages.push(makeAssistantTextMessage(`Error: ${env.error}`));
      }
      session.status = "error";
      session.stopping = undefined;
      session.retryStatus = undefined;
      session.inflightToolIds = undefined;
      // Auth failures route to the agent's sign-in flow (P15) instead of
      // dying as a generic banner. The composer components listen for this
      // (Claude → login dialog, Codex → sign-in pill); native/BYOK keys are
      // covered by the error text pointing at Settings → Agents → Provider keys.
      if (env.error_kind === "auth") {
        emitWindowEvent("atlas:auth-required", {
          sessionId: env.session_id,
          agentType: session.agentType,
          // `reason` carries the agent's own words through to the dialog,
          // which reads them to tell "needs a provider API key Atlas can
          // collect in-app" apart from "needs a login flow".
          reason: env.error,
        });
      }
      delete s.pendingPermissions[env.session_id];
      return;
    }
    case "agent_disconnected": {
      // The backing process died. Rust already emitted TurnFailed + Status
      // (error) for busy sessions; here we flag the session so the composer
      // offers Restart and the next send rebinds (respawn + resume). Binding
      // fields stay — acpSessionId IS the on-disk id resume needs (P14).
      session.disconnected = true;
      session.stopping = undefined;
      // A turn cut short by its agent going away is not a failed turn to the
      // controller: the rebind runs what was queued, with no halt to resume.
      session.queueHalted = undefined;
      dropElicitations(session);
      session.retryStatus = undefined;
      // A process that EXITED had its turn failed first, but one Atlas killed
      // (another tab's Stop pressed twice, Restart, a start that never
      // finished) sends no terminal before this notice: its connection, and
      // with it the turn, is simply gone. End the turn here, or the tab stays
      // "Working" with a Stop button for a process that no longer exists
      // (audit #74).
      if (isBusyAgentStatus(session.status)) {
        for (const msg of session.messages) {
          for (const tc of msg.toolCalls) {
            if (tc.status === "pending" || tc.status === "running") tc.status = "failed";
          }
        }
        session.status = "error";
        session.inflightToolIds = undefined;
        delete s.pendingPermissions[env.session_id];
      }
      recordInterruption(session, "disconnected");
      return;
    }
    case "slept_mid_turn": {
      if (isStaleTurn(session, env.turn_seq)) return;
      // Live while the turn runs (the composer pill), frozen onto the turn when
      // it ends. Rust delivers it ahead of the turn's terminal, but the
      // background tick can lose that race — then the turn is already over and
      // the record goes straight on.
      session.sleptMidTurn = {
        turnSeq: env.turn_seq,
        sleptSecs: env.slept_secs,
        wokeAt: Date.now(),
      };
      if (!isBusyAgentStatus(session.status)) {
        // The next prompt is already sent: there is no reply left to sit
        // after, and a record here would land in the next turn.
        if (session.messages[session.messages.length - 1]?.role === "user") {
          session.sleptMidTurn = undefined;
          return;
        }
        if (session.status !== "error") {
          recordInterruption(session, "finished");
          return;
        }
        // The failure already pushed its bare "Error:" line; the record takes
        // its place and carries the error, as it would have on time.
        const tail = session.messages[session.messages.length - 1];
        const errorLine =
          tail?.role === "assistant" &&
          !tail.interruption &&
          tail.toolCalls.length === 0 &&
          tail.content.startsWith("Error: ")
            ? tail
            : undefined;
        if (errorLine) session.messages.pop();
        recordInterruption(session, "failed", errorLine?.content.slice("Error: ".length));
      }
      return;
    }
    case "retry_status": {
      session.retryStatus = {
        attempt: env.attempt,
        maxAttempts: env.max_attempts,
        delayMs: env.delay_ms,
        lastError: env.last_error,
        receivedAt: Date.now(),
      };
      return;
    }
    case "text_chunk": {
      // Delegate to the shared helper so text chunks routed through the
      // delta stream get the SAME "find last renderable message" logic the
      // narration bucket used — skipping empty placeholder/thinking markers
      // so one continuous narration never splits into broken fragments.
      session.retryStatus = undefined; // content resumed — the retry succeeded
      appendTextToDraft(s, env.session_id, env.delta, env.agent_id);
      return;
    }
    case "thinking_chunk": {
      session.retryStatus = undefined;
      appendThoughtToDraft(s, env.session_id, env.delta, env.agent_id);
      return;
    }
    case "message_appended": {
      // Convert the Rust-shaped message into a ChatMessage and push.
      // Rust already decided this is a new message; the frontend
      // mirrors without re-deciding.
      const m = env.message;
      for (const tc of m.tool_calls) addedToolCalls?.add(tc.id);
      const appended: ChatMessage = {
        id: m.id,
        role: m.role,
        content: m.content,
        thinking: m.thinking ?? "",
        toolCalls: m.tool_calls.map(toChatToolCall),
        fileChanges: [],
        plan: m.plan
          ? m.plan.map((e, idx) => ({
              id: `plan-${idx}`,
              description: e.content,
              status: (e.status as "pending" | "in_progress" | "completed") ?? "pending",
            }))
          : null,
        timestamp: m.timestamp,
        ...(m.timestamp_approximate ? { timestampApproximate: true } : {}),
        mode: m.mode,
      };
      if (appended.role === "assistant") stampProducingModel(session, appended);
      session.messages.push(appended);
      return;
    }
    case "tool_call_upserted": {
      // Accumulate per-turn files-touched for the adaptive turn card, keyed by
      // tool id so repeated pending→completed upserts are idempotent (O(1), no
      // message rescan). Frozen into the trailing message at turn_finished.
      if (session.turnScratch) {
        const tc = env.tool_call;
        const files = turnFilesOfToolCall(tc);
        // A later sighting that names no file (a bare status update) must not
        // erase what an earlier one recorded. A call that names several files
        // (the native engine's patch) keeps the first under its id and the
        // rest under `id#n`, replaced whole on each sighting.
        if (files.length > 0) {
          const tools = session.turnScratch.tools;
          for (let n = 1; `${tc.id}#${n}` in tools; n++) delete tools[`${tc.id}#${n}`];
          files.forEach((file, n) => {
            tools[n === 0 ? tc.id : `${tc.id}#${n}`] = file;
          });
        }
      }
      // Any tool call changing, in any message, is something a view of the
      // session's edits must hear (`editsSignature`).
      session.toolRevision = (session.toolRevision ?? 0) + 1;
      // Incremental in-flight index — the O(1) source for the composer's
      // busy check (hasInFlightToolCalls), replacing a per-frame scan of
      // every message's toolCalls.
      //
      // Only while a turn is on. A call the agent reports in progress on an
      // IDLE session (a straggler update after the turn ended, a background
      // task) has no turn behind it: indexed, it turned the composer into
      // Stop/Queue with nothing to stop, nothing to drain the queue and
      // nothing to clear `stopping` (ACP audit finding 82). The card still shows it.
      if (
        (env.tool_call.status === "pending" || env.tool_call.status === "running") &&
        isBusyAgentStatus(session.status)
      ) {
        (session.inflightToolIds ??= {})[env.tool_call.id] = true;
      } else if (session.inflightToolIds) {
        delete session.inflightToolIds[env.tool_call.id];
      }
      const found = isNewToolCall(session, env.tool_call.id, addedToolCalls)
        ? null
        : findToolCall(session, env.tool_call.id);
      if (found) {
        // Rust's start never moves across the pending→running→completed
        // updates for one call, and `toChatToolCall` carries a time only when
        // the wire did, so a first-sight stamp on a call that arrived without
        // one is left in place rather than blanked.
        Object.assign(found.tc, toChatToolCall(env.tool_call));
        return;
      }
      // First sight of this call. Rust stamps its start; only a call that
      // arrived without one is stamped here, at first sight — the delta comes
      // when the agent announces the call, so that is its start to within one
      // IPC hop.
      const fresh = toChatToolCall(env.tool_call);
      fresh.startedAt ??= Date.now();
      addedToolCalls?.add(fresh.id);
      // Collapse consecutive tool calls into ONE assistant message
      // so the thread doesn't render N separate message-item boxes
      // (each with its own padding) for every Find/Read/Bash the
      // agent emits in a single turn. If the trailing message is
      // already an assistant tool-mode message, just append the new
      // tool call to its `toolCalls` array; the MessageItem renders
      // all cards in one stacked group with tight internal
      // `space-y-1.5`. Only when the trailing message ISN'T a tool
      // message (text/thinking intervened) do we start a fresh tool
      // message.
      const last = session.messages[session.messages.length - 1];
      if (last && last.role === "assistant" && last.mode === "tool") {
        last.toolCalls.push(fresh);
        return;
      }
      session.messages.push(stampProducingModel(session, makeAssistantToolMessage(fresh)));
      return;
    }
    case "tool_call_output_chunk": {
      // Incremental live command output — append to the tool's visible result.
      // A chunk for an unknown id is dropped (matches the Rust apply rule for
      // lone updates); the next full snapshot carries the authoritative text.
      const found = findToolCall(session, env.tool_call_id);
      if (found) {
        found.tc.result = (found.tc.result ?? "") + env.delta;
      }
      return;
    }
    case "subagent_upserted": {
      // Whole-record upsert, keyed on the launching call — the same contract
      // as `tool_call_upserted`, so nothing here merges fields. The projector
      // re-derives a child on every thread change and only sends what differs,
      // which is why a late attribution (a call the agent assigns to a child
      // after announcing it) arrives as an ordinary update rather than needing
      // a patch path of its own.
      //
      // Not gated on `isStaleTurn`: a child can outlive the turn that spawned
      // it, and the record belongs to its launching message, not to the turn.
      (session.subagents ??= {})[env.subagent.toolCallId] = env.subagent;
      return;
    }
    case "plan_updated": {
      const last = session.messages[session.messages.length - 1];
      const planSteps = env.plan.map(toPlanStep);
      if (last && last.role === "assistant") {
        last.plan = planSteps;
      } else if (planSteps.length > 0) {
        const fresh = stampProducingModel(session, makeAssistantTextMessage(""));
        fresh.plan = planSteps;
        session.messages.push(fresh);
      }
      // A CLEARED plan now reaches here rather than being swallowed by the
      // backend (ATL-222), and it has nothing to hang on a message that does
      // not exist — minting an empty assistant bubble to carry an empty plan
      // would trade the stale card for a blank one.
      // Mirror onto the session so the docked plan panel selects it directly.
      session.livePlan = planSteps;
      return;
    }
    case "available_commands": {
      noteHeard(session.acpSessionId, "commands", env.commands.length);
      session.availableCommands = env.commands;
      return;
    }
    case "history_rewound": {
      // A rewind (the native agent's /undo). Drop trailing messages through
      // the `turns`-th user message from the end, so the visible transcript
      // matches what the agent now remembers. Counted in user messages
      // because our user rows are optimistic — they carry no wire ids the
      // backend could address individually.
      let remaining = (env.turns as number) ?? 0;
      let cut = session.messages.length;
      while (cut > 0 && remaining > 0) {
        cut -= 1;
        if (session.messages[cut]?.role === "user") remaining -= 1;
      }
      if (remaining !== 0) return;
      const dropped = session.messages.splice(cut);
      // Splicing the log is not the whole rewind: two caches derived from it
      // live on the session and neither is recomputed from `messages`.
      //   * `userMessageCount`, incremented by `addMessage` (:899) and read by
      //     the sidebar. A rewind that only spliced left it permanently high —
      //     visibly so under retry, which rewinds and re-adds on every press.
      //   * `livePlan`, set by the `plan_updated` delta (:2046) and read by
      //     the docked plan pill. Left alone it kept showing the plan of the
      //     turn that was just discarded.
      // `replaceMessages` (:1310) recomputes the count and preview on a
      // history load; the plan comes back via `hydrateSessionSnapshot` (:1341).
      const droppedUsers = dropped.reduce((n, m) => (m.role === "user" ? n + 1 : n), 0);
      session.userMessageCount = Math.max(0, (session.userMessageCount ?? 0) - droppedUsers);
      if (session.messages.length === 0) session.firstUserContent = undefined;
      session.livePlan = undefined;
      return;
    }
    case "mode_changed": {
      session.acpCurrentMode = env.mode_id;
      // Reflect agent-driven permission-mode changes back into the composer
      // pill. Claude Code emits `current_mode_update` when the user picks a
      // mode at the plan-review prompt (e.g. "bypass permissions") — without
      // this the pill kept showing the old mode. Guarded to a session on Atlas's
      // own mode record + a known permission mode, so another agent's own
      // modes don't leak into that pill.
      if (
        onClaudeModeList(session) &&
        (CLAUDE_PERMISSION_MODES as readonly string[]).includes(env.mode_id)
      ) {
        session.claudePermissionMode = env.mode_id as ClaudePermissionMode;
      }
      return;
    }
    case "usage_updated": {
      session.usage = env.usage;
      return;
    }
    case "elicitation_requested": {
      // Shown one at a time, answered in the order asked: a second question
      // waits behind the first instead of replacing it — replaced, the
      // first's request was never answered and the tool call behind it hung
      // (ACP audit finding 41).
      offerElicitation(session, {
        agentId: env.agent_id,
        requestId: env.request_id,
        // A plain string on the wire; Rust only ever sends these two.
        mode: env.mode === "url" ? "url" : "form",
        message: env.message,
        requestedSchema: env.requested_schema,
        url: env.url,
      });
      return;
    }
    case "title_updated": {
      // The agent summarised this session better than the first 40 characters
      // of the prompt Atlas titled it with (Codex and Kilo both do, once they
      // have seen a turn).
      session.title = env.title;
      return;
    }
    case "config_options_updated": {
      // Keeps the mode/model pickers honest when the change came from inside
      // the agent (its own `/model`, a thinking toggle) rather than from Atlas.
      session.acpConfigOptions = env.config_options;
      noteHeard(session.acpSessionId, "options", env.config_options.length);
      // What it advertised is also cached for the next launch, by the action
      // that ran this fold (`cacheAdvertisedOptions`), not from in here.
      if (session.agentType) {
        advertised?.push({ agentType: session.agentType, configOptions: env.config_options });
      }
      // The model pill rides on this same blob — ACP has no separate model
      // field, so a `category: "model"` select IS the model list. Without this
      // the pill only ever saw the bind-time snapshot and went stale (or, for a
      // session bound before the agent advertised, stayed empty and hid).
      const models = modelSelectOf(env.config_options);
      if (models) {
        noteHeard(session.acpSessionId, "models", models.availableModels.length);
        session.acpAvailableModels = models.availableModels;
        if (models.currentModel) session.acpCurrentModel = models.currentModel;
      }
      // The mode pill rides on it too. The official Claude adapter never
      // sends `current_mode_update` for an ordinary change — its answer to a
      // `session/set_mode`, and its only word after the SDK switched modes, is
      // this blob's `mode` select. Same own-record + known-mode guard as the
      // `mode_changed` case, for the same reason (Codex's modes stay out of
      // the Claude pill). No push back: this is the agent telling us.
      const modes = modeSelectOf(env.config_options);
      // The select is the agent's whole mode state, so a change to its LIST
      // (a mode added or withdrawn mid-session) reaches the pill too, not
      // just a change of current mode (#43). Not onto Atlas's own Claude mode
      // record, whose list is Atlas's, and never to an empty list: a select
      // with nothing to pick is not one (`selectOf`).
      const modeList =
        modes && modes.availableModes.length > 0 && !onClaudeModeList(session)
          ? modes.availableModes
          : null;
      if (modeList) {
        session.acpAvailableModes = modeList;
        session.acpModesPending = false;
      }
      if (modes?.currentMode) {
        session.acpCurrentMode = modes.currentMode;
        if (
          onClaudeModeList(session) &&
          (CLAUDE_PERMISSION_MODES as readonly string[]).includes(modes.currentMode)
        ) {
          session.claudePermissionMode = modes.currentMode as ClaudePermissionMode;
        }
      }
      // Whatever is current must be one of the list's modes, or the pill
      // falls back to "Mode" with nothing to clear it (as in `setAcpModes`).
      if (modeList && !modeList.some((m) => m.id === session.acpCurrentMode)) {
        session.acpCurrentMode = modeList[0].id;
      }
      return;
    }
    case "context_usage": {
      session.contextUsage = {
        used: env.used,
        size: env.size,
        cost: env.cost,
        currency: env.currency,
      };
      // Persist keyed by the stable transcript id so the gauge survives a
      // session switch (messages reload from disk) and an app restart (store
      // is gone). Restored in `replaceMessages`.
      if (session.acpSessionId) {
        saveCachedContextUsage(session.acpSessionId, session.contextUsage);
      }
      return;
    }
    case "compaction": {
      session.compacting = env.active;
      return;
    }
    case "compression_saved": {
      // Stashed until turn_finished folds it into the message's usage footer.
      session.pendingSavedTokens = env.saved_tokens;
      return;
    }
    case "rate_limits": {
      session.rateLimits = {
        primary: env.primary,
        secondary: env.secondary,
        planType: env.plan_type,
      };
      return;
    }
    case "model_changed": {
      // The host announces every model set through its steering entry —
      // this window's, or a remote driver's (Universal RC). A remote
      // `set_model` on a native session runs the next turn on the new model,
      // so the pill has to follow it or it lies.
      //
      // For the native agent, only an id the catalogue lists is taken. The
      // BYOK `ProviderModelPills` path (still mounted in the artifacts
      // session panel) pushes `provider/model` with a BARE id in
      // `acpCurrentModel`; the echo of that push is the prefixed form, which
      // is not in `acpAvailableModels`, so taking it would re-prefix the value
      // on every re-push ("google/google/google/…"). An empty list (the
      // catalogue fetch failed) takes nothing: the selector refuses an unknown
      // slug anyway, so there is no remote change to follow.
      if (
        session.agentType !== "atlas-agent" ||
        session.acpAvailableModels?.some((m) => m.id === env.model_id)
      ) {
        session.acpCurrentModel = env.model_id;
      }
      return;
    }
    case "user_message": {
      applyUserMessage(session, env);
      return;
    }
    case "queue_changed": {
      mirrorQueue(s, tid, env.queue);
      // An empty queue has no halt left: Rust drops it with the last item.
      if (!s.queues[tid]?.length) session.queueHalted = undefined;
      return;
    }
    case "hold_changed": {
      session.held = env.held || undefined;
      return;
    }
    default:
      return;
  }
}

/**
 * A prompt reached the agent. This window's own send already drew its row
 * (optimistic, at send time) and sent that row's id along: adopt it — nothing
 * to draw. Anything else is a prompt this window never drew — a queued prompt
 * the turn controller sent, a remote driver's — and is drawn now, the way the
 * composer would have.
 */
function applyUserMessage(
  session: ChatSession,
  env: Extract<AgentDelta, { kind: "user_message" }>,
): void {
  const cmid = env.client_message_id;
  if (cmid && session.messages.some((m) => m.role === "user" && m.clientMessageId === cmid)) {
    return;
  }
  const m = env.message;
  const split = splitAtlasContext(m.content);
  const msg: ChatMessage = {
    id: m.id,
    role: "user",
    content: m.content,
    ...(cmid ? { clientMessageId: cmid } : {}),
    ...(env.origin.kind === "remote" ? { origin: env.origin } : {}),
    ...(m.images?.length
      ? { attachments: m.images.map((i) => ({ mimeType: i.mime_type, dataBase64: i.data })) }
      : {}),
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: m.timestamp,
    ...(split.context !== null
      ? {
          atlasProse: split.prose,
          atlasContext: split.context,
          atlasContextBlockCount: split.blockCount,
        }
      : {}),
  };
  const isFirst = !session.messages.some((r) => r.role === "user");
  session.messages.push(msg);
  session.updatedAt = new Date().toISOString();
  const prose = stripNextStepsDirective(split.prose);
  if (!session.firstUserContent) session.firstUserContent = firstUserPreview(prose);
  session.userMessageCount = (session.userMessageCount ?? 0) + 1;
  session.justSentMessageId = msg.id;
  // A session whose first prompt came from elsewhere is titled the way the
  // composer titles one (the agent's own `title_updated` still wins later).
  if (isFirst && session.title === UNTITLED_SESSION && prose) {
    session.title = prose.slice(0, 40) + (prose.length > 40 ? "..." : "");
  }
}

/** Seed what a snapshot says is live: open prompts, the queue, the hold. */
function hydrateLive(s: ChatDraft, tabId: string, live: SnapshotLive): void {
  const session = s.sessions[tabId];
  if (!session) return;
  // The turn Rust is on, exactly: a live turn's deltas carry it, and a late
  // terminal of an earlier turn is still refused as stale.
  if (live.turnSeq !== undefined) session.currentTurnSeq = live.turnSeq;
  if (live.held !== undefined) session.held = live.held || undefined;
  if (live.queue) mirrorQueue(s, tabId, live.queue);
  const acp = session.acpSessionId;
  const agentId = live.agentId ?? session.acpAgentId;
  if (acp && agentId && live.pendingPermissions?.length) {
    const open = s.pendingPermissions[acp] ?? [];
    const known = new Set(open.map((p) => p.requestId));
    const restored = live.pendingPermissions
      .filter((p) => !known.has(p.request_id))
      .map((p) => ({
        agentId,
        acpSessionId: acp,
        requestId: p.request_id,
        toolCall: p.tool_call as PendingPermission["toolCall"],
        options: p.options as PendingPermission["options"],
      }));
    if (restored.length) s.pendingPermissions[acp] = [...open, ...restored];
  }
  if (agentId && live.pendingElicitation) {
    const e = live.pendingElicitation;
    offerElicitation(session, {
      agentId,
      requestId: e.request_id,
      mode: e.mode === "url" ? "url" : "form",
      message: e.message,
      requestedSchema: e.requested_schema,
      url: e.url,
    });
  }
}

type SessionElicitation = NonNullable<ChatSession["pendingElicitation"]>;

/** Show `e`, or queue it behind the one shown. One already known (a snapshot
 *  re-reporting it) is not added twice. */
function offerElicitation(session: ChatSession, e: SessionElicitation): void {
  const shown = session.pendingElicitation;
  if (!shown) {
    session.pendingElicitation = e;
    return;
  }
  if (shown.requestId === e.requestId) return;
  if (session.queuedElicitations?.some((q) => q.requestId === e.requestId)) return;
  (session.queuedElicitations ??= []).push(e);
}

/** Take `requestId` (the one shown when omitted) out; the next waiting one,
 *  if any, is shown. */
function closeElicitation(session: ChatSession, requestId?: string): void {
  const shown = session.pendingElicitation;
  if (requestId !== undefined && shown?.requestId !== requestId) {
    const rest = session.queuedElicitations?.filter((q) => q.requestId !== requestId);
    session.queuedElicitations = rest?.length ? rest : undefined;
    return;
  }
  const [next, ...rest] = session.queuedElicitations ?? [];
  session.pendingElicitation = next;
  session.queuedElicitations = rest.length ? rest : undefined;
}

/** The turn ended: every question it asked is withdrawn — Rust cancels the
 *  outstanding requests with the turn — so none stays on screen asking for an
 *  answer nothing is waiting on (ACP audit finding 41). */
function dropElicitations(session: ChatSession): void {
  session.pendingElicitation = undefined;
  session.queuedElicitations = undefined;
}
