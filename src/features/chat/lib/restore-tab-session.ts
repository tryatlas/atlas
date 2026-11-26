/**
 * Putting a saved chat tab's conversation back.
 *
 * A chat tab saves the agent session it shows (`chat-tab-session.ts`). After a
 * restart the tab comes back holding only that id (`ChatSession.pendingRestore`):
 * no agent session is started for it and nothing is loaded. This is the load,
 * run the first time the tab is shown or sent to (`use-agent-bind.ts`), so a
 * launch pays for the tab on screen and not for every tab that was open.
 *
 * The session is reopened by the agent, through the same call a sidebar click
 * makes (`loadThreadIntoTab`): the conversation the tab shows is the agent's
 * own, with its context, not a copy.
 */
import { toast } from "sonner";
import { useChatStore } from "../stores/chat-store";
import { errInfo } from "./agent-signin";
import { threadHistory, type ThreadRow } from "./history-api";
import { loadThreadIntoTab } from "./open-thread";
import { sidebarAgentOf } from "./sidebar-agents";
import { projectPathForTab } from "./tab-project";

/** What a restore asks of the rest of the app. A parameter so a test can stand
 *  in for history and the load. */
export interface RestoreDeps {
  history: () => Promise<ThreadRow[]>;
  load: typeof loadThreadIntoTab;
  projectPath: (tabId: string) => string | null;
  error: (message: string) => void;
}

const appDeps: RestoreDeps = {
  history: threadHistory,
  load: loadThreadIntoTab,
  projectPath: projectPathForTab,
  error: (message) => toast.error(message),
};

/** Tabs with a restore in flight: a show and a send can both ask for one. */
const inFlight = new Set<string>();

/**
 * Load the session `tabId` is saved as showing. Does nothing for a tab with
 * none pending, or one already loading.
 *
 * A session history no longer lists was deleted: the tab becomes an ordinary
 * new chat, without a word, since the user removed it themselves. A session
 * the agent cannot reopen is reported by the load and leaves a new chat too;
 * its row is still in the sidebar.
 */
export async function restoreTabSession(tabId: string, deps: RestoreDeps = appDeps): Promise<void> {
  if (inFlight.has(tabId)) return;
  const pending = () => useChatStore.getState().sessions[tabId]?.pendingRestore;
  const sessionId = pending();
  if (!sessionId) return;
  inFlight.add(tabId);
  try {
    let row: ThreadRow | undefined;
    try {
      row = (await deps.history()).find((r) => r.sessionId === sessionId);
    } catch (err) {
      // Another conversation took the tab while history was read: not ours.
      if (pending() !== sessionId) return;
      // History could not be read, which says nothing about the session. The
      // tab keeps waiting for it, so the next show, focus or send asks again;
      // giving up here would start a new chat in the tab and drop its saved
      // id, losing the tab's conversation to one failed read. A message held
      // for it waits in the queue meanwhile, rather than leaving the tab on
      // "Starting…" with nothing starting.
      parkHeld(tabId);
      deps.error(`Couldn't reopen this session: ${errInfo(err).message.slice(0, 120)}`);
      return;
    }
    if (pending() !== sessionId) return;
    const { actions } = useChatStore.getState();
    if (!row) {
      actions.setPendingRestore(tabId, undefined);
      return;
    }
    parkHeld(tabId);
    const projectPath = deps.projectPath(tabId) ?? "";
    const cwd = row.folderPaths[0] ?? projectPath;
    // Cleared in the same tick the load takes the tab (it marks the resume
    // pending before its first await), so no render sees a tab that is neither
    // waiting for its session nor loading it, which is the state a new session
    // is started in.
    actions.setPendingRestore(tabId, undefined);
    await deps.load(
      tabId,
      {
        threadId: row.threadId,
        sessionId,
        title: row.title,
        agent: sidebarAgentOf(row.agentId),
        cwd,
        projectPath: projectPath || cwd,
      },
      { keep: true },
    );
  } finally {
    inFlight.delete(tabId);
  }
}

/**
 * A first message sent to the tab before it was ever shown is held with its
 * bubble already in the transcript, and the load's paint replaces the
 * transcript. Park it in the queue, which the load leaves alone and which
 * drains once the session is back.
 */
function parkHeld(tabId: string): void {
  const { actions, sessions } = useChatStore.getState();
  const held = sessions[tabId]?.pendingSend;
  if (!held) return;
  actions.setPendingSend(tabId, undefined);
  actions.updateSessionStatus(tabId, "idle");
  // With its images: a queue item carries them now (`queueContent`), and the
  // queue is what sends this message once the session is back.
  actions.enqueueMessage(tabId, held.content, held.mentions ?? [], null, held.attachments);
}
