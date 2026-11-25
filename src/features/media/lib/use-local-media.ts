import { useEffect, useState } from "react";
import { openLocalMedia, type LocalMedia } from "./media-api";

/** Own the file's native lease for precisely this mounted path/revision. */
export function useLocalMedia(path: string | null, kind: string, revision = 0) {
  const [state, setState] = useState<{
    path: string | null;
    kind: string;
    revision: number;
    url: string | null;
    error: string | null;
  }>({
    path: null,
    kind: "",
    revision: 0,
    url: null,
    error: null,
  });
  useEffect(() => {
    if (!path) return;
    let alive = true;
    let lease: LocalMedia | null = null;
    void openLocalMedia(path, kind)
      .then((opened) => {
        if (!alive) {
          void opened.close().catch(() => {});
          return;
        }
        lease = opened;
        const separator = opened.url.includes("?") ? "&" : "?";
        setState({
          path,
          kind,
          revision,
          url: `${opened.url}${separator}v=${revision}`,
          error: null,
        });
      })
      .catch((error: unknown) => {
        if (alive) setState({ path, kind, revision, url: null, error: String(error) });
      });
    return () => {
      alive = false;
      if (lease) void lease.close().catch(() => {});
    };
  }, [path, kind, revision]);
  return state.path === path && state.kind === kind && state.revision === revision
    ? state
    : { url: null, error: null };
}
