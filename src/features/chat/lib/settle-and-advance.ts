/**
 * The settle keybinding's route to the sidebar.
 *
 * Settling the open session has to move the chat somewhere, and only the
 * sidebar knows the list it would move along — so the shell's chord asks the
 * sidebar to do it, naming the chat tab in front. The app has one sidebar; it
 * registers itself here while mounted.
 */

type SettleHandler = (tabId: string) => void;

let handler: SettleHandler | null = null;

/** Make `next` the settle action; returns the matching unregister, which
 *  leaves a newer registration alone. */
export function registerSettleAndAdvance(next: SettleHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/** Settle (or un-settle) the session open in `tabId`, with or without a sidebar. */
export function settleAndAdvance(tabId: string): boolean {
  if (!handler) {
    settleOutsideSidebar(tabId);
    return true;
  }
  handler(tabId);
  return true;
}

const pending = new Set<string>();

/** The active chat remains actionable when the sidebar is hidden or filtered. */
export function settleOutsideSidebar(tabId: string): void {
  if (pending.has(tabId)) return;
  pending.add(tabId);
  void (async () => {
    const [
      { useChatStore },
      { threadProjects },
      { activeOrgProjectsSnapshot },
      { useOrgStore },
      { useSettingsStore },
      { partitionSidebarSessions },
      actions,
      { toast },
    ] = await Promise.all([
      import("../stores/chat-store"),
      import("./history-api"),
      import("@/features/projects/lib/org-scope"),
      import("@/features/organisations/stores/org-store"),
      import("@/features/settings/stores/settings-store"),
      import("@/features/sidebar/lib/sidebar-sessions"),
      import("@/features/sidebar/lib/sidebar-actions"),
      import("sonner"),
    ]);
    const sessionId = useChatStore.getState().sessions[tabId]?.acpSessionId;
    if (!sessionId) {
      toast.info("Nothing to settle: this session has no messages yet.");
      return;
    }
    const orgId = useOrgStore.getState().activeOrganisationId;
    const projects = activeOrgProjectsSnapshot();
    const groups = await threadProjects("");
    if (
      useOrgStore.getState().activeOrganisationId !== orgId ||
      useChatStore.getState().sessions[tabId]?.acpSessionId !== sessionId
    )
      return;
    const list = partitionSidebarSessions({
      groups,
      projects,
      scopeProjectId: null,
      now: Date.now(),
      sort: useSettingsStore.getState().settings.sidebarSort,
    });
    const session = [...list.pinned, ...list.active, ...list.snoozed, ...list.settled].find(
      (row) => row.sessionId === sessionId,
    );
    if (!session) {
      toast.info("This session is not yet available in history. Try again in a moment.");
      return;
    }
    if (session.settledAt !== null) actions.unsettleSession(session);
    else await actions.settleSession(session, { ...list, activeSessionId: sessionId });
  })()
    .catch(async (error: unknown) => {
      const { toast } = await import("sonner");
      toast.error("Could not settle this session", { description: String(error) });
    })
    .finally(() => pending.delete(tabId));
}
