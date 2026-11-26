import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { invoke } from "@tauri-apps/api/core";
import { registerFlush } from "@/features/projects/lib/flush-registry";
import { toast } from "sonner";
import { PDF_COLORS, type PdfAnnotation, type PdfTool } from "../lib/pdf-annotations";

interface PdfAnnotationState {
  tool: PdfTool;
  color: string;
  /** Editable annotations per PDF absolute path. Mirrored to disk
   *  (`.atlas/pdf-annotations.json`) so they persist AND stay erasable. */
  byPath: Record<string, PdfAnnotation[]>;
  /** Per-path unsaved-changes flag (drives the dirty dot). Cleared once the
   *  debounced/explicit save lands. */
  dirty: Record<string, boolean>;
  /** Currently-selected annotation id (for the note editor), or null. */
  selectedId: string | null;
  loaded: Record<string, boolean>;
  actions: {
    setTool: (tool: PdfTool) => void;
    setColor: (color: string) => void;
    select: (id: string | null) => void;
    add: (pdfPath: string, ann: PdfAnnotation, projectPath: string) => void;
    updateNoteText: (pdfPath: string, id: string, text: string, projectPath: string) => void;
    remove: (pdfPath: string, id: string, projectPath: string) => void;
    /** Load persisted annotations for a PDF into the store. */
    load: (pdfPath: string, projectPath: string) => Promise<void>;
    /** Persist a PDF's annotations now (also called debounced after edits).
     *  Resolves once written so Cmd+S can await + toast. */
    save: (pdfPath: string, projectPath: string) => Promise<void>;
  };
}

// Debounced per-path autosave so edits aren't lost on tab close / crash.
const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {};
export const pdfDocumentKey = (projectPath: string, pdfPath: string) =>
  JSON.stringify([projectPath, pdfPath]);
const writes = new Map<string, Promise<void>>();

function scheduleSave(pdfPath: string, projectPath: string): void {
  const key = pdfDocumentKey(projectPath, pdfPath);
  if (saveTimers[key]) clearTimeout(saveTimers[key]);
  saveTimers[key] = setTimeout(() => {
    delete saveTimers[key];
    void usePdfAnnotationStore
      .getState()
      .actions.save(pdfPath, projectPath)
      .catch((error) => toast.error(`Annotations could not be saved: ${String(error)}`));
  }, 600);
}

export const usePdfAnnotationStore = create<PdfAnnotationState>()(
  immer((set, get) => ({
    tool: "none",
    color: PDF_COLORS[0],
    byPath: {},
    dirty: {},
    selectedId: null,
    loaded: {},
    actions: {
      setTool: (tool) =>
        set((s) => {
          s.tool = tool;
          if (tool !== "none") s.selectedId = null;
        }),
      setColor: (color) =>
        set((s) => {
          s.color = color;
        }),
      select: (id) =>
        set((s) => {
          s.selectedId = id;
        }),
      add: (pdfPath, ann, projectPath) => {
        const key = pdfDocumentKey(projectPath, pdfPath);
        if (!get().loaded[key]) return;
        set((s) => {
          const list = s.byPath[key] ?? [];
          list.push(ann);
          s.byPath[key] = list;
          s.dirty[key] = true;
          if (ann.kind === "note") s.selectedId = ann.id;
        });
        scheduleSave(pdfPath, projectPath);
      },
      updateNoteText: (pdfPath, id, text, projectPath) => {
        const key = pdfDocumentKey(projectPath, pdfPath);
        if (!get().loaded[key]) return;
        set((s) => {
          const ann = s.byPath[key]?.find((a) => a.id === id);
          if (ann && ann.kind === "note") {
            ann.text = text;
            s.dirty[key] = true;
          }
        });
        scheduleSave(pdfPath, projectPath);
      },
      remove: (pdfPath, id, projectPath) => {
        const key = pdfDocumentKey(projectPath, pdfPath);
        if (!get().loaded[key]) return;
        set((s) => {
          s.byPath[key] = (s.byPath[key] ?? []).filter((a) => a.id !== id);
          s.dirty[key] = true;
          if (s.selectedId === id) s.selectedId = null;
        });
        scheduleSave(pdfPath, projectPath);
      },
      load: async (pdfPath, projectPath) => {
        if (!projectPath) throw new Error("No project owns these annotations.");
        const key = pdfDocumentKey(projectPath, pdfPath);
        if (get().loaded[key]) return;
        const annotations = await invoke<PdfAnnotation[]>("pdf_annotations_load", {
          projectPath,
          pdfPath,
        });
        set((state) => {
          if (state.dirty[key]) return;
          state.byPath[key] = annotations ?? [];
          state.loaded[key] = true;
          state.dirty[key] = false;
        });
      },
      save: async (pdfPath, projectPath) => {
        const key = pdfDocumentKey(projectPath, pdfPath);
        if (!get().loaded[key]) throw new Error("Annotations have not loaded successfully.");
        if (saveTimers[key]) {
          clearTimeout(saveTimers[key]);
          delete saveTimers[key];
        }
        const annotations = get().byPath[key] ?? [];
        const write = (writes.get(projectPath) ?? Promise.resolve())
          .catch(() => {})
          .then(async () => {
            await invoke("pdf_annotations_save", { projectPath, pdfPath, annotations });
            if (get().byPath[key] === annotations)
              set((state) => {
                state.dirty[key] = false;
              });
          });
        writes.set(projectPath, write);
        try {
          await write;
        } finally {
          if (writes.get(projectPath) === write) writes.delete(projectPath);
        }
      },
    },
  })),
);

registerFlush(
  "pdf-annotations",
  async ({ path }) => {
    const state = usePdfAnnotationStore.getState();
    const pending = Object.keys(state.dirty)
      .filter((key) => state.dirty[key])
      .map((key) => {
        const [projectPath, pdfPath] = JSON.parse(key) as [string, string];
        return !path || path === projectPath
          ? state.actions.save(pdfPath, projectPath)
          : Promise.resolve();
      });
    const results = await Promise.allSettled(pending);
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, "Annotations could not be saved.");
  },
  { required: true },
);
