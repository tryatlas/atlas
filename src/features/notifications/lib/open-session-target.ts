/**
 * Where a session notification goes when it is clicked, and what a session
 * with no tab is called in one.
 *
 * A session target normally names the tab showing it. A session that no tab
 * shows — a pull request watch woke it in the background — carries its
 * `threadId` instead, and a click resumes it from history the way a sidebar
 * click does (`openThread`).
 */
import { jumpToSession } from "@/features/chat/lib/tab-project";
import { threadProjects } from "@/features/chat/lib/history-api";
import { sidebarAgentOf } from "@/features/chat/lib/sidebar-agents";
import { activeOrgProjectsSnapshot } from "@/features/projects/lib/org-scope";
import { useProjectStore } from "@/features/projects/stores/project-store";
import { findSessionHolder, openTabIds } from "@/features/chat/lib/session-tab-reuse";
import { matchProject } from "@/features/sidebar/lib/sidebar-sessions";
import type { Project } from "@/features/projects/stores/project-store";
import { findHistorySession, type HistorySession } from "./agent-notifier-rules";

/** The open tab, in any project, showing ACP session `sessionId`, if one
 *  does (`findSessionHolder`). */
export function openTabForSession(sessionId: string | undefined): string | null {
  return findSessionHolder(sessionId);
}

/** A session no tab shows, as history lists it, with the project it belongs
 *  to (the active organisation's first, then any). */
export interface ResolvedHistorySession extends HistorySession {
  project: Project | null;
  /** Where it resumes. */
  cwd: string;
}

export async function resolveHistorySession(
  threadId: string,
  sessionId?: string,
): Promise<ResolvedHistorySession | null> {
  const found = findHistorySession(await threadProjects(""), threadId, sessionId);
  if (!found) return null;
  const paths = [...found.row.folderPaths, ...found.groupPaths];
  const project =
    matchProject(paths, activeOrgProjectsSnapshot()) ??
    matchProject(paths, useProjectStore.getState().projects);
  const fromStore = project
    ? (useProjectStore.getState().projects.find((p) => p.id === project.id) ?? null)
    : null;
  return { ...found, project: fromStore, cwd: paths[0] ?? fromStore?.path ?? "" };
}

/** Open a session target. The session is the target, not the tab that was
 *  showing it when the notification was raised: that tab may have been given
 *  another conversation since. So the tab holding the session now, in any
 *  project; else the session resumed from history (by its thread id, or its
 *  session id). The remembered tab is only the answer for a target that names
 *  no session. */
export async function openSessionTarget(t: {
  tabId: string;
  sessionId?: string;
  threadId?: string;
}): Promise<void> {
  if (!t.sessionId) {
    if (t.tabId && openTabIds().has(t.tabId)) return jumpToSession(t.tabId);
    if (!t.threadId) return;
  }
  const shown = openTabForSession(t.sessionId);
  if (shown) return jumpToSession(shown);
  const resolved = await resolveHistorySession(t.threadId ?? "", t.sessionId);
  if (!resolved) return;
  const { row, project, cwd } = resolved;
  // Loaded on use: resuming a session pulls in the whole bind path.
  const { openThread } = await import("@/features/chat/lib/open-thread");
  await openThread({
    threadId: row.threadId,
    sessionId: row.sessionId ?? "",
    title: row.title,
    agent: sidebarAgentOf(row.agentId),
    cwd,
    projectPath: project?.path ?? cwd,
  });
}
