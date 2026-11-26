// D5: a note whose save failed was still marked saved, and create/delete
// failures went unseen. The store's actions now reject on a failed write and
// leave the notes as they were, so the editor keeps the draft dirty and the
// caller can say so.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/features/log/lib/log", () => ({ logEvent: vi.fn() }));
vi.mock("@/features/chat/lib/mentions", () => ({ publishKnowledgeToMentionCache: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { useKnowledgeStore, type KnowledgeEntry } from "./knowledge-store";

const entry: KnowledgeEntry = {
  id: "n1",
  title: "Old",
  content: "# Old\n",
  source: "note",
  file_path: "/p/.atlas/knowledge/n1.md",
  updated_at: "then",
};
const actions = () => useKnowledgeStore.getState().actions;
const failWrites = () =>
  vi.mocked(invoke).mockImplementation(async (cmd: string) => {
    if (cmd === "list_knowledge") return [entry];
    throw new Error("disk full");
  });

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  useKnowledgeStore.setState({
    projectPath: "/p",
    entries: [entry],
    activeEntryId: "n1",
    editContent: entry.content,
    loading: false,
    error: null,
    pendingOpenId: null,
  });
});

describe("knowledge writes that fail", () => {
  it("a failed save rejects and leaves the note as last saved", async () => {
    failWrites();
    await expect(actions().saveEntry("/p", "n1", "# New\n")).rejects.toThrow("disk full");
    expect(useKnowledgeStore.getState().entries[0]).toEqual(entry);
    expect(useKnowledgeStore.getState().editContent).toBe(entry.content);
  });

  it("a failed create or delete rejects and changes nothing", async () => {
    failWrites();
    await expect(actions().createEntry("/p")).rejects.toThrow("disk full");
    await expect(actions().deleteEntry("/p", "n1")).rejects.toThrow("disk full");
    expect(useKnowledgeStore.getState().entries).toEqual([entry]);
    expect(useKnowledgeStore.getState().activeEntryId).toBe("n1");
  });

  it("a save that lands updates the note", async () => {
    vi.mocked(invoke).mockResolvedValue(undefined);
    await actions().saveEntry("/p", "n1", "# New\n");
    expect(useKnowledgeStore.getState().entries[0]).toMatchObject({
      content: "# New\n",
      title: "New",
    });
  });
});
