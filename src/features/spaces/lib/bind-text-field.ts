import * as Y from "yjs";
import { LOCAL, splice } from "./space-doc";

type Field = HTMLInputElement | HTMLTextAreaElement;
type Delta = Array<{ retain?: number; delete?: number; insert?: unknown }>;

/** Map a DOM offset through a Y.Text transaction; insertion affinity is right. */
function mapOffset(offset: number, delta: Delta, character = false): number | null {
  let before = 0;
  let after = 0;
  for (const part of delta) {
    if (part.insert !== undefined) {
      after += typeof part.insert === "string" ? part.insert.length : 1;
    } else if (part.delete !== undefined) {
      if (offset < before + part.delete) return character ? null : after;
      before += part.delete;
    } else if (part.retain !== undefined) {
      if (offset < before + part.retain) return after + offset - before;
      before += part.retain;
      after += part.retain;
    }
  }
  return after + offset - before;
}

function difference(before: string, after: string): Delta {
  const change = splice(before, after);
  return change
    ? [{ retain: change.index }, { delete: change.remove }, { insert: change.insert }]
    : [];
}

/**
 * Bind a native field directly to Y.Text. Peer transactions update the focused
 * DOM and map its selection before the next local input. During native IME
 * composition we leave the candidate alone, track each original character's
 * position through peer deltas, then replace only those original characters.
 * Peer inserts made inside a composition's replacement range survive it.
 */
export function bindTextField(
  element: Field,
  doc: Y.Doc,
  node: Y.Map<unknown>,
  key: string,
  readOnly: boolean,
): () => void {
  const read = () => {
    const value = node.get(key);
    return value instanceof Y.Text ? value.toString() : typeof value === "string" ? value : "";
  };
  let model = read();
  element.value = model;
  let local = false;
  let composition: { base: string; characters: Array<number | null>; boundaries: number[] } | null =
    null;

  const render = (delta: Delta = []) => {
    const start = mapOffset(element.selectionStart ?? 0, delta) ?? 0;
    const end = mapOffset(element.selectionEnd ?? 0, delta) ?? 0;
    const direction = element.selectionDirection;
    element.value = model;
    if (document.activeElement === element)
      element.setSelectionRange(start, end, direction ?? undefined);
  };
  const observe = (events: Y.YEvent<Y.AbstractType<unknown>>[]) => {
    const next = read();
    const text = node.get(key);
    const event = events.find((event) => event.target === text && event instanceof Y.YTextEvent);
    const delta = event instanceof Y.YTextEvent ? event.delta : difference(model, next);
    model = next;
    if (local) return;
    if (composition) {
      composition.characters = composition.characters.map((position) =>
        position === null ? null : mapOffset(position, delta, true),
      );
      composition.boundaries = composition.boundaries.map(
        (position) => mapOffset(position, delta) ?? 0,
      );
    } else render(delta);
  };
  node.observeDeep(observe);

  const mutate = (change: (text: Y.Text) => void) => {
    local = true;
    try {
      doc.transact(() => {
        let text = node.get(key);
        if (!(text instanceof Y.Text)) {
          text = new Y.Text(model);
          node.set(key, text);
        }
        change(text as Y.Text);
      }, LOCAL);
      model = read();
    } finally {
      local = false;
    }
  };

  const input = () => {
    if (composition) return;
    if (readOnly) {
      render();
      return;
    }
    const change = splice(model, element.value);
    if (!change) return;
    mutate((text) => {
      if (change.remove) text.delete(change.index, change.remove);
      if (change.insert) text.insert(change.index, change.insert);
    });
  };
  const startComposition = () => {
    if (readOnly) return;
    composition = {
      base: model,
      characters: Array.from({ length: model.length }, (_, index) => index),
      boundaries: Array.from({ length: model.length + 1 }, (_, index) => index),
    };
  };
  const endComposition = () => {
    const composed = composition;
    if (!composed) return;
    composition = null;
    const change = splice(composed.base, element.value);
    if (!change || readOnly) {
      render();
      return;
    }
    const insertion = composed.boundaries[change.index];
    const removed = composed.characters
      .slice(change.index, change.index + change.remove)
      .filter((position): position is number => position !== null);
    const ranges: Array<{ index: number; length: number }> = [];
    for (const position of removed) {
      const previous = ranges[ranges.length - 1];
      if (previous && previous.index + previous.length === position) previous.length += 1;
      else ranges.push({ index: position, length: 1 });
    }
    mutate((text) => {
      for (const range of ranges.reverse()) text.delete(range.index, range.length);
      if (change.insert) text.insert(Math.min(insertion, text.length), change.insert);
    });
    render();
    element.setSelectionRange(insertion + change.insert.length, insertion + change.insert.length);
  };

  element.addEventListener("input", input);
  element.addEventListener("compositionstart", startComposition);
  element.addEventListener("compositionend", endComposition);
  return () => {
    // Teardown can interrupt an IME session; capture its visible local edit.
    endComposition();
    node.unobserveDeep(observe);
    element.removeEventListener("input", input);
    element.removeEventListener("compositionstart", startComposition);
    element.removeEventListener("compositionend", endComposition);
  };
}
