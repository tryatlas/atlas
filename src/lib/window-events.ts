/**
 * Window events: how features talk to each other without importing each
 * other. A DOM `CustomEvent` on `window`, dispatched synchronously, fire and
 * forget. This file is the only place their names live.
 *
 * Two namespaces share the `atlas:` prefix, and this map is what tells them
 * apart:
 *
 *   - a **window event** is TypeScript to TypeScript and is declared in
 *     `AtlasWindowEvents` below. It goes through `emitWindowEvent`,
 *     `onWindowEvent` and `useWindowEvent`, and through nothing else.
 *   - a **Tauri channel** crosses the IPC boundary (Rust emits, or another
 *     window does) and goes through `listen` / `emit` from
 *     `@tauri-apps/api/event`, wrapped in a feature's `*-api.ts`.
 *
 * So "is this a window event?" is answered by whether the name is a key of
 * the map. `tests/window-event-contract.test.ts` holds that line: no window
 * event name as a literal anywhere but the first argument of a helper, no
 * direct `dispatchEvent`/`addEventListener` on one, no name that is also a
 * Tauri channel, and no event without both an emitter and a listener.
 *
 * Adding an event: one entry in the map, with the `detail` it carries
 * (`void` for none). A wrong name or payload at a call site then fails
 * `bun run typecheck`.
 */

import { useEffect, useLayoutEffect, useRef } from "react";
import type { JumpDetail } from "@/features/artifacts/lib/session-jump";
import type { ChatSendDetail } from "@/features/chat/hooks/use-queue-drain";
import type { AgentSignInRequest } from "@/features/chat/lib/agent-signin";
import type { CommentLinkDetail } from "@/features/chat/lib/comment-mentions";
import type { ChatJumpDetail } from "@/features/chat/lib/jump-to-comment";
import type { TurnDiffRequest } from "@/features/chat/lib/open-turn-diff";
import type { ChatInsertDetail } from "@/features/chat/lib/response-selection";
import type { ReviewUnlinkDetail } from "@/features/chat/lib/review-comments";
import type { SessionHandoffDetail } from "@/features/chat/lib/switch-agent";
import type { CommsJumpDetail } from "@/features/org-agent/lib/org-agent-navigate";

/** An event addressed to one tab; every mounted panel hears it and only the
 *  one named acts. */
interface ForTab {
  tabId: string;
}

/**
 * Every window event, and the `detail` it carries. `void` is an event with
 * no payload.
 */
export interface AtlasWindowEvents {
  // ── App shell ────────────────────────────────────────────────────────────
  /** Hydration finished (or failed): `index.html` drops the boot skeleton. */
  "atlas:app-ready": void;
  /** The window came to the front, or the page became visible: the "cold
   *  wake" edge (`src/lib/window-focus.ts`). */
  "atlas:window-active": void;
  /** The active theme's variables were just written (`applyTheme`). Anything
   *  holding a resolved colour re-reads it. */
  "atlas:theme-applied": void;
  /** Display settings (font, size, …) were just written to the document. */
  "atlas:display-settings-applied": void;
  "atlas:command-palette": void;
  "atlas:new-tab-palette": void;
  /** Open the ⌘T surface menu of one tab column. */
  "atlas:open-surface-menu": { groupId: string };
  "atlas:open-capture": void;
  "atlas:toggle-session-details": void;
  "atlas:open-session-in-editor": void;

