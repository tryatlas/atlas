import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { logEvent } from "@/features/log/lib/log";

export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  source: string;
  file_path: string;
  updated_at: string;
}

interface KnowledgeState {
  projectPath: string | null;
  entries: KnowledgeEntry[];
  activeEntryId: string | null;
  editContent: string;
  loading: boolean;
  error: string | null;
  /** Requests from another surface are consumed after the outgoing note saves. */
  pendingOpenId: string | null;
  actions: {
    loadEntries: (projectPath: string) => Promise<void>;
    selectEntry: (id: string) => void;
    requestOpen: (id: string) => void;
    consumePendingOpen: () => void;
    setEditContent: (content: string) => void;
    saveEntry: (projectPath: string, id: string, content: string) => Promise<void>;
    createEntry: (projectPath: string) => Promise<void>;
    deleteEntry: (projectPath: string, id: string) => Promise<void>;
    createDir: (projectPath: string, dirName: string) => Promise<void>;
  };
}

let loadGeneration = 0;

export const useKnowledgeStore = create<KnowledgeState>()((set, get) => ({
  projectPath: null,
  entries: [],
  activeEntryId: null,
  editContent: "",
  loading: false,
  error: null,
  pendingOpenId: null,
  actions: {
    loadEntries: async (projectPath) => {
      const generation = ++loadGeneration;
      if (get().projectPath !== projectPath) {
        set({
          projectPath,
          entries: [],
          activeEntryId: null,
          editContent: "",
          loading: true,
          error: null,
        });
      }
      try {
        const newEntries = await invoke<KnowledgeEntry[]>("list_knowledge", { projectPath });
        if (generation !== loadGeneration || get().projectPath !== projectPath) return;
        const current = get();
        const active =
          newEntries.find((entry) => entry.id === current.activeEntryId) ?? newEntries[0];
        set({
          entries: newEntries,
          loading: false,
          error: null,
          activeEntryId: active?.id ?? null,
          editContent: active?.content ?? "",
        });
        void import("@/features/chat/lib/mentions").then((m) => m.publishKnowledgeToMentionCache());
      } catch (error) {
        if (generation === loadGeneration && get().projectPath === projectPath) {
          set({ loading: false, error: String(error) });
        }
        throw error;
      }
    },
    selectEntry: (id) => {
      const entry = get().entries.find((e) => e.id === id);
      set({ activeEntryId: id, editContent: entry?.content ?? "" });
    },
    requestOpen: (id) => set({ pendingOpenId: id }),
    consumePendingOpen: () => set({ pendingOpenId: null }),
    setEditContent: (content) => set({ editContent: content }),
    saveEntry: async (projectPath, id, content) => {
      if (!id || !projectPath) throw new Error("The note has no project or document identity.");
      await invoke("save_knowledge_note", { projectPath, id, content });
      const title =
        content
          .split("\n")[0]
          ?.replace(/^#+\s*/, "")
          .slice(0, 60) || "note";
      if (get().projectPath === projectPath) {
        set((state) => ({
          entries: state.entries.map((e) =>
            e.id === id ? { ...e, content, title, updated_at: new Date().toISOString() } : e,
          ),
          ...(state.activeEntryId === id ? { editContent: content } : {}),
        }));
      }
      void invoke("log_interaction", {
        projectPath,
        interactionType: "note_edit",
        summary: `Edited note: ${title}`,
      }).catch(() => {});
      logEvent({
        source: "knowledge",
        kind: "note-save",
        summary: title,
        projectPath,
        payload: { id },
      });
    },
    createEntry: async (projectPath) => {
      const id = `note-${crypto.randomUUID()}`;
      const content = "# Untitled\n\n";
      await invoke("save_knowledge_note", { projectPath, id, content });
      if (get().projectPath === projectPath) {
        await get().actions.loadEntries(projectPath);
        if (get().projectPath === projectPath) set({ activeEntryId: id, editContent: content });
      }
      logEvent({
        source: "knowledge",
        kind: "note-create",
        summary: "New note",
        projectPath,
        payload: { id },
      });
    },
    deleteEntry: async (projectPath, id) => {
      await invoke("delete_knowledge_note", { projectPath, id });
      if (get().projectPath === projectPath) {
        // The successful delete is reflected before refreshing; a failed refresh
        // must not make the caller think deletion itself failed.
        set((state) => {
          const entries = state.entries.filter((entry) => entry.id !== id);
          const active = entries.find((entry) => entry.id === state.activeEntryId) ?? entries[0];
          return { entries, activeEntryId: active?.id ?? null, editContent: active?.content ?? "" };
        });
      }
      logEvent({
        source: "knowledge",
        kind: "note-delete",
        summary: id,
        projectPath,
        payload: { id },
      });
    },
    createDir: async (projectPath, dirName) => {
      await invoke("create_knowledge_dir", { projectPath, dirName });
      logEvent({
        source: "knowledge",
        kind: "dir-create",
        summary: dirName,
        projectPath,
        payload: { dirName },
      });
    },
  },
}));
