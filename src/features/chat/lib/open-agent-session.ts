import { toast } from "sonner";
import { emit } from "@tauri-apps/api/event";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useAppStore } from "@/features/app/stores/app-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { ensureAgent, getAgentSync } from "./agents-api";
import { errInfo } from "./agent-signin";
import { canReuseTab, findSessionHolder, showTab } from "./session-tab-reuse";
import { pluginIdForAgent, type AgentType, type SwitchableAgent } from "@/types/agent";
import { bumpLoadToken, invalidateLoad, isLoadStale } from "./load-tokens";
import { snapshotLive } from "./snapshot-message";
import { clearKeepingUnsent } from "./unsent-text";
import { ResumeError, resumeSessionFast } from "./resume-session";
import { applyModeOnResume, holdUnrestoredMode } from "./resume-mode";
import { emitWindowEvent } from "@/lib/window-events";
import { offerSignInOnRefusal } from "./sign-in-on-refusal";

/** Active project root, preferring the legacy `currentProject` but falling back
 *  to the active project path (mirrors the sidebar's `cwd` resolution). */
function activeCwd(): string {
  const project = useAppStore.getState().currentProject;
  const ws = useProjectStore.getState();
  return project?.path ?? ws.projects.find((w) => w.id === ws.activeProjectId)?.path ?? "";
}

/** Nudge the history sidebar to refetch all three agent session lists. The
 *  sidebar listens for the Tauri `atlas:sessions-changed` event (gated on cwd),
 *  so re-emit it from the frontend after a local mutation (e.g. abandoning a
 *  chat via New Chat) — Codex and the native agent have no file watcher and Claude's is async,
 *  so the just-abandoned conversation would otherwise not re-list immediately. */
function refreshSessionLists(): void {
  const cwd = activeCwd();
  if (!cwd) return;
  void emit("atlas:sessions-changed", { cwd });
}

interface OpenOpts {
  /** ACP session id to open — the canonical per-session identity. If absent,
   *  just opens an empty chat. NOTE: do NOT key on a chat tab id; a tab (e.g.
   *  `welcome-chat`) hosts many sessions over its life, so focusing by tab id
   *  lands on whatever that tab currently shows, not the clicked session. */
  acpSessionId?: string;
  title: string;
  /** Project root for `loadSession`. */
  cwd: string;
  /** The agent that ran this session. Resuming through the wrong plugin makes
   *  `loadSession` fail and silently fall back to a blank session — the same
   *  bug the sidebar fixed. Defaults to Claude for legacy callers. */
  agentType?: AgentType;
  /** Always a new tab, never the active one: a branch, whose source is the
   *  active tab and has to stay as it is. */
  newTab?: boolean;
  /** This open is the retry after a sign-in it offered: a second auth
   *  refusal is reported, not offered again. */
  signInAttempted?: boolean;
}

function freshTabId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Open the agent chat focused on a specific ACP session, reloading its
 * transcript from disk. A tab that already holds the session is shown in its
 * own project; otherwise the session opens in the active project (the caller
 * switches projects first). Mirrors `openThread`'s load flow (`open-thread.ts`:
 * focus-if-open, reuse-a-reusable-tab-else-new) so it can be invoked from
 * anywhere.
 */
