import { useCallback, useEffect, useRef, useState } from "react";
import { captureBinding, captureHealth } from "../lib/capture-api";
import type { Binding, CaptureHealth } from "../types";
import { activeProjectId } from "@/features/projects/lib/active-project";

interface Loaded {
  /** The project the answer is for. */
  path: string;
  binding: Binding | null;
  health: CaptureHealth | null;
}

/**
 * A project's capture binding and health, for the titlebar's capture dot.
 *
 * Every answer is tagged with the project it was asked for, so on a project
 * switch the previous project's dot never shows under the new name: until
 * the new project's answer lands the dot is absent, and an answer that
 * resolves after a newer read (or after the switch) is dropped.
 */
export function useProjectCaptureState(path: string | undefined): {
  binding: Binding | null;
  health: CaptureHealth | null;
  reload: () => void;
} {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const seq = useRef(0);

  const reload = useCallback(() => {
    const request = ++seq.current;
    if (!path) {
      setLoaded(null);
      return;
    }
    const current = () => request === seq.current;
    void Promise.all([
      captureBinding(path).catch(() => null),
      captureHealth(path, activeProjectId()).catch(() => null),
    ]).then(([binding, health]) => {
      if (current()) setLoaded({ path, binding, health });
    });
  }, [path]);

  useEffect(() => {
    reload();
    return () => {
      // Unmount or project switch: whatever is in flight is for a project
      // no longer shown.
      seq.current += 1;
    };
  }, [reload]);

  const mine = loaded && loaded.path === path ? loaded : null;
  return { binding: mine?.binding ?? null, health: mine?.health ?? null, reload };
}
