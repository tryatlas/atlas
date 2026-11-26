// A seeded scenario's conversation, opened in the first chat tab.
//
// A scenario that gives a transcript (`setSeedTranscript`, `setSessionSeeder`)
// means "this world opens on that conversation". The fake agent used to play
// it into the session the first chat tab started on mount, and the app no
// longer starts one there: a tab gets a session when its user writes
// (`use-agent-bind.ts`). Every seeded scenario then opened on an empty chat,
// and its scripted turns and `__atlasMock.actions` found no session.
//
// In the app, a conversation on screen that nobody typed is a stored session
// someone opened. So the seed is one: this opens it through the call a
// sidebar row makes (`loadThreadIntoTab`), and the fake backend answers
// `threads_resume` for it as the agent reloading that session
// (`resumeSeed`). Nothing here pretends the user wrote, and the app's own
// load path is what puts the transcript on screen.

import { useChatStore } from "@/features/chat/stores/chat-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { isChatTabShown } from "@/features/chat/lib/chat-tab-session";
import { loadThreadIntoTab } from "@/features/chat/lib/open-thread";
import { projectPathForTab } from "@/features/chat/lib/tab-project";
import { pluginIdForAgent } from "@/types/agent";
import { SEED_THREAD_ID, hasSeed, prepareSeed, resendTitle } from "./fake-agent";

/** How long the first chat tab is waited for. A scenario that boots into a
 *  dialog (First run) has none until the dialog is answered. */
const TAB_WAIT_MS = 5_000;

/** The chat tab on screen that has no agent session yet, once there is one. */
async function emptyShownChatTab(): Promise<string | null> {
  const deadline = Date.now() + TAB_WAIT_MS;
  for (;;) {
    const layout = useLayoutStore.getState();
    const { sessions } = useChatStore.getState();
    const tabId = Object.keys(sessions).find(
      (id) => isChatTabShown(layout, id) && !sessions[id]?.acpSessionId,
    );
    if (tabId) return tabId;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Open the scenario's seed, if it has one for the chat tab on screen, in that
 * tab. Resolves once the session is in the tab, so a scenario's `setup` that
 * scripts turns into it can run straight after. Answers whether one was
 * opened.
 */
export async function openSeedSession(): Promise<boolean> {
  if (!hasSeed()) return false;
  const tabId = await emptyShownChatTab();
  if (!tabId) {
    console.warn("[mock-backend] seed not opened: no empty chat tab on screen");
    return false;
  }
  const session = useChatStore.getState().sessions[tabId];
  if (!session) return false;
  const cwd = projectPathForTab(tabId) ?? "";
  const sessionId = prepareSeed({ pluginId: pluginIdForAgent(session.agentType), cwd });
  if (!sessionId) return false;
  const opened = await loadThreadIntoTab(
    tabId,
    {
      threadId: SEED_THREAD_ID,
      // None to bind ahead of the load: `threads_resume` names the session.
      sessionId: "",
      title: session.title,
      agent: session.agentType,
      cwd,
      projectPath: cwd,
    },
    { keep: true },
  );
  if (opened) await resendTitle(sessionId);
  return opened;
}
