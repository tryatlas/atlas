import { useEffect, useState } from "react";
import { gitDiffFile } from "./git-changes-api";

/** What the Changes view's diff pane shows for the selected file. */
export type SelectedFileDiff =
  | { state: "none" }
  | { state: "loading" }
  | { state: "ready"; diff: string }
  | { state: "error"; message: string };

interface Loaded {
  /** The repo/file/staged triple this answer belongs to. */
  key: string;
  diff: string | null;
  error: string | null;
}

/**
 * The selected file's diff, tied to the file it was loaded for. A diff
 * loaded for one file is never shown under another's name: while the newly
 * selected file loads the pane says so, and a failed load shows the failure
 * instead of keeping the previous file's hunks (whose stage/discard buttons
 * would then act on the wrong file). A reload of the same file (a new
 * `statusList` after a refresh, or a bumped `epoch` after a hunk op) keeps
 * the current diff until the new one lands, so the pane doesn't flicker.
 */
export function useSelectedFileDiff(
  repoPath: string | null,
  file: string | null,
  staged: boolean,
  statusList: unknown,
  epoch: number,
): SelectedFileDiff {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const key = repoPath && file ? JSON.stringify([repoPath, file, staged]) : null;

  useEffect(() => {
    if (!repoPath || !file || !key) return;
    let cancelled = false;
    gitDiffFile(repoPath, file, staged)
      .then((diff) => {
        if (!cancelled) setLoaded({ key, diff, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoaded({ key, diff: null, error: String(error) });
      });
    return () => {
      cancelled = true;
    };
  }, [repoPath, file, staged, key, statusList, epoch]);

  if (!key) return { state: "none" };
  if (!loaded || loaded.key !== key) return { state: "loading" };
  if (loaded.error !== null) return { state: "error", message: loaded.error };
  return { state: "ready", diff: loaded.diff ?? "" };
}
