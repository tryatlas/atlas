// ↑/↓ through what the user sent in this session, as a terminal does.
//
// ↑ on the prompt's first line puts the previous message in the composer, and
// each ↑ after it an older one; ↓ on the last line walks back, and past the
// newest gives back what was being written before ↑. The messages are the
// session's own user rows, read when the key is pressed, so nothing is kept
// beside the chat log. Editing a recalled message, or sending it, leaves the
// walk: the next ↑ starts again from the newest.

import { useCallback, useRef, type RefObject } from "react";
import type { ChatInputHandle } from "../components/chat-input";
import { useChatStore } from "../stores/chat-store";
import { recalledText } from "./use-composer-text";

export function useComposerHistory({
  tabId,
  inputRef,
  projectPath,
  writeComposer,
  pickerOpen,
}: {
  tabId: string;
  inputRef: RefObject<ChatInputHandle | null>;
  projectPath: string | null;
  writeComposer: (text: string) => void;
  /** An open `@` or `/` picker owns ↑/↓. */
  pickerOpen: () => boolean;
}) {
  // Where the walk is: -1 is the user's own text; 0 the newest message.
  const walk = useRef<{
    tabId: string;
    index: number;
    draft: string;
    shown: string;
    /** How many messages had been sent: a send ends the walk even when the
     *  user then types the recalled text again. */
    sentCount: number;
  } | null>(null);

  return useCallback(
    (event: KeyboardEvent): boolean => {
      const up = event.key === "ArrowUp";
      if (!up && event.key !== "ArrowDown") return false;
      if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return false;
      const input = inputRef.current;
      if (!input || pickerOpen() || !input.caretAtEdge(up ? "up" : "down")) return false;

      const current = input.getValue();
      const sent = sentMessages(tabId);
      // Still on what ↑ last put there? Otherwise the user moved on (edited
      // it, sent it, or switched tab), and a walk starts from their text.
      let state = walk.current;
      if (
        !state ||
        state.tabId !== tabId ||
        state.shown !== current ||
        state.sentCount !== sent.length
      ) {
        // Nothing sent yet: ↑ is the editor's (to the line's start).
        if (!up || sent.length === 0) return false;
        state = { tabId, index: -1, draft: current, shown: current, sentCount: sent.length };
      }

      const next = state.index + (up ? 1 : -1);
      if (next >= sent.length) return true; // the oldest: stay, and keep the caret
      const text = next < 0 ? state.draft : recalledText(sent[next], projectPath);
      writeComposer(text);
      walk.current = next < 0 ? null : { ...state, index: next, shown: input.getValue() };
      return true;
    },
    [tabId, inputRef, projectPath, writeComposer, pickerOpen],
  );
}

/** The session's user messages as sent, newest first, without the Atlas
 *  context the composer appends, empty ones (an image alone) and a message
 *  repeated straight after itself. */
export function sentMessages(tabId: string): string[] {
  const messages = useChatStore.getState().sessions[tabId]?.messages ?? [];
  const out: string[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    // Trailing space only: a message led by indented code keeps its indent.
    const text = (m.atlasProse ?? m.content).trimEnd();
    if (text.trim() && text !== out[out.length - 1]) out.push(text);
  }
  return out;
}
