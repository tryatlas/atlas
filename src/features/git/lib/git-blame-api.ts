// Bridge to the native `git_blame_file` command — per-line blame for the
// editor's inline annotation. Empty array ⇒ untracked file / not a repo.

import { invoke } from "@tauri-apps/api/core";
import { coalesceByKey } from "@/lib/coalesce-by-key";

export interface BlameLine {
  /** 1-based line number in the current file. */
  line: number;
  sha: string;
  shortSha: string;
  author: string;
  /** Author time as unix milliseconds (0 if unparsable). */
  timeMs: number;
  summary: string;
  /** False for lines git attributes to "Not Committed Yet". */
  committed: boolean;
}

/**
 * Blame `file` in `repoPath`. A `git blame` of a large file takes seconds, and
 * several signals ask for one at once (the view mounting, a save, the git
 * watcher), so calls for the same file share one process: at most one runs
 * and one waits behind it (`coalesceByKey`).
 */
export const gitBlameFile = coalesceByKey(
  (repoPath: string, file: string) => `${repoPath}\0${file}`,
  (repoPath: string, file: string) =>
    invoke<BlameLine[]>("git_blame_file", { path: repoPath, file }),
);
