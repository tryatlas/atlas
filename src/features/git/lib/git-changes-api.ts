// The working tree, one file or hunk at a time: its diff, staging by hunk,
// and conflict resolution (`src-tauri/src/commands/git.rs`).

import { invoke } from "@tauri-apps/api/core";

import type { ConflictState } from "../components/git-manager/conflicts-view";
import type { hunkWireLines } from "./diff";

/** The file's unified diff against the index. */
export function gitDiffFile(path: string, file: string, staged = false): Promise<string> {
  return invoke<string>("git_diff_file", { path, file, staged });
}

/** A hunk, as Rust takes it: its wire lines, and which of them are picked. */
export interface HunkOpArgs {
  path: string;
  file: string;
  lines: ReturnType<typeof hunkWireLines>;
  /** Indexes of the picked lines; `null` for the whole hunk. */
  selected: number[] | null;
}

/** What can be done to a hunk. Each is its own command, named here so the
 *  IPC contract can read every one of them as a literal. */
export const hunkOps = {
  stage: (args: HunkOpArgs): Promise<void> => invoke("git_stage_hunk", { ...args }),
  unstage: (args: HunkOpArgs): Promise<void> => invoke("git_unstage_hunk", { ...args }),
  discard: (args: HunkOpArgs): Promise<void> => invoke("git_discard_hunk", { ...args }),
};

export function gitConflictState(path: string): Promise<ConflictState> {
  return invoke<ConflictState>("git_conflict_state", { path });
}

export function gitResolveFile(path: string, file: string, resolution: string): Promise<void> {
  return invoke("git_resolve_file", { path, file, resolution });
}