  // ── A session's panel and composer ───────────────────────────────────────
  /** Send `text` as a tab's next message. Without `tabId` every mounted
   *  panel takes it. A cancelable emit learns whether a panel did. */
  "atlas:chat-send": ChatSendDetail;
  /** Stop a tab's running turn, as its Stop button does. */
  "atlas:chat-stop": ForTab;
  /** Scroll a transcript to a message. Without `tabId` every mounted
   *  transcript moves. */
  "atlas:chat-jump": ChatJumpDetail;
  "atlas:chat-focus": ForTab;
  /** A composer took the focus. Retries a saved conversation's load that
   *  could not start; it starts no new session, since a composer takes the
   *  focus on its own whenever its tab is shown. */
  "atlas:chat-input-focused": ForTab;
  /** The user is writing in a composer whose tab has no agent session yet:
   *  the tab starts one. */
  "atlas:chat-input-started": ForTab;
  /** Replace a composer's draft. Without `tabId` every mounted one does. */
  "atlas:chat-prefill": { text: string; tabId?: string };
  /** Write into a composer's draft, keeping what is there. */
  "atlas:chat-insert": ChatInsertDetail;
  /** Quote a message into the composer. */
  "atlas:chat-reply": { content: string };
  "atlas:chat-link-comment": CommentLinkDetail;
  "atlas:chat-unlink-review-comment": ReviewUnlinkDetail;
  "atlas:chat-handoff-session": SessionHandoffDetail;
  "atlas:chat-open-find": ForTab;
  /** One of a composer's menus opened: the others close. The detail is the
   *  id of the menu that opened. */
  "atlas:composer-menu-open": string;
  "atlas:composer-open-mode": ForTab;
  "atlas:composer-open-model": ForTab;
  "atlas:open-turn-diff": TurnDiffRequest;
  "atlas:plan-saved": void;
  /** A turn failed for want of credentials: the tab that owns `sessionId`
   *  offers the sign-in. */
  "atlas:auth-required": { sessionId: string; agentType: string; reason?: string };
  "atlas:agent-signin": AgentSignInRequest;

  // ── Other features ───────────────────────────────────────────────────────
  "atlas:session-chat-jump": JumpDetail;
  "atlas:comms-jump-to-message": CommsJumpDetail;
  "atlas:org-agent-report": { askId: string; title: string; partial: boolean };
  /** A repository was cloned or linked: project lists re-read. */
  "atlas:repo-cloned": void;
  /** Skills or packs changed on disk: pickers and lists re-read. */
  "atlas:skills-changed": void;
}

export type WindowEventName = keyof AtlasWindowEvents;

/** What a listener is handed: the detail, then the event itself, for the
 *  few that mark it handled with `preventDefault`. */
export type WindowEventHandler<K extends WindowEventName> = (
  detail: AtlasWindowEvents[K],
  event: CustomEvent<AtlasWindowEvents[K]>,
) => void;

export interface EmitWindowEventOptions {
  /** Let a listener mark the event handled with `event.preventDefault()`;
   *  the emit then returns `false`. Off by default, as on `CustomEvent`. */
  cancelable?: boolean;
}

type EmitArgs<K extends WindowEventName> = [AtlasWindowEvents[K]] extends [void]
  ? [detail?: undefined, options?: EmitWindowEventOptions]
  : [detail: AtlasWindowEvents[K], options?: EmitWindowEventOptions];

/**
 * Dispatch a window event, synchronously: every listener has run by the time
 * this returns. Returns what `dispatchEvent` does: `false` only when the
 * emit was `cancelable` and a listener called `preventDefault`.
 */
export function emitWindowEvent<K extends WindowEventName>(
  name: K,
  ...[detail, options]: EmitArgs<K>
): boolean {
  return window.dispatchEvent(
    new CustomEvent(name, { detail, cancelable: options?.cancelable ?? false }),
  );
}

/** Listen for a window event. Returns the unsubscribe. */
export function onWindowEvent<K extends WindowEventName>(
  name: K,
  handler: WindowEventHandler<K>,
): () => void {
  const listener = (event: Event) => {
    const custom = event as CustomEvent<AtlasWindowEvents[K]>;
    handler(custom.detail, custom);
  };
  window.addEventListener(name, listener);
  return () => window.removeEventListener(name, listener);
}

/**
 * Listen for a window event for as long as the component is mounted. The
 * subscription is made once; the handler called is always the latest render's,
 * so it may read props and state without being memoised.
 *
 * For an effect that subscribes conditionally, or does more than subscribe,
 * call `onWindowEvent` inside that effect and return its unsubscribe.
 */
export function useWindowEvent<K extends WindowEventName>(
  name: K,
  handler: WindowEventHandler<K>,
): void {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  useEffect(() => onWindowEvent(name, (detail, event) => latest.current(detail, event)), [name]);
}
