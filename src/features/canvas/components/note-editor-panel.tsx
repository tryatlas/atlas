import { useCallback, useEffect, useRef, useState } from "react";
import { X, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCanvasStore } from "../stores/canvas-store";
import {
  TiptapEditor,
  type TiptapEditorHandle,
} from "@/features/editor-notion/components/tiptap-editor";
import { IconPicker } from "@/features/knowledge/components/icon-picker";
import { ensureKnowledgeMentionCache } from "@/features/chat/lib/mentions";
import { HintGroup, HintItem } from "@tryatlas/design";
import { deleteDocument, documentKey } from "@/features/editor-notion/lib/document-saves";
import { dropCachedDoc } from "@/features/editor-notion/lib/blocks-cache";
import { toast } from "sonner";

interface NoteEditorPanelProps {
  noteId: string;
  projectPath: string;
  onClose: () => void;
  onJumpToNode?: (id: string) => void;
}

/**
 * Immersive slide-in editor for a canvas note — mirrors the notification panel
 * (right-in slide + backdrop blur + scrim). Reuses the KB `TiptapEditor` for the
 * body (so `@`-mentions to KB notes / repos work) and the KB `IconPicker` for the
 * emoji. Save follows the KB lesson: gate on the editor's live `isDirty()` and
 * flush on close / blur / unmount — never on a store-content baseline.
 */
export function NoteEditorPanel({ noteId, projectPath, onClose }: NoteEditorPanelProps) {
  const nodes = useCanvasStore((s) => s.nodes);
  const pageId = useCanvasStore((s) => s.activePageId);
  const { updateNote, deleteNote, saveNoteBody, flush } = useCanvasStore((s) => s.actions);
  const key = documentKey(projectPath, "canvas-note", pageId ?? "", noteId);
  const note = nodes.find((n) => n.id === noteId) ?? null;

  const editorRef = useRef<TiptapEditorHandle>(null);
  const [iconAnchor, setIconAnchor] = useState<DOMRect | null>(null);

  // Warm the knowledge mention cache so the @-picker resolves KB notes/repos.
  useEffect(() => {
    void ensureKnowledgeMentionCache(projectPath);
  }, [projectPath]);

  const flushBody = useCallback(async () => {
    try {
      await editorRef.current?.save();
      return true;
    } catch (error) {
      toast.error(`Note could not be saved: ${String(error)}`);
      return false;
    }
  }, []);

  useEffect(() => {
    const onBlur = () => void flushBody();
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [flushBody]);

  const close = useCallback(() => {
    void flushBody().then((saved) => {
      if (saved) onClose();
    });
  }, [flushBody, onClose]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [close]);

  // If the note was deleted out from under us, close.
  useEffect(() => {
    if (!note) onClose();
  }, [note, onClose]);

  if (!note) return null;

  return (
    <>
      {/* Scrim */}
      <div
        className="fixed inset-0 z-overlay scrim-soft animate-fade-in"
        onClick={close}
        aria-hidden
      />
      {/* Panel */}
      <aside
        className={cn(
          "fixed right-0 top-0 bottom-0 z-modal w-[400px] flex flex-col",
          "border-l border-border",
          "bg-card/60 backdrop-blur-2xl backdrop-saturate-150",
          "shadow-md animate-slide-in-right",
        )}
      >
        {/* Header — matches the tab-bar height (29px) so the two rows align. */}
        <HintGroup>
          <div className="flex items-center gap-1.5 px-2 h-[29px] border-b border-border shrink-0">
            <HintItem label="Change icon">
              <button
                type="button"
                onClick={(e) => setIconAnchor(e.currentTarget.getBoundingClientRect())}
                className="flex h-5 w-5 items-center justify-center rounded-md bg-element-hover hover:bg-element-active transition-colors cursor-pointer shrink-0"
              >
                {note.icon ? (
                  <span className="text-sm leading-none">{note.icon}</span>
                ) : (
                  <span className="text-xs leading-none text-muted-foreground">＋</span>
                )}
              </button>
            </HintItem>
            <input
              value={note.title}
              onChange={(e) => updateNote(noteId, { title: e.target.value })}
              placeholder="Untitled"
              className="flex-1 min-w-0 bg-transparent outline-none text-sm font-semibold text-foreground placeholder:text-muted-foreground"
            />
            <HintItem label="Delete note">
              <button
                type="button"
                onClick={() => {
                  void deleteDocument(key, async () => {
                    deleteNote(noteId);
                  })
                    .then(async () => {
                      dropCachedDoc(key);
                      await flush(projectPath);
                      onClose();
                    })
                    .catch((error) => toast.error(`Note could not be deleted: ${String(error)}`));
                }}
                className="p-1 rounded hover:bg-element-hover text-muted-foreground hover:text-error cursor-pointer transition-colors"
              >
                <Trash2 size={12} />
              </button>
            </HintItem>
            <HintItem label="Close">
              <button
                type="button"
                onClick={close}
                className="p-1 rounded hover:bg-element-hover text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
              >
                <X size={12} />
              </button>
            </HintItem>
          </div>
        </HintGroup>

        {/* Body — the editor fills the full width + height with comfortable
            padding. `!bg-transparent` drops the editor's own opaque default so it
            shows the panel surface (matches the sidebar background). */}
        <div className="flex-1 min-h-0 overflow-y-auto hide-scrollbar px-5">
          <TiptapEditor
            ref={editorRef}
            documentId={key}
            projectPath={projectPath}
            onSave={(markdown) => {
              if (!pageId) return Promise.reject(new Error("No canvas page is selected."));
              return saveNoteBody(projectPath, pageId, noteId, markdown);
            }}
            initialMarkdown={note.body}
            label={note.title || "Untitled note"}
            placeholder="Write… use @ to reference a note or repo"
            className="min-h-full !bg-transparent"
          />
        </div>
      </aside>

      {iconAnchor && (
        <IconPicker
          value={note.icon ?? null}
          anchorRect={iconAnchor}
          onPick={(v) => updateNote(noteId, { icon: v ?? "" })}
          onClose={() => setIconAnchor(null)}
        />
      )}
    </>
  );
}
