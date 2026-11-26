import { isWindowFocused, onWindowFocusChange } from "@/lib/window-focus";
import { useEffect, useRef } from "react";
import { isBusyAgentStatus } from "@/types/agent";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "../stores/chat-store";
import { useSessionLifecycleStore } from "../stores/session-lifecycle-store";

/**
 * Marks the session in front of the user as viewed — what clears "unread"
 * and "Woke" — through the lifecycle store's debounced `noteViewed`.
 *
 * "In front of the user" is the live session of the tab the layout shows in
 * the focused column, while the window has focus. The layout's tab, not the
 * chat store's `activeSessionId`: a tab switch never updates that, so a chat
 * switched to was never marked, and the one switched away from was marked
 * when its turn finished behind another tab (ACP audit finding 103).
 *
 * It is marked when the tab becomes active, when the window regains focus,
 * and when a turn finishes in it while the user is there (they watched it
 * finish, so that completion is not unread). A turn finishing
 * while the window is in the background stays unread until the user comes
 * back. Switching away before the debounce runs out cancels the mark.
 *
 * Mounted once, by `SessionViewedTracker`.
 */
export function useMarkActiveSessionViewed(): void {
  const tab = useLayoutStore((s) => s.activeTabId);
  const sessionId = useChatStore((s) => (tab ? (s.sessions[tab]?.acpSessionId ?? null) : null));
  // The session's agent: two agents can share a session id (#86).
  const agentId = useChatStore((s) => (tab ? s.sessions[tab]?.acpAgentId : undefined));
  const busy = useChatStore((s) => (tab ? isBusyAgentStatus(s.sessions[tab]?.status) : false));
  const current = useRef<{ sessionId: string; agentId?: string } | null>(null);

  useEffect(() => {
    const { noteViewed, cancelViewed } = useSessionLifecycleStore.getState().actions;
    current.current = busy || !sessionId ? null : { sessionId, agentId };
    if (!sessionId || busy) return;
    if (isWindowFocused()) noteViewed(sessionId, agentId);
    return () => cancelViewed(sessionId);
  }, [sessionId, agentId, busy]);

  useEffect(() => {
    const { noteViewed, cancelViewed } = useSessionLifecycleStore.getState().actions;
    const onFocus = () => {
      if (current.current) noteViewed(current.current.sessionId, current.current.agentId);
    };
    const onBlur = () => {
      if (current.current) cancelViewed(current.current.sessionId);
    };
    return onWindowFocusChange((focused) => (focused ? onFocus() : onBlur()));
  }, []);
}

/** Renders nothing; mounts {@link useMarkActiveSessionViewed} once for the app. */
export function SessionViewedTracker(): null {
  useMarkActiveSessionViewed();
  return null;
}
