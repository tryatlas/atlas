import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";

interface ProjectSession {
  lastOpenedFiles: string[];
  knowledgeActiveNoteId: string | null;
  chatContext: string;
  searchHistory: string[];
}

interface SessionState {
  /** The project `session` belongs to — `null` before any project loaded. */
  projectPath: string | null;
  session: ProjectSession;
  actions: {
    setLastOpenedFiles: (files: string[]) => void;
    setKnowledgeActiveNote: (id: string | null) => void;
    setChatContext: (context: string) => void;
    /** Record a search made in `projectPath`. Dropped when that is no longer
     *  the project this store holds: a search that finishes after a switch
     *  must not land in the next project's history. */
    addSearchHistory: (projectPath: string, query: string) => void;
    removeSearchHistory: (query: string) => void;
    clearSearchHistory: () => void;
    saveSession: (projectPath: string) => Promise<void>;
    loadSession: (projectPath: string) => Promise<void>;
  };
}

const defaultSession: ProjectSession = {
  lastOpenedFiles: [],
  knowledgeActiveNoteId: null,
  chatContext: "",
  searchHistory: [],
};

const SEARCH_HISTORY_CAP = 20;

function withQuery(history: string[], query: string): string[] {
  return [query, ...history.filter((q) => q !== query)].slice(0, SEARCH_HISTORY_CAP);
}

/** The in-flight `loadSession`, so a save waits for the file it would
 *  otherwise overwrite with a half-loaded session. */
let loading: { path: string; done: Promise<void> } | null = null;
/** Searches recorded while the project's session was still loading; applied
 *  on top of the loaded history rather than lost under it. */
let addedWhileLoading: string[] = [];

export const useSessionStore = create<SessionState>()((set, get) => ({
  projectPath: null,
  session: { ...defaultSession },
  actions: {
    setLastOpenedFiles: (files) =>
      set((s) => ({ session: { ...s.session, lastOpenedFiles: files } })),
    setKnowledgeActiveNote: (id) =>
      set((s) => ({ session: { ...s.session, knowledgeActiveNoteId: id } })),
    setChatContext: (context) => set((s) => ({ session: { ...s.session, chatContext: context } })),
    addSearchHistory: (projectPath, query) => {
      if (get().projectPath !== projectPath) return;
      if (loading?.path === projectPath) addedWhileLoading.push(query);
      set((s) => ({
        session: { ...s.session, searchHistory: withQuery(s.session.searchHistory, query) },
      }));
    },
    removeSearchHistory: (query) =>
      set((s) => ({
        session: {
          ...s.session,
          searchHistory: s.session.searchHistory.filter((q) => q !== query),
        },
      })),
    clearSearchHistory: () => set((s) => ({ session: { ...s.session, searchHistory: [] } })),
    saveSession: async (projectPath) => {
      if (loading?.path === projectPath) await loading.done;
      // Only the session this store holds for `projectPath` may be written
      // there: after a switch it holds another project's.
      if (get().projectPath !== projectPath) return;
      try {
        const data = JSON.stringify(get().session);
        await invoke("save_project_session", {
          projectPath,
          sessionData: data,
        });
      } catch {
        // silent fail
      }
    },
    loadSession: (projectPath) => {
      addedWhileLoading = [];
      // The store belongs to the new project at once: the previous project's
      // history is never shown in, or saved into, this one.
      set({ projectPath, session: { ...defaultSession } });
      const entry: { path: string; done: Promise<void> } = {
        path: projectPath,
        done: Promise.resolve(),
      };
      loading = entry;
      const current = () => loading === entry;
      entry.done = (async () => {
        let session: ProjectSession;
        try {
          const raw = await invoke<string>("load_project_session", { projectPath });
          session = { ...defaultSession, ...(JSON.parse(raw) as Partial<ProjectSession>) };
        } catch {
          session = { ...defaultSession };
        }
        if (!current()) return;
        let searchHistory = session.searchHistory;
        for (const query of addedWhileLoading) searchHistory = withQuery(searchHistory, query);
        addedWhileLoading = [];
        loading = null;
        set({ session: { ...session, searchHistory } });
      })();
      return entry.done;
    },
  },
}));
