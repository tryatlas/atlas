import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  memoryGraph,
  listenMemoryEmbedProgress,
  listenMemoryEmbedDone,
  type DownloadProgress,
  type QueryHit,
} from "../lib/memory-graph-api";
import type { MemoryGraphData } from "../components/memory-graph-canvas";

export type MemoryGraphPhase =
  | "checking"
  | "not-downloaded"
  | "downloading"
  | "download-failed"
  | "indexing"
  | "graph-ready"
  | "error";

interface MemoryGraphState {
  phase: MemoryGraphPhase;
  projectPath: string | null;
  progress: DownloadProgress | null;
  error: string | null;
  graph: MemoryGraphData | null;
  docCount: number;
  // Query
  query: string;
  querying: boolean;
  results: QueryHit[];
  matchedIds: Set<string>;
  selectedId: string | null;
  actions: {
    init: (projectPath: string) => Promise<void>;
    download: () => Promise<void>;
    buildIndex: (projectPath: string) => Promise<void>;
    runQuery: (projectPath: string, q: string) => Promise<void>;
    setQuery: (q: string) => void;
    clearQuery: () => void;
    select: (id: string | null) => void;
  };
}

// Module-level listener handles so an in-flight download survives the Memory
// tab unmounting (it isn't a persistent tab).
let unlistens: UnlistenFn[] = [];
let graphGeneration = 0;
let queryGeneration = 0;
const clearListeners = () => {
  unlistens.forEach((u) => u());
  unlistens = [];
};

export const useMemoryGraphStore = create<MemoryGraphState>()((set, get) => ({
  phase: "checking",
  projectPath: null,
  progress: null,
  error: null,
  graph: null,
  docCount: 0,
  query: "",
  querying: false,
  results: [],
  matchedIds: new Set(),
  selectedId: null,
  actions: {
    init: async (projectPath) => {
      const generation = ++graphGeneration;
      queryGeneration++;
      const prev = get().projectPath;
      set({ projectPath });
      // Project changed → drop the cached graph so we don't show a stale one.
      if (prev !== null && prev !== projectPath) {
        set({
          graph: null,
          querying: false,
          docCount: 0,
          query: "",
          results: [],
          matchedIds: new Set(),
          selectedId: null,
        });
      }
      // Otherwise: don't clobber an in-flight download/index, and treat an
      // already-built graph as a cache hit (no re-index on remount).
      const p = get().phase;
      if (p === "downloading") return;
      if (p === "graph-ready" && get().graph) return;
      set({ phase: "checking", error: null });
      try {
        const status = await memoryGraph.embedStatus();
        if (generation !== graphGeneration || get().projectPath !== projectPath) return;
        if (status.downloaded) {
          await get().actions.buildIndex(projectPath);
        } else {
          set({ phase: "not-downloaded" });
        }
      } catch (e) {
        if (generation !== graphGeneration || get().projectPath !== projectPath) return;
        set({ phase: "error", error: String(e) });
      }
    },

    download: async () => {
      clearListeners();
      set({ phase: "downloading", progress: null, error: null });
      unlistens.push(await listenMemoryEmbedProgress((p) => set({ progress: p })));
      unlistens.push(
        await listenMemoryEmbedDone((d) => {
          clearListeners();
          if (d.success) {
            const pp = get().projectPath;
            set({ progress: null });
            if (pp) void get().actions.buildIndex(pp);
            else set({ phase: "indexing" });
          } else {
            set({
              phase: "download-failed",
              error: d.error ?? "Download failed",
            });
          }
        }),
      );
      try {
        await memoryGraph.embedDownload();
      } catch (e) {
        clearListeners();
        set({ phase: "download-failed", error: String(e) });
      }
    },

    buildIndex: async (projectPath) => {
      if (get().projectPath !== projectPath) return;
      const generation = ++graphGeneration;
      set({ phase: "indexing", error: null });
      try {
        const g = await memoryGraph.buildIndex(projectPath);
        if (generation !== graphGeneration || get().projectPath !== projectPath) return;
        set({
          phase: "graph-ready",
          graph: { nodes: g.nodes, edges: g.edges },
          docCount: g.doc_count,
        });
      } catch (e) {
        if (generation !== graphGeneration || get().projectPath !== projectPath) return;
        const msg = String(e);
        if (msg.includes("model-not-downloaded")) {
          set({ phase: "not-downloaded" });
        } else {
          set({ phase: "error", error: msg });
        }
      }
    },

    runQuery: async (projectPath, q) => {
      if (get().projectPath !== projectPath) return;
      const generation = ++queryGeneration;
      const query = q.trim();
      if (!query) {
        set({ results: [], matchedIds: new Set(), querying: false });
        return;
      }
      set({ querying: true });
      try {
        const hits = await memoryGraph.query(projectPath, query, 12);
        if (generation !== queryGeneration || get().projectPath !== projectPath) return;
        set({
          results: hits,
          matchedIds: new Set(hits.map((h) => h.id)),
          querying: false,
        });
      } catch {
        if (generation !== queryGeneration || get().projectPath !== projectPath) return;
        set({ querying: false });
      }
    },

    setQuery: (q) => set({ query: q }),
    clearQuery: () => {
      queryGeneration++;
      set({ query: "", querying: false, results: [], matchedIds: new Set(), selectedId: null });
    },
    select: (id) => set({ selectedId: id }),
  },
}));
