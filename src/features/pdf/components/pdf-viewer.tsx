import { useCallback, useEffect, useState } from "react";
import { useScopedHotkeys } from "@/features/keybindings/lib/use-scoped-hotkeys";
import { useActionShortcut } from "@/features/keybindings/lib/use-action-shortcut";
import { readFileBase64 } from "@/features/editor/lib/editor-fs-api";
import { toast } from "sonner";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { usePdfAnnotationStore, pdfDocumentKey } from "../stores/pdf-annotation-store";
import { projectPathForTab } from "@/features/chat/lib/tab-project";
import { useAppStore } from "@/features/app/stores/app-store";
import type { PdfAnnotation } from "../lib/pdf-annotations";
import { PdfViewerView } from "./views/pdf-viewer-view";

interface PdfViewerProps {
  filePath: string;
  tabId?: string;
}

const NO_ANNOTATIONS: PdfAnnotation[] = [];

export function PdfViewer({ filePath, tabId }: PdfViewerProps) {
  const activeProjectPath = useAppStore((state) => state.currentProject?.path ?? "");
  const projectPath = (tabId ? projectPathForTab(tabId) : null) ?? activeProjectPath;
  const key = pdfDocumentKey(projectPath, filePath);
  const [fileData, setFileData] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1); // 1 = fit-to-width
  const [saving, setSaving] = useState(false);

  const dirtyMap = usePdfAnnotationStore((s) => s.dirty);
  const tool = usePdfAnnotationStore((s) => s.tool);
  const color = usePdfAnnotationStore((s) => s.color);
  const selectedId = usePdfAnnotationStore((s) => s.selectedId);
  const annotations = usePdfAnnotationStore((s) => s.byPath[key]) ?? NO_ANNOTATIONS;
  const {
    load,
    save: saveAnnotations,
    setTool,
    setColor,
    add,
    remove,
    select,
    updateNoteText,
  } = usePdfAnnotationStore((s) => s.actions);
  const saveShortcut = useActionShortcut("pdf.save");
  const isDirty = !!dirtyMap[key];

  const fileName = filePath.split("/").pop() ?? filePath;

  // Load PDF bytes through our own Rust command (works for `.atlas/` paths the
  // asset protocol would 403; PDF.js also dislikes blob URLs in WKWebView).
  useEffect(() => {
    let cancelled = false;
    setFileData(null);
    setError(null);
    void readFileBase64(filePath)
      .then((b64) => {
        if (cancelled) return;
        setFileData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      })
      .catch((e) => {
        if (!cancelled) setError(`Failed to read PDF: ${e}`);
      });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // Load persisted (editable) annotations for this PDF.
  useEffect(() => {
    void load(filePath, projectPath).catch((e) =>
      setError(`Annotations could not be loaded: ${String(e)}`),
    );
  }, [filePath, projectPath, load]);

  // Reflect unsaved annotations in the tab's dirty dot.
  useEffect(() => {
    if (tabId) useLayoutStore.getState().actions.setTabDirty(tabId, isDirty);
  }, [tabId, isDirty]);

  // Cmd/Ctrl+S — flush the editable annotations to disk now. Annotations also
  // autosave (debounced) on every edit, so this is mostly reassurance. They
  // stay editable/erasable across sessions (NOT flattened into the PDF), which
  // is why the eraser keeps working on previously-saved annotations.
  const save = useCallback(async () => {
    setSaving(true);
    try {
      await saveAnnotations(filePath, projectPath);
      toast.success("Annotations saved");
    } catch (e) {
      toast.error(`Annotations could not be saved: ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }, [filePath, projectPath, saveAnnotations]);

  useScopedHotkeys({
    tabId: tabId ?? `pdf:${filePath}`,
    handlers: {
      "pdf.save": () => {
        if (!saving) void save();
      },
    },
  });

  return (
    <PdfViewerView
      fileName={fileName}
      fileData={fileData}
      error={error}
      zoom={zoom}
      dirty={isDirty || saving}
      saveShortcut={saveShortcut?.label ?? null}
      tool={tool}
      color={color}
      annotations={annotations}
      selectedId={selectedId}
      onLoadError={setError}
      onZoomIn={() => setZoom((z) => Math.min(3, z + 0.2))}
      onZoomOut={() => setZoom((z) => Math.max(0.5, z - 0.2))}
      onToolChange={setTool}
      onColorChange={setColor}
      onAdd={(a) => add(filePath, a, projectPath)}
      onRemove={(id) => remove(filePath, id, projectPath)}
      onSelect={select}
      onNoteTextChange={(id, text) => updateNoteText(filePath, id, text, projectPath)}
    />
  );
}
