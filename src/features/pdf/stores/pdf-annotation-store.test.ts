import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { usePdfAnnotationStore, pdfDocumentKey } from "./pdf-annotation-store";
import type { PdfAnnotation } from "../lib/pdf-annotations";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const actions = () => usePdfAnnotationStore.getState().actions;
const note = (text: string): PdfAnnotation => ({
  id: "n",
  kind: "note",
  text,
  x: 0,
  y: 0,
  page: 1,
  color: "ink",
  createdAt: "now",
});
beforeEach(() => {
  usePdfAnnotationStore.setState({ byPath: {}, loaded: {}, dirty: {} });
  vi.mocked(invoke).mockReset().mockResolvedValue([]);
});

it("rejects failed saves and retains annotations for an explicit retry", async () => {
  await actions().load("/a.pdf", "/project");
  actions().add("/a.pdf", note("keep this"), "/project");
  vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full"));
  await expect(actions().save("/a.pdf", "/project")).rejects.toThrow("disk full");
  const key = pdfDocumentKey("/project", "/a.pdf");
  expect(usePdfAnnotationStore.getState().dirty[key]).toBe(true);
  await actions().save("/a.pdf", "/project");
  expect(usePdfAnnotationStore.getState().dirty[key]).toBe(false);
});

it("keeps edits made while a save is pending and isolates the same PDF in two projects", async () => {
  await actions().load("/a.pdf", "/one");
  await actions().load("/a.pdf", "/two");
  actions().add("/a.pdf", note("first"), "/one");
  let finish!: () => void;
  vi.mocked(invoke).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = actions().save("/a.pdf", "/one");
  await vi.waitFor(() => expect(finish).toBeDefined());
  actions().updateNoteText("/a.pdf", "n", "later", "/one");
  finish();
  await pending;
  expect(usePdfAnnotationStore.getState().dirty[pdfDocumentKey("/one", "/a.pdf")]).toBe(true);
  expect(usePdfAnnotationStore.getState().byPath[pdfDocumentKey("/two", "/a.pdf")]).toEqual([]);
  await actions().save("/a.pdf", "/one");
  expect(invoke).toHaveBeenLastCalledWith("pdf_annotations_save", {
    projectPath: "/one",
    pdfPath: "/a.pdf",
    annotations: [note("later")],
  });
});

// D10: the debounced save resolved the project when it fired, so a quick
// project switch wrote the annotations into the project being switched to.
it("the debounced save writes to the project the edit was made in", async () => {
  vi.useFakeTimers();
  try {
    await actions().load("/a.pdf", "/one");
    actions().add("/a.pdf", note("mine"), "/one");
    // The switch lands before the 600 ms debounce fires.
    await actions().load("/a.pdf", "/two");
    await vi.advanceTimersByTimeAsync(600);
    expect(invoke).toHaveBeenLastCalledWith("pdf_annotations_save", {
      projectPath: "/one",
      pdfPath: "/a.pdf",
      annotations: [note("mine")],
    });
  } finally {
    vi.useRealTimers();
  }
});

it("a project switch flushes the outgoing project's pending annotations at once", async () => {
  const { flushAll } = await import("@/features/projects/lib/flush-registry");
  await actions().load("/a.pdf", "/one");
  await actions().load("/b.pdf", "/two");
  actions().add("/a.pdf", note("one"), "/one");
  actions().add("/b.pdf", note("two"), "/two");
  vi.mocked(invoke).mockClear();
  await flushAll({ projectId: "one", path: "/one", reason: "switch" });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("pdf_annotations_save", {
    projectPath: "/one",
    pdfPath: "/a.pdf",
    annotations: [note("one")],
  });
  expect(usePdfAnnotationStore.getState().dirty[pdfDocumentKey("/one", "/a.pdf")]).toBe(false);
  expect(usePdfAnnotationStore.getState().dirty[pdfDocumentKey("/two", "/b.pdf")]).toBe(true);
});
