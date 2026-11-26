import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { onThreadsChanged, threadHistory } from "../lib/history-api";
import { useSessionProjectsStore } from "../stores/session-projects-store";

/*
 * Feeds `session-projects-store` with every session's attached projects, which
 * the composer's project chips read. The composer mounts it, so the chips stay
 * current whichever view the session was opened from — the sidebar, the
 * History view, another project.
 *
 * One source, one writer: the query below reads the whole history store
 * (`threads_history`, every row) and its `queryFn` is the only caller of
 * `mergeRows`. Every mounted composer observes the same query, so N composers
 * cost one IPC per refresh, not N. Refreshes ride `atlas:threads-changed`
 * through ONE listener shared by every observer, so an event never starts N
 * refetches that cancel each other.
 */

export const SESSION_PROJECTS_QUERY_KEY = ["thread-history", "session-projects"] as const;

async function fetchSessionProjects(): Promise<number> {
  const rows = await threadHistory();
  useSessionProjectsStore.getState().actions.mergeRows(rows);
  return rows.length;
}

/** One `atlas:threads-changed` listener per query client, refcounted. */
const shared = new Map<QueryClient, { users: number; unlisten: Promise<UnlistenFn> }>();

function retainListener(client: QueryClient): () => void {
  let entry = shared.get(client);
  if (!entry) {
    entry = {
      users: 0,
      unlisten: onThreadsChanged(() => {
        void client.invalidateQueries({ queryKey: SESSION_PROJECTS_QUERY_KEY });
      }),
    };
    shared.set(client, entry);
  }
  entry.users += 1;
  const held = entry;
  return () => {
    held.users -= 1;
    if (held.users > 0) return;
    shared.delete(client);
    void held.unlisten.then((u) => u());
  };
}

/**
 * Keep every session's attached projects current while `enabled` (the
 * composer has a session). Read them with `useSessionProjects`.
 */
export function useSessionProjectsFeed(enabled: boolean): void {
  const client = useQueryClient();
  useQuery({
    queryKey: SESSION_PROJECTS_QUERY_KEY,
    queryFn: fetchSessionProjects,
    enabled,
    // Events keep it current while anything observes it; with nothing mounted
    // there is no listener, so a fresh composer must not trust the cache.
    staleTime: 0,
  });
  useEffect(() => {
    if (!enabled) return;
    return retainListener(client);
  }, [enabled, client]);
}
