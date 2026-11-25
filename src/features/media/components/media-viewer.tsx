import { readFileMtimeMs } from "@/features/editor/lib/editor-fs-api";
import { useEffect, useState } from "react";
import { classifyFile, type FileKind } from "@/lib/file-types";
import { MediaViewerView } from "./views/media-viewer-view";
import { onWindowEvent } from "@/lib/window-events";
import { useLocalMedia } from "../lib/use-local-media";

interface MediaViewerProps {
  filePath: string;
}

/**
 * Image / video / audio tab handler. Grants the selected file before loading
 * it, and owns the seekable native HTTP stream used by Linux audio/video.
 *
 * The asset URL is keyed only by path, so the webview serves a stale image
 * after a file at the same path is deleted and recreated. We append the file's
 * mtime as a cache-buster and refresh it when the window regains focus (the
 * usual moment a replacement was just saved from another app).
 */
export function MediaViewer({ filePath }: MediaViewerProps) {
  const kind: FileKind = classifyFile(filePath);
  const name = filePath.split(/[/\\]/).pop() ?? filePath;

  const [mtime, setMtime] = useState(0);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void readFileMtimeMs(filePath)
        .then((v) => {
          if (alive) setMtime(v);
        })
        .catch(() => {});
    };
    refresh();
    const off = onWindowEvent("atlas:window-active", refresh);
    return () => {
      alive = false;
      off();
    };
  }, [filePath]);
  const { url, error } = useLocalMedia(filePath, kind, mtime + retry);

  return (
    <MediaViewerView
      filePath={filePath}
      name={name}
      kind={kind}
      src={url}
      error={error}
      onRetry={() => setRetry((n) => n + 1)}
    />
  );
}
