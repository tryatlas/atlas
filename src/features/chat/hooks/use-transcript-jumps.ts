// The transcript's jumps: scroll-to-bottom, scroll-to-message, the comment
// panel's fold-opening reveal, the `atlas:chat-jump` event, and the turn rail
// that drives the same jump. Lifted out of `transcript.tsx` verbatim.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { Projection } from "../lib/turn-rows";
import type { Row } from "@tryatlas/design/session";
import { revealStep } from "../lib/jump-reveal";
import {
  deriveTurnRailItems,
  stableTurnRailItems,
  turnRailPreviewSource,
  type TurnRailItem,
} from "../lib/turn-rail";
import { SCROLL_BOTTOM } from "./use-transcript-window";
import { useWindowEvent } from "@/lib/window-events";

export interface TranscriptJumpsInput {
  tabId: string;
  cacheKey: string;
  projection: Projection;
  rows: Row[];
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Mount row `index` and the turns around it (`useTranscriptWindow`). */
  reveal: (index: number) => void;
  setExpandedTurns: Dispatch<SetStateAction<ReadonlySet<string>>>;
  pendingAnchorRef: RefObject<string | null>;
  pendingHighlightRef: RefObject<string[] | null>;
  lastSeenLen: RefObject<number>;
  setNewCount: Dispatch<SetStateAction<number>>;
}

export function useTranscriptJumps({
  tabId,
  cacheKey,
  projection,
  rows,
  scrollRef,
  reveal,
  setExpandedTurns,
  pendingAnchorRef,
  pendingHighlightRef,
  lastSeenLen,
  setNewCount,
}: TranscriptJumpsInput) {
  // ── Imperative handle + external jumps ───────────────────────────────
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = SCROLL_BOTTOM;
    lastSeenLen.current = rowsRef.current.length;
    setNewCount(0);
  }, []);

  // A jump has two ways of arriving before it can be honoured, and both used
  // to be silently dropped:
  //
  //  * The target row is ALREADY in the window. A `reveal` that changes
  //    nothing schedules no render, so the anchor layout effect never
  //    ran and nothing moved. `jumpTick` exists purely to force that render.
  //  * The caller dispatched in the same tick as a change to the message
  //    list, so the projection
  //    we hold is the OLD one and the index is not in it yet. The index is
  //    parked in `pendingJumpRef` and retried when the projection changes.
  //
  // A jump may name the row it is for (`rowId`, from a reveal that found it).
  // It lands there, not on its turn's first row: a pin or a comment on an
  // answer mid-turn is the answer, and a long turn put it off screen.
  const pendingJumpRef = useRef<{ messageIndex: number; rowId?: string } | null>(null);
  const [, setJumpTick] = useState(0);
  const projectionRef = useRef(projection);
  projectionRef.current = projection;

  const tryJump = useCallback(() => {
    const pending = pendingJumpRef.current;
    if (pending === null) return;
    const proj = projectionRef.current;
    const turn = proj.turns.find((t) => t.messageIndex === pending.messageIndex);
    const rowId =
      pending.rowId && proj.rows.some((r) => r.id === pending.rowId)
        ? pending.rowId
        : turn
          ? proj.rows[turn.rowStart]?.id
          : undefined;
    if (!rowId) return;
    const target = rowsRef.current.findIndex((r) => r.id === rowId);
    if (target < 0) return;
    pendingJumpRef.current = null;
    // Widen the window first if the target is above it (or open the gap it
    // was swapped into), then anchor once the row exists. Same
    // settle-over-renders shape the timeline uses for jump-to-Checkpoint.
    reveal(target);
    pendingAnchorRef.current = rowId;
    setJumpTick((n) => n + 1);
  }, [reveal]);

  const scrollToMessage = useCallback(
    (messageIndex: number, rowId?: string) => {
      pendingJumpRef.current = { messageIndex, rowId };
      tryJump();
    },
    [tryJump],
  );

  useEffect(() => {
    if (pendingJumpRef.current !== null) tryJump();
  }, [projection, tryJump]);

  // A jump to a row the projection has folded away (a call inside a collapsed
  // run, anything in a settled turn's "Worked" section) opens those folds
  // first, one per projection, and only then scrolls. Landing on the fold's
  // header instead left a comment's thread unopenable: the row's comment
  // button is not mounted while its fold is shut.
  const pendingRevealRef = useRef<{
    index: number;
    target: string;
    workFoldId: string | undefined;
    highlight: string[];
    steps: number;
  } | null>(null);
  const continueReveal = useCallback(() => {
    const pending = pendingRevealRef.current;
    if (!pending) return;
    const step = revealStep(projectionRef.current.rows, pending.target, pending.workFoldId);
    // Two folds at most (the turn, then the run inside it); the bound only
    // guards against a projection that never shows the row.
    if (step.kind === "open" && pending.steps < 3) {
      pending.steps += 1;
      setExpandedTurns((prev) => new Set(prev).add(step.foldId));
      return; // re-projects; the effect below calls back in
    }
    pendingRevealRef.current = null;
    pendingHighlightRef.current = step.kind === "shown" ? [step.rowId] : pending.highlight;
    scrollToMessage(pending.index, step.kind === "shown" ? step.rowId : undefined);
  }, [scrollToMessage]);
  useEffect(() => {
    if (pendingRevealRef.current) continueReveal();
  }, [projection, continueReveal]);

  // A jump that never resolved must not fire into the next session's thread.
  useEffect(() => {
    pendingJumpRef.current = null;
    pendingRevealRef.current = null;
  }, [cacheKey]);

  // ── Turn rail ────────────────────────────────────────────────────────
  // One tick per user turn. Held stable across streaming frames (see
  // `stableTurnRailItems`), so the memo'd rail re-renders only when a prompt
  // is sent or history loads. The preview reads the latest rows on demand,
  // which keeps the reply's text out of the rail's props entirely.
  const turnRailItemsRef = useRef<readonly TurnRailItem[] | null>(null);
  const turnRailItems = useMemo(() => {
    const next = stableTurnRailItems(turnRailItemsRef.current, deriveTurnRailItems(projection));
    turnRailItemsRef.current = next;
    return next;
  }, [projection]);
  const getTurnRailPreview = useCallback(
    (item: TurnRailItem) => turnRailPreviewSource(rowsRef.current, item.id),
    [],
  );
  const selectTurnRailItem = useCallback(
    (item: TurnRailItem) => scrollToMessage(item.messageIndex),
    [scrollToMessage],
  );

  useWindowEvent("atlas:chat-jump", (detail) => {
    // A jump addressed to another chat is not ours (an unaddressed one, from
    // an older sender, still is).
    if (detail?.tabId && detail.tabId !== tabId) return;
    if (typeof detail?.index !== "number") return;
    const ids = detail.highlightRowIds;
    if (ids?.length) {
      // The first id is the row itself; a `wk:` one names its turn's fold.
      pendingRevealRef.current = {
        index: detail.index,
        target: ids[0],
        workFoldId: ids.find((id) => id.startsWith("wk:")),
        highlight: ids,
        steps: 0,
      };
      continueReveal();
      return;
    }
    pendingRevealRef.current = null;
    pendingHighlightRef.current = null;
    scrollToMessage(detail.index);
  });

  return {
    scrollToBottom,
    scrollToMessage,
    turnRailItems,
    getTurnRailPreview,
    selectTurnRailItem,
  };
}
