import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { logEvent } from "@/features/log/lib/log";
import { loadCanvas, saveCanvas } from "../lib/canvas-api";
import {
  captureDocumentEdit,
  documentKey,
  isDocumentDirty,
  saveDocument,
  saveProjectDocuments,
} from "@/features/editor-notion/lib/document-saves";
import { toast } from "sonner";

/** What a canvas node is. `note` = rich card (title/body/icon), `text` = chrome-
 *  less free text, `media` = image, `shape` = geometric flowchart shape with a
 *  centered text label. Defaults to `note` for legacy files. */
export type CanvasNodeKind = "note" | "text" | "media" | "shape";
export type MediaKind = "image" | "video";

/** Flowchart shape geometries. */
export type ShapeType = "rectangle" | "rounded" | "ellipse" | "diamond";

/** Active canvas tool. Create-tools drop a node on the next pane click, then
 *  revert to `select`. `connector` is a hint; connections are made by dragging
 *  between node handles (Loose mode). `shape:*` drops that geometry. */
export type CanvasTool = "select" | "note" | "text" | "media" | "connector" | `shape:${ShapeType}`;

export interface CanvasNode {
  id: string;
  kind: CanvasNodeKind;
  x: number;
  y: number;
  width?: number;
  height?: number;
  // note fields
  title: string;
  body: string;
  /** Emoji shown on the note card (falls back to the sticky-note glyph). */
  icon?: string;
  // text field (also the centered label for `shape` nodes)
  text?: string;
  // shape field
  shapeType?: ShapeType;
  // media fields
  /** Relative path under `.atlas/canvas-media/` (served via canvas_media_data_url). */
  src?: string;
  mediaKind?: MediaKind;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  /** Which side of each node the connector attaches to (t/r/b/l). */
  sourceHandle?: string | null;
  targetHandle?: string | null;
}

