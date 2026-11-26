// Which cells of a rendered document's table keep a readable width: a cell
// holding prose does, a cell holding a value does not.

import type { Element, ElementContent } from "hast";
import { describe, expect, it } from "vitest";
import { READABLE_CELL_CHARS, readableCellClass } from "./markdown-table";

const text = (value: string): ElementContent => ({ type: "text", value });
const el = (tagName: string, children: ElementContent[]): Element => ({
  type: "element",
  tagName,
  properties: {},
  children,
});

describe("readableCellClass", () => {
  it("gives a cell longer than the measure the floor, in the same number of ch", () => {
    const cell = el("td", [text("x".repeat(READABLE_CELL_CHARS + 1))]);
    expect(readableCellClass(cell)).toBe(`min-w-[${READABLE_CELL_CHARS}ch]`);
  });

  it("leaves a value, and text that fits the measure, at its own width", () => {
    expect(readableCellClass(el("td", [text("#")]))).toBeUndefined();
    expect(readableCellClass(el("th", [text("x".repeat(READABLE_CELL_CHARS))]))).toBeUndefined();
    expect(readableCellClass(el("td", []))).toBeUndefined();
    expect(readableCellClass(undefined)).toBeUndefined();
  });

  it("counts the text inside inline elements, as it reads", () => {
    const cell = el("td", [
      text("Run "),
      el("code", [text("bun run dev")]),
      text(" and open "),
      el("a", [text("the app")]),
    ]);
    expect(readableCellClass(cell)).toBe("min-w-[24ch]");
  });

  it("collapses whitespace before counting", () => {
    const padded = `  ${"a ".repeat(6)}\n\n${"  ".repeat(20)}`;
    expect(readableCellClass(el("td", [text(padded)]))).toBeUndefined();
  });
});
