// Bridge to the native `atlas-gitdiff` crate (Rust) for the editor gutter's
// line classification, and the entry point that opens the review diff.

import { invoke } from "@tauri-apps/api/core";
import { coalesceByKey } from "@/lib/coalesce-by-key";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { requestDiffJump } from "./diff-jump";
import { openCommit } from "./open-commit";

export interface DiffLineStatus {
  added: number[];
  changed: number[];
  deletedBefore: number[];
}

/** The editor gutter's change bars for `file`. Calls for the same file share
 *  one `git diff`, as `gitBlameFile` does for blame. */
export const gitDiffLineStatus = coalesceByKey(
  (repoPath: string, file: string, staged: boolean) => `${repoPath}\0${file}\0${staged}`,
  (repoPath: string, file: string, staged: boolean) =>
    invoke<DiffLineStatus>("git_diff_line_status", { path: repoPath, file, staged }),
);

/** The review diff's tab id for a repository: one per repository. */
export function diffTabId(repoPath: string): string {
  return `diff:${repoPath}`;
}

/**
 * Show `file`'s change in the review diff beside the session.
 *
 * One review tab per repository: opening another file focuses it and scrolls
 * to that file rather than stacking a tab per file. The working-tree scope
 * covers staged and unstaged changes alike, so `staged` picks nothing apart
 * from it today. With `commit`, the change is that commit's, which the commit
 * tab shows.
 */
export function openGitDiff(
  repoPath: string,
  file: string,
  _staged: boolean,
  commit?: string | null,
): void {
  if (commit) {
    openCommit(repoPath, commit);
    return;
  }
  const id = diffTabId(repoPath);
  // The scope stays the reader's: a new tab starts on the working tree, and
  // an open one keeps whatever they chose.
  if (file) requestDiffJump(id, file);
  const { addTab, setActiveTab } = useLayoutStore.getState().actions;
  addTab({
    id,
    type: "diff",
    title: "Changes",
    closable: true,
    dirty: false,
    data: { repoPath },
  });
  setActiveTab(id);
}
