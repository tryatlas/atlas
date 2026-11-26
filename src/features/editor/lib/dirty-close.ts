/**
 * Closing a file tab with unsaved edits. The edits live in the tab's editor
 * and its save session, both of which go when the tab unmounts, so a close
 * asks first: Save, Don't save, or Cancel. Escape and a click outside cancel,
 * and Save that fails keeps the tab open.
 *
 * Each open file tab registers how to save itself here (`registerFileSaver`),
 * by tab id, so the close path — which runs outside the tab's React tree —
 * can ask it to write without the panel mirroring its document anywhere.
 *
 * Once the last tab showing a file has closed, its buffer goes too: a cached
 * buffer left `dirty: true` would mark the next tab for that file unsaved
 * before it had been touched, and `ui_close` would refuse it for ever.
 */

import { toast } from "sonner";
import { choose } from "@/lib/confirm";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useEditorStore } from "../stores/editor-store";

/** Writes the tab's document; resolves whether it is now on disk. */
type FileSaver = () => Promise<boolean>;

const savers = new Map<string, FileSaver>();
/** The tab's live document text, for carrying unsaved edits across a move. */
type FileDraft = () => string | undefined;
const drafts = new Map<string, FileDraft>();

/** Record how `tabId` saves; returns the matching unregister. An unregister
 *  only removes the saver it registered, so a stale cleanup cannot drop the
 *  one a remounted panel put there since. */
export function registerFileSaver(tabId: string, save: FileSaver): () => void {
  savers.set(tabId, save);
  return () => {
    if (savers.get(tabId) === save) savers.delete(tabId);
  };
}

/** Record how to read `tabId`'s live text; returns the matching unregister. */
export function registerFileDraft(tabId: string, read: FileDraft): () => void {
  drafts.set(tabId, read);
  return () => {
    if (drafts.get(tabId) === read) drafts.delete(tabId);
  };
}

/** The unsaved text of `tabId`'s document, or undefined when no editor is up. */
export function fileDraftOf(tabId: string): string | undefined {
  return drafts.get(tabId)?.();
}

interface FileTabLike {
  id: string;
  title: string;
  dirty?: boolean;
  data: Record<string, unknown>;
}

export function filePathOf(tab: { data: Record<string, unknown> }): string | undefined {
  return typeof tab.data.filePath === "string" ? tab.data.filePath : undefined;
}

/**
 * Whether `tab` may close now, asking about unsaved edits first. A clean tab
 * answers at once. "Save" writes through the tab's own panel and closes only
 * when the write landed; "Don't save" closes and drops the edits.
 */
export async function confirmCloseFileTab(tab: FileTabLike): Promise<boolean> {
  if (!tab.dirty) return true;
  const path = filePathOf(tab);
  const name = path?.split(/[\\/]/).pop() || tab.title;
  const choice = await choose({
    title: `Save changes to ${name}?`,
    body: "Your changes will be lost if you don't save them.",
    confirmLabel: "Save",
    alternateLabel: "Don't save",
    alternateDestructive: true,
  });
  if (choice === "cancel") return false;
  if (choice === "alternate") return true;
  const save = savers.get(tab.id);
  return save ? save() : false;
}

/**
 * After a file tab closed: drop the file's buffer when no remaining tab shows
 * it. `remaining` is every tab still open.
 */
export function releaseFileBuffer(
  path: string | undefined,
  remaining: ReadonlyArray<{ data: Record<string, unknown> }>,
): void {
  if (!path) return;
  if (remaining.some((t) => filePathOf(t) === path)) return;
  useEditorStore.getState().actions.closeBuffer(path);
}

/**
 * The file tabs with unsaved edits. With `projectId`, that project's tabs
 * only (the live mirror when it is the project on screen, its committed view
 * otherwise); without, every mounted project's. Their editors stay mounted
 * while the project is in the hot set, so each one's saver is registered.
 */
export function dirtyFileTabs(projectId?: string | null): FileTabLike[] {
  const layout = useLayoutStore.getState();
  const lists: ReadonlyArray<FileTabLike>[] = [];
  if (projectId === undefined) {
    lists.push(layout.tabs);
    for (const [id, view] of Object.entries(layout.viewsByWs)) {
      if (id !== layout.currentViewWsId) lists.push(view.tabs);
    }
  } else if (projectId !== null) {
    lists.push(
      projectId === layout.currentViewWsId
        ? layout.tabs
        : (layout.viewsByWs[projectId]?.tabs ?? []),
    );
  }
  const seen = new Set<string>();
  const dirty: FileTabLike[] = [];
  for (const tab of lists.flat()) {
    if (seen.has(tab.id)) continue;
    seen.add(tab.id);
    if ((tab as { type?: string }).type === "editor" && tab.dirty) dirty.push(tab);
  }
  return dirty;
}

/**
 * Before something closes many file tabs at once (quit, closing a project,
 * switching organization): ask about the unsaved ones. "Save" writes every
 * one and goes ahead only when all landed; "Don't save" goes ahead and drops
 * them; Cancel stops. Resolves whether the caller may proceed.
 */
export async function confirmCloseFileTabs(
  tabs: ReadonlyArray<FileTabLike>,
  actionLabel: string,
): Promise<boolean> {
  if (tabs.length === 0) return true;
  const names = tabs.map((tab) => filePathOf(tab)?.split(/[\\/]/).pop() || tab.title);
  const one = tabs.length === 1;
  const choice = await choose({
    title: one ? `Save changes to ${names[0]}?` : `Save changes to ${tabs.length} files?`,
    body: `${actionLabel} closes ${one ? "it" : `${names.join(", ")}`}. Your changes will be lost if you don't save them.`,
    confirmLabel: one ? "Save" : "Save all",
    alternateLabel: "Don't save",
    alternateDestructive: true,
  });
  if (choice === "cancel") return false;
  if (choice === "alternate") return true;
  const failed: string[] = [];
  for (const [i, tab] of tabs.entries()) {
    const save = savers.get(tab.id);
    const ok = save ? await save().catch(() => false) : false;
    if (!ok) failed.push(names[i]);
  }
  if (failed.length > 0) {
    toast.error(`Couldn't save ${failed.join(", ")}. Nothing was closed.`);
    return false;
  }
  return true;
}

/**
 * After a project's tabs went (closed, or torn down with its organization):
 * drop the buffer of each of `paths` that no open tab in any project still
 * shows, so a "Don't save" there cannot mark the file unsaved on next open.
 */
export function releaseOrphanedFileBuffers(paths: ReadonlyArray<string>): void {
  const layout = useLayoutStore.getState();
  const remaining = [layout.tabs, ...Object.values(layout.viewsByWs).map((v) => v.tabs)].flat();
  for (const path of new Set(paths)) releaseFileBuffer(path, remaining);
}
