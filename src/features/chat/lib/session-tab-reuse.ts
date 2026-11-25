/**
 * Which tab holds a session, and which tab may be given a different one.
 *
 * The one rule every way of putting a conversation into a tab goes through: a
 * history row (`openThread`), a session id (`openAgentSession`), New chat
 * (`openNewAgentChat`) and a notification click (`openSessionTarget`). They
 * used to carry three rules of their own, and none of them counted what the
 * user had already sent to a tab: an idle tab with a queued or held message,
 * reused, lost the message along with the conversation it was written for.
 *
 * A branch (`forkSessionToNewTab`) never reuses a tab at all: the tab it was
 * started from is the conversation it branched off, and keeping that intact is
 * the point of branching.
 */
import { isBusyAgentStatus } from "@/types/agent";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { useChatStore } from "../stores/chat-store";
import { projectIdForTab } from "./tab-project";

/** Every open tab id, in every project. The live mirror is the active
 *  project's view; `viewsByWs` holds the others. Its entry for the mirror's own
 *  project is the copy last committed, which can still list a tab closed since,
 *  so the mirror answers for that project. */
export function openTabIds(): Set<string> {
  const layout = useLayoutStore.getState();
  const ids = new Set(layout.tabs.map((t) => t.id));
  for (const [wsId, view] of Object.entries(layout.viewsByWs)) {
    if (wsId === layout.currentViewWsId) continue;
    for (const tab of view.tabs) ids.add(tab.id);
  }
  return ids;
}

/** Whether `tabId`'s chat session is, or is waiting to be, `sessionId`. A
 *  saved tab that has not loaded it yet counts (`ChatSession.pendingRestore`):
 *  showing that tab is what loads it, and loading the session into a second tab
 *  would leave two holders. */
export function tabHoldsSession(tabId: string, sessionId: string): boolean {
  if (!sessionId) return false;
  const s = useChatStore.getState().sessions[tabId];
  return !!s && (s.acpSessionId === sessionId || s.pendingRestore === sessionId);
}

/** The open tab, in any project, that holds `sessionId`. A chat-store session
 *  outlives its closed tab, so the tab itself must still exist. The active
 *  project's tabs are preferred when, briefly, two hold it. */
export function findSessionHolder(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const live = new Set(useLayoutStore.getState().tabs.map((t) => t.id));
  const open = openTabIds();
  let elsewhere: string | null = null;
  for (const tabId of Object.keys(useChatStore.getState().sessions)) {
    if (!open.has(tabId) || !tabHoldsSession(tabId, sessionId)) continue;
    if (live.has(tabId)) return tabId;
    elsewhere ??= tabId;
  }
  return elsewhere;
}

/** Why `tabId` may not be given another conversation, or `null` when it may.
 *  Only a chat tab in the active project's view qualifies, and only while
 *  nothing the user did in it is unfinished: a turn running or waiting, a
 *  message held for the session or queued behind it, or a draft in its
 *  composer. */
export function tabReuseRefusal(tabId: string | null | undefined): string | null {
  if (!tabId) return "no tab";
  const tab = useLayoutStore.getState().tabs.find((t) => t.id === tabId);
  if (!tab) return "not open here";
  if (tab.type !== "chat") return "not a chat";
  const { sessions, queues, drafts } = useChatStore.getState();
  const session = sessions[tabId];
  if (isBusyAgentStatus(session?.status)) return "busy";
  if (session?.pendingSend) return "held message";
  if ((queues[tabId]?.length ?? 0) > 0) return "queued messages";
  if (drafts[tabId]?.trim()) return "draft";
  return null;
}

export function canReuseTab(tabId: string | null | undefined): tabId is string {
  return tabReuseRefusal(tabId) === null;
}

/** Bring `tabId` into view, switching first to the project it lives in: a
 *  bare `setActiveTab` on another project's tab falls back to the first tab of
 *  the active one. */
export async function showTab(tabId: string): Promise<void> {
  const projects = useProjectStore.getState();
  const ownerId = projectIdForTab(tabId);
  if (ownerId && ownerId !== projects.activeProjectId) await projects.actions.switchTo(ownerId);
  useLayoutStore.getState().actions.setActiveTab(tabId);
}
