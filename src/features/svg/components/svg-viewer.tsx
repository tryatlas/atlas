import { useEffect, useMemo, useState } from "react";
import { readFileContent } from "@/features/editor/lib/editor-fs-api";
import { SvgViewerView } from "./views/svg-viewer-view";

interface SvgViewerProps {
  filePath: string;
}

/**
 * `.svg` tab handler. SVG is both renderable AND source, so instead of the code
 * editor we render the image (zoom/pan via `ImageZoomView`, fed a safe
 * asset-protocol URL) and expose a "Copy code" button that copies the raw
 * markup (read as text via `read_file_content`).
 */
export function SvgViewer({ filePath }: SvgViewerProps) {
  const name = filePath.split("/").pop() ?? filePath;
  const [code, setCode] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setCode(null);
    setError(null);
    readFileContent(filePath)
      .then((t) => {
        if (!cancelled) {
          setCode(t);
          if (!t.trim()) setError("This SVG file is empty.");
        }
      })
      .catch((e) => {
        if (!cancelled) setError(`Could not read this SVG: ${String(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath, attempt]);

  // Render from the file's actual markup (not the asset protocol, which can
  // 404/CSP-block and goes stale on rename) by inlining it as a data URL.
  const src = useMemo(
    () => (code ? `data:image/svg+xml,${encodeURIComponent(code)}` : null),
    [code],
  );

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <SvgViewerView
      filePath={filePath}
      name={name}
      src={src}
      copied={copied}
      error={error}
      onRetry={() => setAttempt((value) => value + 1)}
      onCopy={() => void copy()}
    />
  );
}
