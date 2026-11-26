import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCanvas, saveCanvas } from "../lib/canvas-api";
import { parseCanvasFile, useCanvasStore } from "./canvas-store";
import { saveProjectDocuments } from "@/features/editor-notion/lib/document-saves";

vi.mock("../lib/canvas-api", () => ({ loadCanvas: vi.fn(), saveCanvas: vi.fn() }));
vi.mock("@/features/log/lib/log", () => ({ logEvent: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const empty = JSON.stringify({
  version: 2,
  nodes: [],
  edges: [],
  viewport: { x: 5, y: 7, zoom: 0.5 },
});
let serial = 0;
let path = "";
const actions = () => useCanvasStore.getState().actions;
beforeEach(() => {
  path = `/canvas-${++serial}`;
  vi.mocked(loadCanvas).mockReset().mockResolvedValue(empty);
  vi.mocked(saveCanvas).mockReset().mockResolvedValue(undefined);
});
afterEach(async () => {
  vi.mocked(saveCanvas).mockResolvedValue(undefined);
  await saveProjectDocuments(null);
});

describe("canvas persistence", () => {
  it.each(["{damaged", "null", '{"version":99,"nodes":[]}', '{"version":4,"pages":[{}]}'])(
    "refuses to edit unreadable canvas %s and supports repair",
    async (raw) => {
      vi.mocked(loadCanvas).mockResolvedValueOnce(raw);
      await actions().loadProject(path);
      expect(useCanvasStore.getState().error).toBeTruthy();
      expect(actions().addNote()).toBe("");
      actions().setViewport({ x: 90, y: 80, zoom: 1 });
      await actions().flush(path);
      expect(saveCanvas).not.toHaveBeenCalled();
      await actions().loadProject(path);
      actions().addNote();
      await actions().flush(path);
      expect(parseCanvasFile(vi.mocked(saveCanvas).mock.lastCall![1]).pages[0].nodes).toHaveLength(
        1,
      );
    },
  );

  it("flushes the originating project before switching within the debounce", async () => {
    await actions().loadProject(path);
    const id = actions().addNote();
    actions().updateNote(id, { title: "Keep alpha" });
    await actions().loadProject(`${path}-b`);
    expect(saveCanvas).toHaveBeenCalledWith(path, expect.stringContaining("Keep alpha"));
    expect(useCanvasStore.getState().nodes).toEqual([]);
  });

  it("retains failed writes and refuses a switch until retry succeeds", async () => {
    await actions().loadProject(path);
    actions().addNote();
    vi.mocked(saveCanvas).mockRejectedValueOnce(new Error("disk full"));
    await expect(actions().loadProject(`${path}-b`)).rejects.toThrow();
    expect(useCanvasStore.getState().projectPath).toBe(path);
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
    await actions().loadProject(`${path}-b`);
    expect(saveCanvas).toHaveBeenCalledTimes(2);
  });

  it("saves a late note-body revision to the originating page", async () => {
    await actions().loadProject(path);
    const page = useCanvasStore.getState().activePageId!;
    const id = actions().addNote();
    const other = actions().createPage();
    await actions().saveNoteBody(path, page, id, "Outgoing body");
    expect(useCanvasStore.getState().activePageId).toBe(other);
    expect(useCanvasStore.getState().nodes).toEqual([]);
    const saved = parseCanvasFile(vi.mocked(saveCanvas).mock.lastCall![1]);
    expect(saved.pages.find((p) => p.id === page)?.nodes[0].body).toBe("Outgoing body");
  });

  it("clears undo when deleting the active page, leaving the surviving page intact", async () => {
    await actions().loadProject(path);
    const keep = actions().addNote();
    const deletedPage = actions().createPage();
    actions().addText();
    actions().deleteTreeEntry(deletedPage);
    actions().undo();
    expect(useCanvasStore.getState().nodes.map((n) => n.id)).toEqual([keep]);
    expect(useCanvasStore.getState().canUndo).toBe(false);
  });

  it("ignores an earlier A load when a later A follows B", async () => {
    let answerFirst!: (raw: string) => void;
    const first = new Promise<string>((resolve) => {
      answerFirst = resolve;
    });
    vi.mocked(loadCanvas).mockReturnValueOnce(first);
    const loading = actions().loadProject(path);
    await vi.waitFor(() => expect(loadCanvas).toHaveBeenCalledTimes(1));
    await actions().loadProject(`${path}-b`);
    await actions().loadProject(path);
    const id = actions().addNote();
    answerFirst(empty);
    await loading;
    expect(useCanvasStore.getState().nodes.map((n) => n.id)).toEqual([id]);
  });
});