export async function openAgentSession({
  acpSessionId,
  title,
  cwd,
  agentType,
  newTab,
  signInAttempted,
}: OpenOpts): Promise<void> {
  const chat = useChatStore.getState();
  const layout = useLayoutStore.getState();
  const { addTab, setActiveTab } = layout.actions;
  const {
    createSession,
    setAcpBinding,
    setSessionTitle,
    clearSession,
    setTranscriptLoading,
    setResumePending,
    replaceMessages,
    hydrateSessionSnapshot,
  } = chat.actions;

  // 1. Already open in a LIVE tab, in any project → show it (covers re-clicks
  //    + running chats). Closing a chat tab leaves its chat-store session
  //    behind (orphan), so only a tab that still exists counts — otherwise
  //    `setActiveTab` can't find the dead tab and bounces to tab[0]. A tab saved
  //    with this session and not shown since (`pendingRestore`) counts too:
  //    loading it into a second tab left two holders, and the saved one took
  //    the session back the first time it was shown.
  const holder = findSessionHolder(acpSessionId);
  if (holder) {
    await showTab(holder);
    return;
  }

  // 2. Pick a target chat tab: reuse the active chat tab only when nothing in
  //    it would be lost (`canReuseTab`: not mid-turn, nothing queued, held or
  //    drafted), and never for a branch; otherwise a FRESH tab.
  const activeId = layout.activeTabId;
  const activeSession = activeId ? chat.sessions[activeId] : undefined;
  const reuse = !newTab && canReuseTab(activeId);
  const targetTabId = reuse && activeId ? activeId : freshTabId();

  if (targetTabId !== activeId) {
    addTab({
      id: targetTabId,
      type: "chat",
      title: title.slice(0, 40) || "Session",
      closable: true,
      dirty: false,
      data: {},
    });
    createSession(targetTabId);
  }
  setActiveTab(targetTabId);

  // No session to restore (a never-messaged chat) → leave the empty tab.
  if (!acpSessionId) return;

  // If we're reusing the current tab in place and it held a real (messaged)
  // chat, that chat loses its live sidebar row on clear — refresh the disk
  // lists so it re-lists from history immediately (the native agent and Codex have no watcher).
  const abandoningCurrent =
    reuse &&
    targetTabId === activeId &&
    !!activeSession &&
    ((activeSession.userMessageCount ?? 0) > 0 || activeSession.messages.length > 0);

  // Optimistic bind + spinner, then hydrate from the (cached) Rust session.
  clearSession(targetTabId);
  if (abandoningCurrent) refreshSessionLists();
  setSessionTitle(targetTabId, title.slice(0, 40));
  // Resume through the session's OWN agent — loading a Codex/OpenCode session
  // through the Claude plugin fails and falls back to a blank chat.
  const pluginId = pluginIdForAgent(agentType);
  if (agentType && agentType !== "custom") {
    useChatStore.getState().actions.setSessionAgentType(targetTabId, agentType);
  }
  const cached = getAgentSync(pluginId);
  if (cached) setAcpBinding(targetTabId, cached.agent_id, acpSessionId, cwd);
  // The binding above is optimistic — gate sends until the backend really has
  // the session (see `ChatSession.resumePending`).
  setResumePending(targetTabId, true);
  setTranscriptLoading(targetTabId, true);
  // The tab can be given something else while this loads (New chat, a sidebar
  // click, another tab taking the session): each of them supersedes the load,
  // and nothing below may then paint or bind over what the tab shows now.
  const token = bumpLoadToken(targetTabId);
  const isStale = () => isLoadStale(targetTabId, token);
  try {
    // One paint, once the session is loaded and complete. See
    // `resumeSessionFast` for why the old paint-from-disk-first stage went.
    const { agent, snapshot } = await resumeSessionFast({
      sessionId: acpSessionId,
      cwd,
      ensure: () => ensureAgent(pluginId),
      cb: {
        paint: (msgs, asOfSeq) => replaceMessages(targetTabId, msgs, asOfSeq),
        onPainted: () => setTranscriptLoading(targetTabId, false),
        isStale,
      },
    });
    if (isStale()) return;
    setAcpBinding(targetTabId, agent.agent_id, acpSessionId, cwd);
    // Restore live status + docked plan AFTER the bind (which clears the plan).
    hydrateSessionSnapshot(
      targetTabId,
      snapshot.status,
      snapshot.plan,
      snapshot.subagents,
      snapshotLive(snapshot),
    );
    // This path seeded the mode pill from the stored preference but never told
    // the agent, so the pill could read Bypass while the engine enforced Ask.
    // Applied before `setResumePending(false)`, which is what releases a queued
    // prompt: after it, the first turn can beat the mode to the agent.
    await applyModeOnResume(
      targetTabId,
      { agent_id: agent.agent_id, session_id: acpSessionId },
      snapshot,
    );
    if (isStale()) return;
    setTranscriptLoading(targetTabId, false);
    setResumePending(targetTabId, false);
  } catch (err) {
    if (isStale()) return;
    // `errInfo`: the spawn/load commands in this path reject with a structured
    // `{message, kind}` that would render as "[object Object]".
    const message = errInfo(err).message;
    if (err instanceof ResumeError && err.stage === "snapshot") {
      // The session is open but its mode was never applied: hold sends until
      // a pick, before the gate below opens.
      setTranscriptLoading(targetTabId, false);
      holdUnrestoredMode(targetTabId);
      setResumePending(targetTabId, false);
      toast.error(`Couldn't open session: ${message}`);
      return;
    }
    // The agent never opened it. A tab left bound to it (the optimistic bind
    // above) is stranded: its bind effect skips a bound tab, and every send
    // goes to a session the agent does not have. Same rollback as a history
    // open (`loadThreadIntoTab`), keeping what the user sent meanwhile.
    const kept = clearKeepingUnsent(targetTabId);
    // Refused for want of a sign-in (ACP audit finding 64): the dialog, as a
    // new session's bind offers, and the open again once it lands.
    const offered = offerSignInOnRefusal(
      useChatStore.getState().sessions[targetTabId]?.agentType ?? agentType,
      err,
      () =>
        void openAgentSession({
          acpSessionId,
          title,
          cwd,
          agentType,
          newTab,
          signInAttempted: true,
        }),
      signInAttempted,
    );
    if (offered) return;
    toast.error(
      `Couldn't open session: ${message}` + (kept ? " What you sent is back in the composer." : ""),
    );
  }
}

