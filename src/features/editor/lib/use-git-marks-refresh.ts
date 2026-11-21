import { useCallback, useEffect, useRef } from "react";

/**
 * When a file tab repaints its git marks: the change bars and the inline
 * blame.
 *
 * Every open file tab stays mounted and hears the git watcher, the explorer
 * and its own saves. Answering each of those in every tab, shown or not, is a
 * `git diff` and a `git blame` per tab: a commit with ten files open is twenty
 * git processes, and restoring a project with many tabs blames every file at
 * once, which on a large repository pins the CPU. The marks only matter to
 * someone looking at them.
 *
 * Returns `request`, to call wherever the marks may have gone stale. While
 * the tab is `visible` it runs `refresh` at once. While hidden it only notes
 * that they are stale, and the tab refreshes once when it is shown again.
 * A tab that heard nothing while hidden shows the marks it already had.
 */
export function useGitMarksRefresh(visible: boolean, refresh: () => void): () => void {
  const visibleRef = useRef(visible);
  const staleRef = useRef(false);

  useEffect(() => {
    visibleRef.current = visible;
    if (visible && staleRef.current) {
      staleRef.current = false;
      refresh();
    }
  }, [visible, refresh]);

  return useCallback(() => {
    if (!visibleRef.current) {
      staleRef.current = true;
      return;
    }
    staleRef.current = false;
    refresh();
  }, [refresh]);
}
