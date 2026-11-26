import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useKnowledgeMetaStore } from "./knowledge-meta-store";
import { saveProjectDocuments } from "@/features/editor-notion/lib/document-saves";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/features/chat/lib/mentions", () => ({ publishKnowledgeToMentionCache: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const actions = () => useKnowledgeMetaStore.getState().actions;
const disk = new Map<string, Record<string, Record<string, unknown>>>();
let fail = false;

beforeEach(() => {
  disk.clear();
  fail = false;
  vi.mocked(invoke)
    .mockReset()
    .mockImplementation(async (command, args) => {
      const { projectPath, entryId, patch } = args as {
        projectPath: string;
        entryId?: string;
        patch?: Record<string, unknown>;
      };
      if (fail) throw new Error("unreadable metadata");
      const pages = disk.get(projectPath) ?? {};
      if (command === "knowledge_meta_load") return { version: 1, pages: structuredClone(pages) };
      if (command === "knowledge_meta_patch" && entryId)
        disk.set(projectPath, { ...pages, [entryId]: { ...pages[entryId], ...patch } });
      if (command === "knowledge_meta_delete" && entryId) delete pages[entryId];
      return undefined;
    });
});
afterEach(async () => {
  fail = false;
  await saveProjectDocuments(null);
  actions().unbind();
});

describe("knowledge metadata persistence", () => {
  it("keeps failed edits and retries after the metadata file is repaired", async () => {
    disk.set("/meta", { first: { title: "First" }, second: { title: "Second" } });
    await actions().bind("/meta");
    fail = true;
    await expect(actions().patch("first", { title: "Pending title" })).rejects.toThrow(
      "unreadable",
    );
    expect(useKnowledgeMetaStore.getState().pages.first.title).toBe("Pending title");
    expect(useKnowledgeMetaStore.getState().error).toContain("unreadable");
    fail = false;
    await actions().retry();
    expect(disk.get("/meta")).toEqual({
      first: { title: "Pending title" },
      second: { title: "Second" },
    });
    expect(useKnowledgeMetaStore.getState().error).toBeNull();
  });

  it("refuses mutation after an unreadable load and enables it after retry", async () => {
    fail = true;
    await actions().bind("/read-only");
    expect(useKnowledgeMetaStore.getState().writable).toBe(false);
    await expect(actions().patch("first", { title: "Never write defaults" })).rejects.toThrow(
      "read-only",
    );
    expect(
      vi.mocked(invoke).mock.calls.every(([command]) => command !== "knowledge_meta_patch"),
    ).toBe(true);
    fail = false;
    disk.set("/read-only", { first: { title: "Repaired" } });
    await actions().retry();
    expect(useKnowledgeMetaStore.getState().pages.first.title).toBe("Repaired");
    expect(useKnowledgeMetaStore.getState().writable).toBe(true);
  });

  it("disposes a listener that completes after binding a different project", async () => {
    let resolve!: (off: () => void) => void;
    const off = vi.fn();
    vi.mocked(listen).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const old = actions().bind("/a");
    disk.set("/b", { same: { title: "Project B" } });
    await actions().bind("/b");
    resolve(off);
    await old;
    expect(off).toHaveBeenCalledTimes(1);
    expect(useKnowledgeMetaStore.getState().projectPath).toBe("/b");
    expect(useKnowledgeMetaStore.getState().pages.same.title).toBe("Project B");
  });
});