/**
 * Open / focus the SINGLE agent chat tab and start a fresh chat in it.
 *
 * The agent chat is a singleton tab — "New chat" never spawns a second tab
 * (the user switches between past chats via the session-history sidebar). If a
 * chat tab is already open we focus it and reset its session in place (a brand
 * new session in the SAME tab); the previous conversation, if any, is already
 * persisted to disk per-turn, so it stays reachable from the history sidebar.
 * The fresh session is NOT added to history until the user actually submits
 * (the sidebar filters on `userMessageCount > 0`).
 *
 * If the current chat is BUSY (running, or waiting on a permission), it is left
 * completely alone — Atlas's whole point is many agents working concurrently, so
 * "new chat" must never stop or orphan a live turn. We open a fresh tab beside
 * it instead (multiple chat tabs already coexist — `openAgentSession` spawns one
 * whenever the active chat is running). Only an IDLE chat is reset in place.
 *
 * `agent` binds the fresh session to a specific agent. Switching agents does
 * not come through here: it always opens a new tab once the chat has a
 * conversation (`openAgentChatInNewTab`), so it never resets one.
 */
/** Returns the tab the fresh chat is in. */
export function openNewAgentChat(agent?: SwitchableAgent): string {
  // This is a public entry point that WILL get wired as an event handler again
  // someday — a React SyntheticEvent arriving here once reached the store as
  // agentType and broke the whole bind pipeline. Anything non-string means
  // "no agent preference".
  if (typeof agent !== "string") agent = undefined;
  const layout = useLayoutStore.getState();
  const chat = useChatStore.getState();
  const { setActiveTab } = layout.actions;
  const { clearSession, switchChatAgent } = chat.actions;

  const focus = (id: string) => emitWindowEvent("atlas:chat-focus", { tabId: id });

  // Prefer the ACTIVE chat tab; fall back to the first chat tab. Multiple chat
  // tabs can coexist (handleOpenAgent spawns a new one when the current chat is
  // running), so `tabs.find(type==="chat")` alone could reset a tab the user
  // isn't even looking at.
  const activeChatTab = layout.activeTabId
    ? layout.tabs.find((t) => t.id === layout.activeTabId && t.type === "chat")
    : undefined;
  const existing = activeChatTab ?? layout.tabs.find((t) => t.type === "chat");
  if (existing && canReuseTab(existing.id)) {
    setActiveTab(existing.id);
    // Cancel any in-flight history load targeting this tab BEFORE clearing, so a
    // resolving `loadSession → replaceMessages` chain can't repaint the freshly
    // cleared blank session with the old transcript.
    invalidateLoad(existing.id);
    clearSession(existing.id);
    if (agent) switchChatAgent(existing.id, agent);
    focus(existing.id);
    // The abandoned conversation persists to disk per-turn, but its live row was
    // the sidebar's only handle on it until a disk refetch. Re-list now so it
    // stays in history instead of vanishing.
    refreshSessionLists();
    return existing.id;
  }

  // No chat tab open, or the current chat is mid-turn or holds something the
  // user sent or wrote → fresh tab.
  return openAgentChatInNewTab(agent);
}

/**
 * Open a fresh agent chat in a NEW tab, never touching any existing chat.
 *
 * Switching agents on a chat that already has a conversation routes here, so
 * the conversation stays on screen beside the new agent instead of being
 * cleared out of its tab (a session is paired to one agent for its lifetime,
 * so the new agent needs a session of its own either way).
 *
 * `background` opens it without showing it: the user stays where they are
 * (`askAgent` sending from a surface), and the active session stays active.
 */
export function openAgentChatInNewTab(
  agent?: SwitchableAgent,
  opts: { model?: string; background?: boolean } = {},
): string {
  if (typeof agent !== "string") agent = undefined;
  const { addTab, addBackgroundTab, setActiveTab } = useLayoutStore.getState().actions;
  const { createSession, switchChatAgent, setAcpModel, setActiveSession } =
    useChatStore.getState().actions;
  const id = freshTabId();
  const tab = {
    id,
    type: "chat" as const,
    title: "Agents",
    closable: true,
    dirty: false,
    data: {},
  };
  const activeSession = useChatStore.getState().activeSessionId;
  if (opts.background) addBackgroundTab(tab);
  else addTab(tab);
  createSession(id);
  if (agent) switchChatAgent(id, agent);
  // Unbound, so this only records the pick; the bind applies it.
  if (agent && opts.model) setAcpModel(id, opts.model);
  if (opts.background) {
    // `createSession` makes the new session the active one. Hand it back,
    // unless the new tab is the one in view (its column had no other).
    if (useLayoutStore.getState().activeTabId !== id) setActiveSession(activeSession);
    return id;
  }
  setActiveTab(id);
  emitWindowEvent("atlas:chat-focus", { tabId: id });
  return id;
}
