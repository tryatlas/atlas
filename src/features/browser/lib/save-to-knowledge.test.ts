// D5: "Save to knowledge" in the browser's reader swallowed every failure, so
// a page that never reached disk looked saved.

import { beforeEach, describe, expect, it, vi } from "vitest";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { error: toastError } }));
const save = vi.hoisted(() => vi.fn());
vi.mock("./browser-api", () => ({ saveKnowledgeNote: save }));
const loadEntries = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/features/knowledge/stores/knowledge-store", () => ({
  useKnowledgeStore: { getState: () => ({ actions: { loadEntries } }) },
}));

import { savePageToKnowledge } from "./save-to-knowledge";

const page = { title: "Docs", url: "https://example.com" };

beforeEach(() => vi.clearAllMocks());

describe("savePageToKnowledge", () => {
  it("says so when the note could not be written", async () => {
    save.mockRejectedValueOnce(new Error("disk full"));
    await expect(savePageToKnowledge("/p", page, "body")).resolves.toBe(false);
    expect(toastError).toHaveBeenCalledWith(expect.stringContaining("disk full"));
    expect(loadEntries).not.toHaveBeenCalled();
  });

  it("writes the page and refreshes the notes list", async () => {
    save.mockResolvedValueOnce(undefined);
    await expect(savePageToKnowledge("/p", page, "body")).resolves.toBe(true);
    expect(save).toHaveBeenCalledWith(
      "/p",
      expect.stringMatching(/^web-/),
      "# Docs\n\nSource: https://example.com\n\nbody",
    );
    expect(loadEntries).toHaveBeenCalledWith("/p");
    expect(toastError).not.toHaveBeenCalled();
  });
});
