import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { RevealTarget } from "../lib/reveal";

/**
 * What Atlas knows about an open file besides its text: the contents as last
 * read or saved, and whether the document differs. The live document is the
 * file view's editor's (docs/architecture.md); nothing here changes per
 * keystroke — `dirty` flips only when the file starts or stops differing.
 */
interface Buffer {
  path: string;
  /** The contents on disk as of the last read, reload or save. */
  originalContent: string;
  dirty: boolean;
  /** Disk mtime (unix ms) at the last read/save — the freshness gate for
   *  external-change revalidation. 0 until first known. */
  diskMtimeMs: number;
  /** Set when the file changed on disk while this buffer has unsaved edits, so
   *  the editor can offer a manual reload instead of clobbering the user's work. */
  externallyChanged: boolean;
  /** External replacement, shared by every mounted view of this file. */
  documentVersion?: number;
  /** Unsaved text carried over from another path when the file was renamed
   *  or moved with edits pending (`moveBuffer`). The next view of this file
   *  opens on it instead of `originalContent`; a save, a reload, or the edits
   *  going back to the disk's text drops it. */
  draft?: string;
}

/** A reveal waiting for its path's editor view. The nonce makes a repeated
 *  reveal of the same line a new value, so the panel applies it again. */
export interface PendingReveal extends RevealTarget {
  nonce: number;
}

interface EditorState {
  buffers: Record<string, Buffer>;
  activeBufferPath: string | null;
  /** Reveals asked for by path, applied by that path's editor panel once its
   *  view exists — a new tab, a hidden one and a visible one alike. The
   *  knowledge store's `pendingOpenId` is the same pattern. */
  pendingReveals: Record<string, PendingReveal>;
}

interface EditorActions {
  actions: {
    openBuffer: (path: string, content: string, mtimeMs?: number) => void;
    setDirty: (path: string, dirty: boolean) => void;
    markSaved: (path: string, content: string, mtimeMs?: number) => void;
    /** Overwrite a buffer's content from disk (external change, buffer clean). */
    reloadBuffer: (path: string, content: string, mtimeMs: number) => void;
    /** Flag a dirty buffer whose file changed on disk (no content overwrite). */
    markExternallyChanged: (path: string, mtimeMs: number) => void;
    closeBuffer: (path: string) => void;
    /** The file at `from` now lives at `to` (rename/move on disk): re-key its
     *  buffer, carrying `draft` (the unsaved document) when there is one. */
    moveBuffer: (from: string, to: string, draft?: string) => void;
    setActive: (path: string) => void;
    /** Ask `path`'s editor to move to `target`. */
    requestReveal: (path: string, target: RevealTarget) => void;
    /** The panel applied the reveal carrying `nonce`; a newer one is kept. */
    consumeReveal: (path: string, nonce: number) => void;
  };
}

let revealNonce = 0;

export const useEditorStore = create<EditorState & EditorActions>()(
  immer((set) => ({
    buffers: {},
    activeBufferPath: null,
    pendingReveals: {},
    actions: {
      openBuffer: (path, content, mtimeMs = 0) =>
        set((s) => {
          if (!s.buffers[path]) {
            s.buffers[path] = {
              path,
              originalContent: content,
              dirty: false,
              diskMtimeMs: mtimeMs,
              externallyChanged: false,
            };
          }
          s.activeBufferPath = path;
        }),
      setDirty: (path, dirty) =>
        set((s) => {
          const buf = s.buffers[path];
          if (buf && buf.dirty !== dirty) {
            buf.dirty = dirty;
          }
          // Clean means the document is the disk's text: nothing to carry.
          if (buf && !dirty) delete buf.draft;
        }),
      markSaved: (path, content, mtimeMs) =>
        set((s) => {
          const buf = s.buffers[path];
          if (buf) {
            buf.originalContent = content;
            buf.dirty = false;
            buf.externallyChanged = false;
            delete buf.draft;
            if (mtimeMs !== undefined) buf.diskMtimeMs = mtimeMs;
          }
        }),
      reloadBuffer: (path, content, mtimeMs) =>
        set((s) => {
          const buf = s.buffers[path];
          if (buf) {
            buf.originalContent = content;
            buf.dirty = false;
            buf.externallyChanged = false;
            buf.diskMtimeMs = mtimeMs;
            delete buf.draft;
            buf.documentVersion = (buf.documentVersion ?? 0) + 1;
          }
        }),
      markExternallyChanged: (path, mtimeMs) =>
        set((s) => {
          const buf = s.buffers[path];
          if (buf) {
            buf.externallyChanged = true;
            buf.diskMtimeMs = mtimeMs;
          }
        }),
      closeBuffer: (path) =>
        set((s) => {
          delete s.buffers[path];
          delete s.pendingReveals[path];
          if (s.activeBufferPath === path) {
            const keys = Object.keys(s.buffers);
            s.activeBufferPath = keys.length > 0 ? keys[keys.length - 1] : null;
          }
        }),
      moveBuffer: (from, to, draft) =>
        set((s) => {
          const buf = s.buffers[from];
          if (!buf || from === to) return;
          const carried = draft !== undefined && draft !== buf.originalContent;
          const { draft: _stale, ...rest } = buf;
          delete s.buffers[from];
          delete s.pendingReveals[from];
          s.buffers[to] = { ...rest, path: to, dirty: carried, ...(carried ? { draft } : {}) };
          if (s.activeBufferPath === from) s.activeBufferPath = to;
        }),
      setActive: (path) =>
        set((s) => {
          s.activeBufferPath = path;
        }),
      requestReveal: (path, target) =>
        set((s) => {
          s.pendingReveals[path] = { ...target, nonce: ++revealNonce };
        }),
      consumeReveal: (path, nonce) =>
        set((s) => {
          if (s.pendingReveals[path]?.nonce === nonce) delete s.pendingReveals[path];
        }),
    },
  })),
);