export interface CanvasViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface CanvasPage {
  id: string;
  viewport: CanvasViewport;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

/** An entry in the pages file tree — a page (has canvas data) or an organizing
 *  folder. `id` of a page entry matches its `CanvasPage.id`. */
export interface PageTreeEntry {
  id: string;
  kind: "page" | "folder";
  parentId: string | null;
  name: string;
  icon?: string;
  order: number;
}

/** Persisted file schema. v4 = multiple pages + a folder tree (Figma-style). */
export interface CanvasFile {
  version: 4;
  pages: CanvasPage[];
  tree: PageTreeEntry[];
  activePageId: string;
}

interface CanvasState {
  projectPath: string | null;
  loaded: boolean;
  error: string | null;
  saveError: string | null;
  // The top-level nodes/edges/viewport are the ACTIVE page's live working
  // copy — every action + selector reads/writes these. Inactive pages live in
  // `pages`; `syncActiveIntoPages` folds the working copy back before save/switch.
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  viewport: CanvasViewport;
  /** All pages' persisted data, keyed by id (active page is also mirrored above). */
  pages: Record<string, CanvasPage>;
  /** The pages/folders tree (names, emojis, order, nesting). */
  tree: PageTreeEntry[];
  activePageId: string | null;
  /** Ids of currently-selected nodes (multi-select via marquee / shift-click). */
  selectedIds: string[];
  fullscreen: boolean;
  activeTool: CanvasTool;
  /** Mirrors the module-level undo/redo stacks for toolbar button state. */
  canUndo: boolean;
  canRedo: boolean;
}

type NodePatch = Partial<
  Pick<
    CanvasNode,
    "title" | "body" | "width" | "height" | "icon" | "text" | "src" | "mediaKind" | "shapeType"
  >
>;

interface CanvasActions {
  actions: {
    loadProject: (path: string) => Promise<void>;
    flush: (path?: string) => Promise<void>;
    saveNoteBody: (
      projectPath: string,
      pageId: string,
      noteId: string,
      body: string,
    ) => Promise<void>;
    addNote: (at?: { x: number; y: number }) => string;
    addText: (at?: { x: number; y: number }) => string;
    addMedia: (
      opts: { src: string; mediaKind: MediaKind; width?: number; height?: number },
      at?: { x: number; y: number },
    ) => string;
    addShape: (
      shapeType: ShapeType,
      at?: { x: number; y: number },
      size?: { width: number; height: number },
    ) => string;
    updateNote: (id: string, patch: NodePatch) => void;
    deleteNote: (id: string) => void;
    moveNote: (id: string, x: number, y: number) => void;
    addEdge: (
      source: string,
      target: string,
      sourceHandle?: string | null,
      targetHandle?: string | null,
    ) => void;
    deleteEdge: (id: string) => void;
    /** Replace the selection with a single id (or clear when null). */
    setSelected: (id: string | null) => void;
    /** Replace the whole selection set (marquee / multi-select). */
    setSelectedIds: (ids: string[]) => void;
    setViewport: (vp: CanvasViewport) => void;
    setFullscreen: (open: boolean) => void;
    toggleFullscreen: () => void;
    setTool: (tool: CanvasTool) => void;
    /** Snapshot the current nodes/edges so the next mutation is one undo step.
     *  Call at the START of a continuous interaction (node drag / resize). */
    beginInteraction: () => void;
    undo: () => void;
    redo: () => void;
    // ── Pages ──
    /** Create a new empty page (optionally inside a folder); makes it active. */
    createPage: (parentId?: string | null) => string;
    /** Create a new folder (optionally nested). */
    createPageFolder: (parentId?: string | null) => string;
    /** Switch the active page: fold the current working copy back into `pages`,
     *  then load the target page's data into the working fields. */
    setActivePage: (id: string) => void;
    renameTreeEntry: (id: string, name: string) => void;
    setTreeEntryIcon: (id: string, icon: string | null) => void;
    /** Delete a page or folder (folders cascade to descendant pages). Never
     *  removes the last remaining page. */
    deleteTreeEntry: (id: string) => void;
  };
}

function genId(prefix: "n" | "e" | "g" | "p" | "f"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

const emptyViewport: CanvasViewport = { x: 0, y: 0, zoom: 1 };

function emptyPage(id: string): CanvasPage {
  return { id, viewport: { ...emptyViewport }, nodes: [], edges: [] };
}

/** Fold the active page's live working copy (top-level fields) back into `pages`
 *  so the persisted map + a page switch never lose the current edits. */
function activePageSnapshot(s: CanvasState): CanvasPage | null {
  if (!s.activePageId) return null;
  return {
    id: s.activePageId,
    viewport: s.viewport,
    nodes: s.nodes,
    edges: s.edges,
  };
}

// The immutable snapshot and its writer stay bound to their project, even
// after React tears down the board or starts loading another project.
const snapshots = new Map<string, CanvasFile>();
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
let loadGeneration = 0;

function canvasKey(path: string): string {
  return documentKey(path, "canvas");
}

function snapshot(s: CanvasState): CanvasFile {
  const active = activePageSnapshot(s);
  if (!active) throw new Error("No canvas page is loaded.");
  return {
    version: 4,
    pages: Object.values({ ...s.pages, [active.id]: active }),
    tree: s.tree,
    activePageId: active.id,
  };
}

function retainSnapshot(path: string, file: CanvasFile): void {
  snapshots.set(path, file);
  captureDocumentEdit(canvasKey(path), {
    projectPath: path,
    serialize: () => JSON.stringify(file),
    persist: async (payload) => {
      try {
        await saveCanvas(path, payload);
        if (useCanvasStore.getState().projectPath === path)
          useCanvasStore.setState({ saveError: null });
      } catch (error) {
        if (useCanvasStore.getState().projectPath === path)
          useCanvasStore.setState({ saveError: String(error) });
        throw error;
      }
    },
  });
  const timer = saveTimers.get(path);
  if (timer) clearTimeout(timer);
  saveTimers.set(
    path,
    setTimeout(() => {
      saveTimers.delete(path);
      void saveDocument(canvasKey(path)).catch((error) =>
        toast.error(`Board could not be saved: ${String(error)}`),
      );
    }, 400),
  );
}

// ── Undo/redo snapshot stacks ────────────────────────────────────────────────
// Module-level (not reactive). The store mirrors `canUndo`/`canRedo` for the
// toolbar. A continuous drag/resize captures ONE snapshot at its start
// (`beginInteraction`), so it collapses into a single undo step — matching how
// Excalidraw batches a drag into one history entry.
interface HistorySnap {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}
let past: HistorySnap[] = [];
let future: HistorySnap[] = [];
const HISTORY_CAP = 50;

function resetHistory() {
  past = [];
  future = [];
}

/** Normalize a raw nodes array (v1→v2 shape fixups). */
function normalizeNodes(raw: unknown): CanvasNode[] {
  return (Array.isArray(raw) ? raw : []).map((n) => ({
    ...(n as CanvasNode),
    kind: (n as CanvasNode).kind ?? "note",
    title: (n as CanvasNode).title ?? "",
    body: (n as CanvasNode).body ?? "",
  }));
}

/** A brand-new file with a single empty "Page 1". */
function freshFile(): CanvasFile {
  const id = genId("p");
  return {
    version: 4,
    pages: [emptyPage(id)],
    tree: [{ id, kind: "page", parentId: null, name: "Page 1", order: 0 }],
    activePageId: id,
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validViewport(value: unknown): boolean {
  return (
    value === undefined ||
    (record(value) &&
      [value.x, value.y, value.zoom].every((n) => typeof n === "number" && Number.isFinite(n)) &&
      Number(value.zoom) > 0)
  );
}

function validBoard(value: unknown): value is Record<string, unknown> {
  return (
    record(value) &&
    Array.isArray(value.nodes) &&
    value.nodes.every((node) => record(node) && typeof node.id === "string") &&
    (value.edges === undefined ||
      (Array.isArray(value.edges) &&
        value.edges.every(
          (edge) =>
            record(edge) &&
            typeof edge.id === "string" &&
            typeof edge.source === "string" &&
            typeof edge.target === "string",
        ))) &&
    validViewport(value.viewport)
  );
}

export function parseCanvasFile(raw: string): CanvasFile {
  const parsed: unknown = JSON.parse(raw);
  const invalid = () =>
    new Error("canvas.json has an invalid or unsupported format. Repair the file, then Retry.");
  if (!record(parsed)) throw invalid();
  if (parsed.version === 4) {
    if (
      !Array.isArray(parsed.pages) ||
      !parsed.pages.every(
        (page) => validBoard(page) && typeof page.id === "string" && page.id.length > 0,
      ) ||
      !Array.isArray(parsed.tree) ||
      !parsed.tree.every(
        (entry) =>
          record(entry) &&
          typeof entry.id === "string" &&
          (entry.kind === "page" || entry.kind === "folder") &&
          typeof entry.name === "string" &&
          (entry.parentId === null || typeof entry.parentId === "string") &&
          typeof entry.order === "number",
      )
    )
      throw invalid();
    const pages = parsed.pages as unknown as CanvasPage[];
    const tree = parsed.tree as PageTreeEntry[];
    if (
      !pages.length ||
      new Set(pages.map((page) => page.id)).size !== pages.length ||
      new Set(tree.map((entry) => entry.id)).size !== tree.length ||
      typeof parsed.activePageId !== "string" ||
      !pages.some((page) => page.id === parsed.activePageId) ||
      pages.some((page) => !tree.some((entry) => entry.id === page.id && entry.kind === "page")) ||
      tree.some((entry) => entry.kind === "page" && !pages.some((page) => page.id === entry.id))
    )
      throw invalid();
    return {
      version: 4,
      pages: pages.map((page) => ({
        ...page,
        nodes: normalizeNodes(page.nodes),
        edges: page.edges ?? [],
        viewport: page.viewport ?? { ...emptyViewport },
      })),
      tree,
      activePageId: parsed.activePageId,
    };
  }
  if (![undefined, 1, 2, 3].includes(parsed.version as number | undefined) || !validBoard(parsed))
    throw invalid();
  const file = freshFile();
  file.pages[0] = {
    ...file.pages[0],
    viewport: (parsed.viewport as CanvasViewport | undefined) ?? { ...emptyViewport },
    nodes: normalizeNodes(parsed.nodes),
    edges: (parsed.edges as CanvasEdge[] | undefined) ?? [],
  };
  return file;
}

export const useCanvasStore = create<CanvasState & CanvasActions>()(
  immer((set, get) => {
    // Capture the pre-mutation nodes/edges as one undo step. `get()` inside a
    // producer returns committed (pre-`set`) state, and immer never mutates a
    // previously-produced object, so storing the references is a safe snapshot.
    const writable = () => get().loaded && !get().error && !!get().activePageId;
    const takeSnapshot = () => {
      if (!writable()) return;
      past.push({ nodes: get().nodes, edges: get().edges });
      if (past.length > HISTORY_CAP) past.shift();
      future = [];
      set((s) => {
        s.canUndo = true;
        s.canRedo = false;
      });
    };
    return {
      projectPath: null,
      loaded: false,
      error: null,
      saveError: null,
      nodes: [],
      edges: [],
      viewport: emptyViewport,
      pages: {},
      tree: [],
      activePageId: null,
      selectedIds: [],
      fullscreen: false,
      activeTool: "select",
      canUndo: false,
      canRedo: false,
      actions: {
        loadProject: async (path) => {
          const generation = ++loadGeneration;
          const previous = get().projectPath;
          if (previous && previous !== path) await saveProjectDocuments(previous);
          if (generation !== loadGeneration) return;
          set((s) => {
            s.projectPath = path;
            s.loaded = false;
            s.error = null;
            s.saveError = null;
            s.nodes = [];
            s.edges = [];
            s.pages = {};
            s.tree = [];
            s.activePageId = null;
            s.selectedIds = [];
            s.viewport = emptyViewport;
          });
          try {
            const retained = isDocumentDirty(canvasKey(path)) ? snapshots.get(path) : undefined;
            const parsed = retained ?? parseCanvasFile(await loadCanvas(path));
            if (generation !== loadGeneration || get().projectPath !== path) return;
            snapshots.set(path, parsed);
            resetHistory();
            set((s) => {
              const pagesMap: Record<string, CanvasPage> = {};
              for (const p of parsed.pages) pagesMap[p.id] = p;
              s.pages = pagesMap;
              s.tree = parsed.tree;
              s.activePageId = parsed.activePageId;
              const active = pagesMap[parsed.activePageId];
              s.nodes = active.nodes;
              s.edges = active.edges;
              s.viewport = active.viewport;
              s.loaded = true;
              s.canUndo = false;
              s.canRedo = false;
            });
          } catch (error) {
            if (generation === loadGeneration && get().projectPath === path)
              set({ loaded: false, error: String(error) });
          }
        },
        flush: async (path) => {
          const target = path ?? get().projectPath;
          if (!target) return;
          const timer = saveTimers.get(target);
          if (timer) clearTimeout(timer);
          saveTimers.delete(target);
          await saveProjectDocuments(target);
        },
        saveNoteBody: async (path, pageId, noteId, body) => {
          let file = snapshots.get(path);
          if (!file) file = parseCanvasFile(await loadCanvas(path));
          const page = file.pages.find((p) => p.id === pageId);
          if (!page?.nodes.some((n) => n.id === noteId)) return; // intentionally deleted
          if (get().projectPath === path && get().loaded) {
            set((s) => {
              const target = s.activePageId === pageId ? s.nodes : s.pages[pageId]?.nodes;
              const note = target?.find((n) => n.id === noteId);
              if (note) {
                note.body = body;
                note.updatedAt = nowIso();
              }
            });
          } else {
            retainSnapshot(path, {
              ...file,
              pages: file.pages.map((p) =>
                p.id === pageId
                  ? {
                      ...p,
                      nodes: p.nodes.map((n) =>
                        n.id === noteId ? { ...n, body, updatedAt: nowIso() } : n,
                      ),
                    }
                  : p,
              ),
            });
          }
          await saveDocument(canvasKey(path));
        },
        addNote: (at) => {
          if (!writable()) return "";
          takeSnapshot();
          const id = genId("n");
          const stamp = nowIso();
          const x = at?.x ?? 0;
          const y = at?.y ?? 0;
          set((s) => {
            s.nodes.push({
              id,
              kind: "note",
              x,
              y,
              width: 320,
              title: "Untitled",
              body: "",
              createdAt: stamp,
              updatedAt: stamp,
            });
            s.selectedIds = [id];
          });
          logEvent({ source: "canvas", kind: "note-add", summary: "New note", payload: { id } });
          return id;
        },
        addText: (at) => {
          if (!writable()) return "";
          takeSnapshot();
          const id = genId("n");
          const stamp = nowIso();
          set((s) => {
            s.nodes.push({
              id,
              kind: "text",
              x: at?.x ?? 0,
              y: at?.y ?? 0,
              width: 200,
              title: "",
              body: "",
              text: "Text",
              createdAt: stamp,
              updatedAt: stamp,
            });
            s.selectedIds = [id];
          });
          logEvent({ source: "canvas", kind: "text-add", summary: "New text", payload: { id } });
          return id;
        },
        addShape: (shapeType, at, size) => {
          if (!writable()) return "";
          takeSnapshot();
          const id = genId("n");
          const stamp = nowIso();
          // Default sizes when placed with a click; drag-to-create passes `size`.
          const [defW, defH] =
            shapeType === "ellipse" || shapeType === "diamond" ? [130, 130] : [160, 90];
          const w = size ? Math.max(20, Math.round(size.width)) : defW;
          const h = size ? Math.max(20, Math.round(size.height)) : defH;
          set((s) => {
            s.nodes.push({
              id,
              kind: "shape",
              shapeType,
              x: at?.x ?? 0,
              y: at?.y ?? 0,
              width: w,
              height: h,
              title: "",
              body: "",
              text: "",
              createdAt: stamp,
              updatedAt: stamp,
            });
            s.selectedIds = [id];
          });
          logEvent({ source: "canvas", kind: "shape-add", summary: shapeType, payload: { id } });
          return id;
        },
        addMedia: ({ src, mediaKind, width, height }, at) => {
          if (!writable()) return "";
          takeSnapshot();
          const id = genId("n");
          const stamp = nowIso();
          set((s) => {
            s.nodes.push({
              id,
              kind: "media",
              x: at?.x ?? 0,
              y: at?.y ?? 0,
              width: width ?? 320,
              height,
              title: "",
              body: "",
              src,
              mediaKind,
              createdAt: stamp,
              updatedAt: stamp,
            });
            s.selectedIds = [id];
          });
          logEvent({ source: "canvas", kind: "media-add", summary: mediaKind, payload: { id } });
          return id;
        },
        updateNote: (id, patch) =>
          set((s) => {
            if (!writable()) return;
            const n = s.nodes.find((n) => n.id === id);
            if (!n) return;
            if (patch.title !== undefined) n.title = patch.title;
            if (patch.body !== undefined) n.body = patch.body;
            if (patch.width !== undefined) n.width = patch.width;
            if (patch.height !== undefined) n.height = patch.height;
            if (patch.icon !== undefined) n.icon = patch.icon;
            if (patch.text !== undefined) n.text = patch.text;
            if (patch.src !== undefined) n.src = patch.src;
            if (patch.mediaKind !== undefined) n.mediaKind = patch.mediaKind;
            n.updatedAt = nowIso();
          }),
        deleteNote: (id) => {
          if (!writable()) return;
          takeSnapshot();
          const removed = get().nodes.find((n) => n.id === id);
          set((s) => {
            s.nodes = s.nodes.filter((n) => n.id !== id);
            s.edges = s.edges.filter((e) => e.source !== id && e.target !== id);
            s.selectedIds = s.selectedIds.filter((x) => x !== id);
          });
          if (removed) {
            logEvent({
              source: "canvas",
              kind: "note-delete",
              summary: removed.title || "Untitled",
              payload: { id },
            });
          }
        },
        moveNote: (id, x, y) =>
          set((s) => {
            if (!writable()) return;
            const n = s.nodes.find((n) => n.id === id);
            if (!n) return;
            n.x = x;
            n.y = y;
          }),
        addEdge: (source, target, sourceHandle, targetHandle) => {
          if (!writable()) return;
          if (source === target) return;
          const exists = get().edges.some(
            (e) =>
              (e.source === source && e.target === target) ||
              (e.source === target && e.target === source),
          );
          if (exists) return;
          takeSnapshot();
          set((s) => {
            s.edges.push({ id: genId("e"), source, target, sourceHandle, targetHandle });
          });
          logEvent({
            source: "canvas",
            kind: "edge-add",
            summary: "Connection added",
            payload: { source, target },
          });
        },
        deleteEdge: (id) => {
          if (!writable()) return;
          takeSnapshot();
          set((s) => {
            s.edges = s.edges.filter((e) => e.id !== id);
          });
          logEvent({
            source: "canvas",
            kind: "edge-delete",
            summary: "Connection removed",
            payload: { id },
          });
        },
        setSelected: (id) =>
          set((s) => {
            s.selectedIds = id ? [id] : [];
          }),
        setSelectedIds: (ids) =>
          set((s) => {
            s.selectedIds = ids;
          }),
        setViewport: (vp) =>
          set((s) => {
            if (!writable()) return;
            s.viewport = vp;
          }),
        setFullscreen: (open) =>
          set((s) => {
            s.fullscreen = open;
          }),
        toggleFullscreen: () =>
          set((s) => {
            s.fullscreen = !s.fullscreen;
          }),
        setTool: (tool) =>
          set((s) => {
            s.activeTool = tool;
          }),
        beginInteraction: () => takeSnapshot(),
        undo: () => {
          if (!writable()) return;
          if (past.length === 0) return;
          future.push({ nodes: get().nodes, edges: get().edges });
          const prev = past.pop()!;
          set((s) => {
            s.nodes = prev.nodes;
            s.edges = prev.edges;
            s.canUndo = past.length > 0;
            s.canRedo = true;
          });
        },
        redo: () => {
          if (!writable()) return;
          if (future.length === 0) return;
          past.push({ nodes: get().nodes, edges: get().edges });
          const next = future.pop()!;
          set((s) => {
            s.nodes = next.nodes;
            s.edges = next.edges;
            s.canUndo = true;
            s.canRedo = future.length > 0;
          });
        },

        // ── Pages ──────────────────────────────────────────────────────────
        createPage: (parentId = null) => {
          if (!writable()) return "";
          const id = genId("p");
          set((s) => {
            s.pages[id] = emptyPage(id);
            const order = s.tree.filter((e) => e.parentId === parentId).length;
            s.tree.push({ id, kind: "page", parentId, name: "Untitled", order });
            // Fold the outgoing page back, then switch to the new (empty) page.
            const active = activePageSnapshot(s);
            if (active) s.pages[active.id] = active;
            s.activePageId = id;
            s.nodes = [];
            s.edges = [];
            s.viewport = { ...emptyViewport };
            s.selectedIds = [];
          });
          resetHistory();
          set((s) => {
            s.canUndo = false;
            s.canRedo = false;
          });
          logEvent({ source: "canvas", kind: "page-add", summary: "New page", payload: { id } });
          return id;
        },

        createPageFolder: (parentId = null) => {
          if (!writable()) return "";
          const id = genId("f");
          set((s) => {
            const order = s.tree.filter((e) => e.parentId === parentId).length;
            s.tree.push({ id, kind: "folder", parentId, name: "New folder", order });
          });
          return id;
        },

        setActivePage: (id) => {
          if (!writable()) return;
          if (get().activePageId === id) return;
          set((s) => {
            const target = s.pages[id];
            if (!target) return;
            // Fold the current working copy back into pages, then load the target.
            const active = activePageSnapshot(s);
            if (active) s.pages[active.id] = active;
            s.activePageId = id;
            s.nodes = target.nodes;
            s.edges = target.edges;
            s.viewport = target.viewport;
            s.selectedIds = [];
          });
          resetHistory();
          set((s) => {
            s.canUndo = false;
            s.canRedo = false;
          });
        },

        renameTreeEntry: (id, name) =>
          set((s) => {
            if (!writable()) return;
            const e = s.tree.find((t) => t.id === id);
            if (!e) return;
            e.name = name;
          }),

        setTreeEntryIcon: (id, icon) =>
          set((s) => {
            if (!writable()) return;
            const e = s.tree.find((t) => t.id === id);
            if (!e) return;
            e.icon = icon ?? undefined;
          }),

        deleteTreeEntry: (id) => {
          if (!writable()) return;
          set((s) => {
            // Collect the entry + all descendants (folders cascade).
            const toRemove = new Set<string>([id]);
            let grew = true;
            while (grew) {
              grew = false;
              for (const e of s.tree) {
                if (e.parentId && toRemove.has(e.parentId) && !toRemove.has(e.id)) {
                  toRemove.add(e.id);
                  grew = true;
                }
              }
            }
            const removedPageIds = s.tree
              .filter((e) => toRemove.has(e.id) && e.kind === "page")
              .map((e) => e.id);
            const remainingPages = s.tree.filter((e) => e.kind === "page" && !toRemove.has(e.id));
            // Never delete the last page.
            if (remainingPages.length === 0) return;

            s.tree = s.tree.filter((e) => !toRemove.has(e.id));
            for (const pid of removedPageIds) delete s.pages[pid];

            // If the active page was removed, switch to another page.
            if (s.activePageId && removedPageIds.includes(s.activePageId)) {
              const next = remainingPages[0];
              const target = s.pages[next.id];
              s.activePageId = next.id;
              s.nodes = target?.nodes ?? [];
              s.edges = target?.edges ?? [];
              s.viewport = target?.viewport ?? { ...emptyViewport };
              s.selectedIds = [];
              resetHistory();
              s.canUndo = false;
              s.canRedo = false;
            }
          });
        },
      },
    };
  }),
);

// Subscribe after each committed mutation; actions inside Immer producers must
// never snapshot the previous state or read a future project's global state.
useCanvasStore.subscribe((state, previous) => {
  if (
    !state.loaded ||
    !previous.loaded ||
    !state.projectPath ||
    state.projectPath !== previous.projectPath ||
    state.error
  )
    return;
  if (
    state.nodes === previous.nodes &&
    state.edges === previous.edges &&
    state.viewport === previous.viewport &&
    state.pages === previous.pages &&
    state.tree === previous.tree &&
    state.activePageId === previous.activePageId
  )
    return;
  retainSnapshot(state.projectPath, snapshot(state));
});
