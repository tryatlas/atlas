import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  captureDocumentEdit,
  deleteDocument,
  documentKey,
  saveDocument,
} from "@/features/editor-notion/lib/document-saves";

export interface PageMeta {
  icon?: string | null;
  cover?: string | null;
  title?: string | null;
  status?: string | null;
  tags?: string[];
  owner?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface PageMetaPatch {
  icon?: string | null;
  cover?: string | null;
  title?: string | null;
  status?: string | null;
  tags?: string[];
  owner?: string | null;
}

export interface MetaFile {
  version: number;
  pages: Record<string, RustPageMeta>;
}

export interface RustPageMeta {
  icon?: string | null;
  cover?: string | null;
  title?: string | null;
  status?: string | null;
  tags?: string[];
  owner?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

function fromRust(m: RustPageMeta): PageMeta {
  return {
    icon: m.icon ?? null,
    cover: m.cover ?? null,
    title: m.title ?? null,
    status: m.status ?? null,
    tags: m.tags ?? [],
    owner: m.owner ?? null,
    createdAt: m.created_at ?? null,
    updatedAt: m.updated_at ?? null,
  };
}

interface KnowledgeMetaState {
  /** Last project we hydrated for — `null` when not bound to anything. */
  projectPath: string | null;
  pages: Record<string, PageMeta>;
  loading: boolean;
  error: string | null;
  writable: boolean;
  actions: {
    /** Hydrate from disk + start listening. Idempotent per project path. */
    bind: (projectPath: string) => Promise<void>;
    unbind: () => void;
    retry: () => Promise<void>;
    /** Merge a patch into the active page and persist durably in Rust. */
    patch: (entryId: string, patch: PageMetaPatch) => Promise<void>;
    /** Drop a page's metadata entirely (e.g. after `delete_knowledge_note`). */
    drop: (entryId: string) => Promise<void>;
  };
}

let unlisten: UnlistenFn | null = null;
let bindingGeneration = 0;
let loadGeneration = 0;
const drafts = new Map<string, { path: string; entryId: string; patch: PageMetaPatch }>();

function applyDrafts(path: string, pages: Record<string, PageMeta>): Record<string, PageMeta> {
  const next = { ...pages };
  for (const draft of drafts.values()) {
    if (draft.path === path) next[draft.entryId] = { ...next[draft.entryId], ...draft.patch };
  }
  return next;
}

// Re-push knowledge titles + icons into the Rust mention cache so the
// @-/~ picker shows real titles + emoji instead of note ids. Must run
// after a bulk meta hydrate (not just single-title patches) — the
// initial `entries` publish happens before `_meta.json` loads, so
// without this the cache stays stuck on filename-style ids. Lazy import
// avoids a static cycle with chat/lib/mentions (which imports this store).
function republishMentionCache() {
  void import("@/features/chat/lib/mentions").then((m) => m.publishKnowledgeToMentionCache());
}

const store = create<KnowledgeMetaState>()((set, get) => {
  const refresh = async (path: string, binding: number) => {
    const generation = ++loadGeneration;
    try {
      const file = await invoke<MetaFile>("knowledge_meta_load", { projectPath: path });
      if (
        binding !== bindingGeneration ||
        generation !== loadGeneration ||
        get().projectPath !== path
      )
        return;
      set({
        pages: applyDrafts(path, mapPages(file.pages)),
        loading: false,
        writable: file.version === 1,
        error:
          file.version === 1
            ? null
            : "This metadata version is newer than Atlas. Open it in a newer version before editing.",
      });
      republishMentionCache();
    } catch (error) {
      if (
        binding !== bindingGeneration ||
        generation !== loadGeneration ||
        get().projectPath !== path
      )
        return;
      set({ loading: false, writable: false, error: String(error) });
    }
  };
  return {
    projectPath: null,
    pages: {},
    loading: false,
    error: null,
    writable: false,
    actions: {
      bind: async (projectPath) => {
        if (get().projectPath === projectPath && unlisten) {
          await refresh(projectPath, bindingGeneration);
          return;
        }
        get().actions.unbind();
        const binding = bindingGeneration;
        set({ projectPath, loading: true, pages: {}, error: null, writable: false });
        // Subscribe before reading so a write between load and listen is observed.
        const off = await listen<{ projectPath: string }>(
          "atlas:knowledge:meta-changed",
          (event) => {
            if (event.payload.projectPath === projectPath && binding === bindingGeneration)
              void refresh(projectPath, binding);
          },
        ).catch((error) => {
          if (binding === bindingGeneration) set({ error: String(error), loading: false });
          return null;
        });
        if (binding !== bindingGeneration) {
          off?.();
          return;
        }
        unlisten = off;
        await refresh(projectPath, binding);
      },
      unbind: () => {
        bindingGeneration += 1;
        unlisten?.();
        unlisten = null;
        set({ projectPath: null, pages: {}, loading: false, writable: false, error: null });
      },
      retry: async () => {
        const path = get().projectPath;
        if (!path) return;
        await get().actions.bind(path);
        if (!get().writable || get().projectPath !== path) return;
        await Promise.all(
          [...drafts].filter(([, draft]) => draft.path === path).map(([key]) => saveDocument(key)),
        );
      },
      patch: async (entryId, patch) => {
        const { projectPath, writable } = get();
        if (!projectPath || !writable) {
          const error = new Error(
            "Page properties are read-only until their file is repaired and reloaded.",
          );
          toast.error(error.message);
          throw error;
        }
        const key = documentKey(projectPath, "knowledge-meta", entryId);
        const draft = {
          path: projectPath,
          entryId,
          patch: { ...drafts.get(key)?.patch, ...patch },
        };
        drafts.set(key, draft);
        set((state) => ({
          pages: { ...state.pages, [entryId]: { ...state.pages[entryId], ...patch } },
        }));
        captureDocumentEdit(key, {
          projectPath,
          serialize: () => JSON.stringify(toRustPatch(draft.patch)),
          persist: async (raw) => {
            try {
              await invoke("knowledge_meta_patch", {
                projectPath,
                entryId,
                patch: JSON.parse(raw),
              });
              if (drafts.get(key) === draft) drafts.delete(key);
              if (get().projectPath === projectPath) {
                set({ error: null });
                republishMentionCache();
              }
            } catch (error) {
              if (get().projectPath === projectPath) set({ error: String(error) });
              throw error;
            }
          },
        });
        try {
          await saveDocument(key);
        } catch (error) {
          toast.error(`Page properties could not be saved: ${String(error)}`);
          throw error;
        }
      },
      drop: async (entryId) => {
        const projectPath = get().projectPath;
        if (!projectPath) return;
        const key = documentKey(projectPath, "knowledge-meta", entryId);
        try {
          await deleteDocument(key, async () => {
            await invoke("knowledge_meta_delete", { projectPath, entryId });
            drafts.delete(key);
            if (get().projectPath === projectPath)
              set((state) => {
                const pages = { ...state.pages };
                delete pages[entryId];
                return { pages };
              });
          });
        } catch (error) {
          if (get().projectPath === projectPath) set({ error: String(error) });
          throw error;
        }
      },
    },
  };
});

function mapPages(raw: Record<string, RustPageMeta>): Record<string, PageMeta> {
  const out: Record<string, PageMeta> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = fromRust(v);
  }
  return out;
}

function toRustPatch(p: PageMetaPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (p.icon !== undefined) out.icon = p.icon;
  if (p.cover !== undefined) out.cover = p.cover;
  if (p.title !== undefined) out.title = p.title;
  if (p.status !== undefined) out.status = p.status;
  if (p.tags !== undefined) out.tags = p.tags;
  if (p.owner !== undefined) out.owner = p.owner;
  return out;
}

export const useKnowledgeMetaStore = store;

/** Convenience hook for a single page's meta with safe defaults. */
export function usePageMeta(entryId: string | null | undefined): PageMeta {
  const pages = useKnowledgeMetaStore((s) => s.pages);
  if (!entryId) return { tags: [] };
  return pages[entryId] ?? { tags: [] };
}
