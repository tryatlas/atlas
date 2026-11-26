import { useEffect, useRef } from "react";
import { onGitChanged } from "@/features/git/lib/git-watch-api";

/** Coalescing window for `atlas:git-changed` bursts (a commit, a checkout
 *  and a rebase each fire several). */
export const GIT_REFRESH_DEBOUNCE_MS = 250;

function sameRoot(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");
}

/**
 * Run `refresh` (a file tab's change bars and blame) when git reports a
 * change under `projectPath`.
 *
 * Every open file tab stays mounted, and each refresh is a `git diff` (plus
 * `git blame`) process, so this is careful about when it spends one:
 * - events for another project's repository are ignored;
 * - a burst of events is one refresh, after `GIT_REFRESH_DEBOUNCE_MS` of quiet;
 * - a tab nobody can see only notes that it is stale, and refreshes once
 *   when it is shown again.
 */
export function useGitChangedRefresh(
  projectPath: string,
  visible: boolean,
  refresh: () => void,
): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const stale = useRef(false);

  useEffect(() => {
    if (!projectPath) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const un = onGitChanged((payload) => {
      if (!payload?.project || !sameRoot(payload.project, projectPath)) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (visibleRef.current) refreshRef.current();
        else stale.current = true;
      }, GIT_REFRESH_DEBOUNCE_MS);
    });
    return () => {
      clearTimeout(timer);
      void un.then((u) => u());
    };
  }, [projectPath]);

  useEffect(() => {
    if (!visible || !stale.current) return;
    stale.current = false;
    refreshRef.current();
  }, [visible]);
}
