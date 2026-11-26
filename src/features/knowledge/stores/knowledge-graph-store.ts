import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ProjectGraph } from "../lib/knowledge-graph-model";

export type { GraphEdge, GraphNode, ProjectGraph } from "../lib/knowledge-graph-model";

interface KnowledgeGraphState {
  projectPath: string | null;
  /** Cached graph for the bound project. `null` while the first
   *  invoke is still in flight (shows "Loading…" instead of the
   *  empty-state flash). */
  graph: ProjectGraph | null;
  actions: {
    bind: (projectPath: string) => Promise<void>;
    unbind: () => void;
  };
}

let unlisten: UnlistenFn | null = null;
/** Bumped by every `unbind`. A `bind` whose `listen` resolves after a newer
 *  bind/unbind disposes its own listener instead of leaking it. */
let bindingGeneration = 0;

async function fetchGraph(projectPath: string): Promise<ProjectGraph> {
  try {
    return await invoke<ProjectGraph>("knowledge_links_graph", { projectPath });
  } catch {
    return { nodes: [], edges: [] };
  }
}

const store = create<KnowledgeGraphState>()((set, get) => ({
  projectPath: null,
  graph: null,
  actions: {
    bind: async (projectPath) => {
      // Re-bind to the same project: keep the cached graph (avoid
      // flashing "Loading…" on a tab re-open) but listen fresh.
      if (get().projectPath === projectPath && unlisten) return;
      get().actions.unbind();
      const binding = bindingGeneration;
      set({ projectPath, graph: null });
      const current = () => binding === bindingGeneration && get().projectPath === projectPath;

      // Subscribe before the initial fetch so the listener catches any
      // save events that fire mid-load.
      const off = await listen<{ projectPath: string }>(
        "atlas:knowledge:links-changed",
        async (event) => {
          if (!current() || event.payload?.projectPath !== projectPath) return;
          const next = await fetchGraph(projectPath);
          // Bail if the project changed under us mid-fetch.
          if (!current()) return;
          set({ graph: next });
        },
      ).catch(() => null);
      if (binding !== bindingGeneration) {
        off?.();
        return;
      }
      unlisten = off;

      const initial = await fetchGraph(projectPath);
      if (!current()) return;
      set({ graph: initial });
    },
    unbind: () => {
      bindingGeneration += 1;
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      set({ projectPath: null, graph: null });
    },
  },
}));

export const useKnowledgeGraphStore = store;

/** Hook: returns the cached graph + loading flag.
 *  - `loading` is true only on the first hydrate per project bind.
 *  - After that, the cached graph is returned synchronously and
 *    updates in-place when Rust emits `links-changed`. */
export function useProjectGraph(): { graph: ProjectGraph; loading: boolean } {
  const projectPath = useKnowledgeGraphStore((s) => s.projectPath);
  const graph = useKnowledgeGraphStore((s) => s.graph);
  return {
    graph: graph ?? { nodes: [], edges: [] },
    loading: projectPath !== null && graph === null,
  };
}
