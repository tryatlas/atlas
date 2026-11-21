// How a table in a rendered document sizes its columns: the markdown file
// preview (`markdown-fileviewer.tsx`) and the README view (`readme-view.tsx`).
//
// Auto table layout fits a table to its box by squeezing every column toward
// its longest word, so a table with a few prose columns turns into a tall
// strip of one word per line. Holding every cell to its max-content width
// instead (`white-space: nowrap`, `min-w-max`) turns a sentence into one very
// long line. The rule here sits between the two: a cell that holds prose has a
// floor of a readable measure, and wraps above it. A column never goes below
// the floor of any of its cells, and a column with none (`#`, `Yes`, a
// version) stays as narrow as its text. A table whose floors add up to more
// than its box scrolls sideways inside it rather than collapsing. Cells wrap
// at word boundaries (`overflow-wrap: break-word`, which leaves the
// min-content width alone), so a long unbroken token widens its column
// instead of splitting.

import type { Element, ElementContent } from "hast";

/**
 * Characters past which a cell reads as prose rather than a value, and the
 * measure, in `ch`, such a cell keeps. One number for both, so a cell that
 * gets the floor always had more text than the floor holds on one line.
 */
export const READABLE_CELL_CHARS = 24;

/** The floor a prose cell gets: `READABLE_CELL_CHARS` in `ch`. A literal, so
 *  Tailwind generates it. */
const READABLE_CELL_CLASS = "min-w-[24ch]";

/** The length of a cell's text with its whitespace collapsed, as it reads. */
function textLength(nodes: readonly ElementContent[]): number {
  let text = "";
  const walk = (list: readonly ElementContent[]) => {
    for (const node of list) {
      if (node.type === "text") text += node.value;
      else if (node.type === "element") walk(node.children);
    }
  };
  walk(nodes);
  return text.replace(/\s+/g, " ").trim().length;
}

/**
 * The class a `<th>`/`<td>` takes so its column keeps a readable width: the
 * floor when the cell holds prose, nothing when it holds a value. `cell` is
 * the hast element react-markdown hands a component as `node`.
 */
export function readableCellClass(cell: Element | undefined): string | undefined {
  if (!cell) return undefined;
  return textLength(cell.children) > READABLE_CELL_CHARS ? READABLE_CELL_CLASS : undefined;
}
