import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { useComposerFold } from "./use-composer-fold";
import { emitWindowEvent } from "@/lib/window-events";
import { useChatStore } from "../stores/chat-store";

/** The composer's focused / folded form: focus moving into it opens it; focus
 *  moving elsewhere, a press outside, or Esc folds it (when `collapsible`). */
export function useComposerFocus({
  composerRef,
  collapsible,
  inputCardRef,
  trayRef,
}: {
  composerRef: RefObject<HTMLDivElement | null>;
  collapsible: boolean;
  inputCardRef: RefObject<HTMLDivElement | null>;
  trayRef: RefObject<HTMLDivElement | null>;
}) {
  const [composerFocused, setComposerFocused] = useState(false);
  const collapsed = collapsible && !composerFocused;
  const trayShown = useComposerFold(collapsed, inputCardRef, trayRef);
  // What folds it: focus moving to something ELSE (Tab away), a press
  // outside it, or Esc. Not focus merely leaving: WebKit does not focus a
  // button on click, so pressing a tray pill drops focus to <body> — read as
  // "left", that folded the tray out from under the pill being pressed.
  // Never while one of its menus is open (they may live in a portal), nor
  // when the WINDOW lost focus (switching apps is not leaving the composer).
  const composerMenuOpen = () =>
    !!composerRef.current?.querySelector("[data-popup-open], [aria-expanded='true']");
  const onComposerBlur = useCallback(() => {
    requestAnimationFrame(() => {
      if (!document.hasFocus()) return;
      const root = composerRef.current;
      const active = document.activeElement;
      if (!root || !active || active === document.body) return;
      if (root.contains(active) || composerMenuOpen()) return;
      setComposerFocused(false);
    });
  }, []);
  useEffect(() => {
    if (!composerFocused) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = composerRef.current;
      if (!root || !(event.target instanceof Node) || root.contains(event.target)) return;
      if (composerMenuOpen()) return;
      setComposerFocused(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [composerFocused]);

  return { setComposerFocused, collapsed, trayShown, onComposerBlur };
}

/** Fire `atlas:chat-input-focused` whenever this composer takes focus. A
 *  saved conversation's load that could not start listens for it to try
 *  again. It starts no new session: the composer takes the focus by itself
 *  whenever its tab is shown (see `useChatInputStartedSignal`). */
export function useChatInputFocusedSignal(tabId: string, disabled: boolean) {
  return useCallback(() => {
    // The toolbar (agent / model pickers) stays interactive while the composer
    // is disabled, so focus can now reach this handler from a control rather
    // than the text area. Don't kick off an agent bind against a CLI that
    // isn't ready — the user is most likely on their way to switching agents.
    if (disabled) return;
    emitWindowEvent("atlas:chat-input-focused", { tabId });
  }, [tabId, disabled]);
}

/** The signal that a composer's user is writing: `atlas:chat-input-started`,
 *  fired for every change to a composer that is not blank while its tab has
 *  no agent session, which is what starts one (`use-agent-bind.ts`).
 *
 *  Writing, not showing or focusing, because the session is the user's: a
 *  launch and a project switch show a chat and focus its composer by
 *  themselves, and an agent that stores every session it opens (opencode)
 *  kept one empty session per launch per project. Writing still comes before
 *  the slash picker, so the agent's commands are on their way by the time
 *  `/` is typed.
 *
 *  Every change, not only the first: a draft restored at mount never crosses
 *  blank→not blank, and a start that failed is asked for again by whatever is
 *  written next. Once the tab is bound nothing is fired.
 *
 *  `noteBlank` takes the editor's `onEmptyChange` edge and `noteWritten` its
 *  `onDocChange`; the editor reports the edge first. */
export function useChatInputStartedSignal(tabId: string, disabled: boolean, startsBlank: boolean) {
  const blankRef = useRef(startsBlank);
  const noteBlank = useCallback((blank: boolean) => {
    blankRef.current = blank;
  }, []);
  const noteWritten = useCallback(() => {
    // As for focus: a disabled composer's agent is not ready to start.
    if (blankRef.current || disabled) return;
    if (useChatStore.getState().sessions[tabId]?.acpSessionId) return;
    emitWindowEvent("atlas:chat-input-started", { tabId });
  }, [tabId, disabled]);
  return { noteBlank, noteWritten };
}
