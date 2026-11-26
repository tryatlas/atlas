// A markdown document rendered in its file tab: a table's prose columns keep
// a readable width and wrap above it, its value columns stay as narrow as
// their text, and a table wider than the document scrolls in its own box.
// Measured in the engine: what auto table layout does with a cell's floor is
// layout that happy-dom never computes.

import type { Locator, Page } from "@playwright/test";
import { expect, openScenario, test } from "./fixtures";

/** The rendered document: the parent of its first heading. */
function documentRoot(page: Page): Locator {
  return page.getByRole("heading", { name: "Settings reference" }).locator("..");
}

/** The rendered table right after the heading `name`. */
function tableAfter(page: Page, name: string): Locator {
  return documentRoot(page)
    .getByRole("heading", { name, exact: true })
    .locator("xpath=following-sibling::*[1]")
    .getByRole("table");
}

/** The width of each of a table's columns, in CSS pixels. */
const columnWidths = (table: Locator) =>
  table.evaluate((t: HTMLTableElement) =>
    [...t.rows[0].cells].map((c) => c.getBoundingClientRect().width),
  );

/** How many lines the text of the cell at (`row`, `col`) runs to: its line
 *  boxes' bottoms, with inline code's padding inside one line's tolerance. */
const linesIn = (table: Locator, row: number, col: number) =>
  table.evaluate(
    (t: HTMLTableElement, [row, col]) => {
      const range = document.createRange();
      range.selectNodeContents(t.rows[row].cells[col]);
      const bottoms = [...range.getClientRects()].map((r) => r.bottom).sort((a, b) => a - b);
      return bottoms.filter((b, i) => i === 0 || b - bottoms[i - 1] > 8).length;
    },
    [row, col] as const,
  );

/** The width of 24ch in a body cell of `table`: the floor a prose cell keeps. */
const floorOf = (table: Locator) =>
  table.evaluate((t: HTMLTableElement) => {
    const probe = document.createElement("span");
    probe.style.cssText = "display:inline-block;width:24ch";
    t.rows[1].cells[0].append(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    return width;
  });

/** How far a table's scroll box, and the document around it, run past their width. */
const overflow = (table: Locator) =>
  table.evaluate((t: HTMLTableElement) => {
    const box = t.parentElement!;
    const doc = box.parentElement!;
    return {
      box: box.scrollWidth - box.clientWidth,
      scrolls: getComputedStyle(box).overflowX,
      doc: doc.scrollWidth - doc.clientWidth,
    };
  });

test.describe("markdown preview tables", () => {
  test.beforeEach(async ({ page }) => {
    await openScenario(page, "files-markdown");
    await expect(documentRoot(page)).toBeVisible();
  });

  test("in a narrow panel, a prose column keeps its width and the table scrolls", async ({
    page,
  }) => {
    const table = tableAfter(page, "Editor");

    // Not squeezed toward its longest word to fit the panel.
    const [, , prose] = await columnWidths(table);
    expect(prose).toBeGreaterThanOrEqual(await floorOf(table));
    // The table scrolls in its own box; the document does not.
    const { box, scrolls, doc } = await overflow(table);
    expect(box).toBeGreaterThan(0);
    expect(scrolls).toBe("auto");
    expect(doc).toBe(0);
  });

  test.describe("in a wide panel", () => {
    test.beforeEach(async ({ page }) => {
      await page.getByRole("button", { name: "Maximize panel" }).click();
      await expect(page.getByRole("button", { name: "Restore panel size" })).toBeVisible();
    });

    test("a table of values stays as narrow as its text", async ({ page }) => {
      const table = tableAfter(page, "Defaults");

      const [doc, own] = await Promise.all([
        documentRoot(page).evaluate((d) => d.getBoundingClientRect().width),
        table.evaluate((t) => t.getBoundingClientRect().width),
      ]);
      expect(own).toBeLessThan(doc / 2);
      for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 3; col++) expect(await linesIn(table, row, col)).toBe(1);
      }
    });

    test("a prose column wraps within the document; value columns stay narrow", async ({
      page,
    }) => {
      const table = tableAfter(page, "Editor");

      const [number, setting, prose] = await columnWidths(table);
      expect(prose).toBeGreaterThanOrEqual(await floorOf(table));
      expect(number).toBeLessThan(prose / 4);
      expect(setting).toBeLessThan(prose / 2);
      // Wrapped, not run on as one line past the document.
      expect(await linesIn(table, 1, 2)).toBeGreaterThan(1);
      expect((await overflow(table)).box).toBe(0);
    });

    test("a table wider than the document scrolls in its own box", async ({ page }) => {
      const table = tableAfter(page, "Agents");

      const floor = await floorOf(table);
      for (const width of (await columnWidths(table)).slice(1)) {
        expect(width).toBeGreaterThanOrEqual(floor);
      }
      const { box, doc } = await overflow(table);
      expect(box).toBeGreaterThan(0);
      expect(doc).toBe(0);
    });
  });
});
