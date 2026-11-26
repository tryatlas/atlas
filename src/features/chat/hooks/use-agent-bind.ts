import { useEffect, type RefObject } from "react";
import type { ChatSession } from "@/types/agent";
import { onWindowEvent } from "@/lib/window-events";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "../stores/chat-store";
import { isChatTabShown } from "../lib/chat-tab-session";
import { restoreTabSession } from "../lib/restore-tab-session";
import { sessionBind, type BindControl } from "../lib/session-bind";

export type { BindControl };

/**
 * Give this tab its agent session when its user starts one: by writing in its
 * composer, or by sending to it.
 *
 * The thin caller of `lib/session-bind.ts`, which is where a bind is carried
 * out and where its rules are argued. This decides only WHEN: while the tab
 * has a chat session and no agent session, it holds the tab's bind, warms it
 * (connects the agent, starts no session) once the tab is shown, and starts
 * it when the composer stops being blank or a message waits on it.
 *
 * A chat panel stays mounted behind whichever tab is showing, and every one
 * of them used to start its session on mount: six chat tabs, six agent
 * sessions in the same 10 ms. Then only the tab on screen did, which still
 * meant a session per launch and per project switched to that nobody asked
 * for, and an agent that stores every session it opens (opencode) listed each
 * as an untitled session of its own. Showing a tab is not asking for a
 * session. Writing is, and it comes before `/`, so the agent's commands are
 * on their way by the time the slash picker wants them; the connect done on
 * show leaves that start only `session/new` to wait for.
 *
 * A tab saved with a conversation (`ChatSession.pendingRestore`) gets that
 * conversation back instead of a new session, on the same two triggers
 * (`lib/restore-tab-session.ts`).
 *
 * `bindControlRef` is the panel's handle on the attempt in flight (Restart,
 * Stop, a send's kick). Null whenever nothing is held (tab already bound, or
 * a session is being loaded into it).
 */
export function useAgentBind(
  tabId: string,
  session: ChatSession | undefined,
  bindControlRef: RefObject<BindControl | null>,
): void {
  const shown = useLayoutStore((s) => isChatTabShown(s, tabId));
  // How many messages wait on this tab's session: a first message held for
  // the bind, and those queued behind it. Someone sent to the tab, shown or
  // not. A count rather than a flag, so that every new one asks again: a start
  // or restore that failed is retried by the next send, not only by writing
  // in its composer (audit #57).
  const waiting = useChatStore(
    (s) => (s.sessions[tabId]?.pendingSend ? 1 : 0) + (s.queues[tabId]?.length ?? 0),
  );
  const pendingRestore = session?.pendingRestore;
  // The agent spawn takes 1–3 s warm and up to 30 s on a cold `npx` cache,
  // so it is started (warmed) while the user reads the empty chat, and the
  // session itself while they write. If the user hits Send before the bind
  // lands, the submit handler holds the message and the drain effect
  // flushes it once `acpSessionId` is set. Skipped when a session is already
  // bound (sidebar resume, or a tab re-mount).
  useEffect(() => {
    if (!session) return;
    if (session.acpSessionId) return;
    // A stored session is being loaded into the tab and its binding has not
    // landed (the agent was not connected yet, so there was nothing to bind
    // optimistically). Starting a new session here would race the load for
    // the tab, and whichever lost would be left running with no tab.
    if (session.resumePending) return;
    if (pendingRestore) {
      const restore = () => void restoreTabSession(tabId);
      bindControlRef.current = { retry: restore, abandon: () => {}, kick: restore, warm: restore };
      // As below: a composer focus asks again after a load that could not start.
      const offFocused = onWindowEvent("atlas:chat-input-focused", (detail) => {
        if (detail?.tabId === tabId) restore();
      });
      return () => {
        bindControlRef.current = null;
        offFocused();
      };
    }
    const bind = sessionBind.attach(tabId);
    bindControlRef.current = {
      retry: bind.retry,
      abandon: bind.abandon,
      kick: bind.kick,
      warm: bind.warm,
    };
    // Asked for before this attach (the tab switched agent while its start
    // was under way): carry it on, for the agent the tab is on now.
    if (bind.wanted()) bind.kick();
    // The user is writing: the session is wanted now. Also the retry after a
    // bind that failed (the agent was still installing, say): whatever is
    // written next asks again (`useChatInputStartedSignal`).
    const offInputStarted = onWindowEvent("atlas:chat-input-started", (detail) => {
      if (!detail || detail.tabId !== tabId) return;
      if (useChatStore.getState().sessions[tabId]?.acpSessionId) return;
      bind.kick();
    });
    return () => {
      bind.detach();
      bindControlRef.current = null;
      offInputStarted();
    };
    // `!!session` is in the dep list so the bind effect actually
    // fires after the parallel `createSession` effect (chat-panel) flips
    // `session` from null → defined. Without it, deps stay
    // `[tabId, undefined]` across both renders (acpSessionId is
    // still undefined on the newly-created session) so React skips
    // the effect, the bind never starts, and every send sits in
    // the queue forever — the exact "messages get queued on a
    // brand-new project" symptom.
    // `agentType` is in the deps so switching the tab's agent (⌥/) re-runs the
    // bind — its cleanup detaches, which drops any in-flight bind for the
    // previous agent, preventing a stale bind from clobbering the tab. This
    // matters even when acpSessionId was already undefined (switch during the
    // first bind), where acpSessionId alone wouldn't change.
  }, [
    tabId,
    !!session,
    session?.acpSessionId,
    session?.agentType,
    session?.resumePending,
    pendingRestore,
  ]);

  // Start whatever the effect above holds once a message waits on it, shown
  // or not: the send's own kick finds nothing to kick when the message
  // arrives before the panel has mounted (a tab opened in the background for
  // a prompt). Short of that, a tab on screen is only warmed: its agent is
  // connected and a saved conversation reloaded, but no new session starts.
  // Declared second so it runs after the hold exists, and on the same
  // conditions, so a hold that is replaced (an agent switch) is warmed too.
  // A no-op for a bound tab, and for an attempt already running.
  useEffect(() => {
    if (waiting > 0) bindControlRef.current?.kick();
    else if (shown) bindControlRef.current?.warm();
  }, [
    shown,
    waiting,
    tabId,
    !!session,
    session?.acpSessionId,
    session?.agentType,
    session?.resumePending,
    pendingRestore,
  ]);
}
