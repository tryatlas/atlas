// What the project file tree does to the disk, and what has to follow each
// change elsewhere in the app: re-read the folders it touched, re-point the
// recent-files queue, and re-point or close any tab showing a file that moved
// or went away. Kept out of the component so every entry point (menu,
// keyboard, drag) runs the same sequence.

import { toast } from "sonner";
import { activeProjectId } from "@/features/projects/lib/active-project";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { canonicalFilePath, openFile, openFileAs } from "@/lib/open-file";
import { requestCloseTab } from "@/features/chat/lib/close-tab";
import { fileDraftOf, releaseFileBuffer } from "@/features/editor/lib/dirty-close";
import { useEditorStore } from "@/features/editor/stores/editor-store";
import { fileTabPath } from "@/lib/tab-registry";
import {
  copyPath,
  createDirectory,
  createFile,
  deletePath,
  duplicatePath,
  readDirectory,
  renamePath,
  renameRecentFile,
} from "./fs-api";
import type { ProjectTreeModel } from "./project-tree-model";
import { basename } from "@/lib/paths";
import { isUnderRoot, normalisePath } from "@/lib/file-links";

const dirOf = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf("/")));
const baseOf = basename;

/** Absolute → root-relative, `""` for the root itself; null when outside. */
export function relativeTo(root: string, abs: string): string | null {
  const r = normalisePath(root);
  const p = normalisePath(abs);
  if (!p || !r || !isUnderRoot(p, r)) return null;
  return p === r ? "" : p.slice(r.endsWith("/") ? r.length : r.length + 1);
}

export function absoluteOf(root: string, rel: string): string {
  return rel ? `${root}/${rel}` : root;
}

/**
 * Why `name` cannot be a file or folder name, or null when it can. Refuses
 * what would not name one entry in the folder it was typed in: empty, `.`,
 * `..`, a path separator of either platform, or a control character.
 */
export function entryNameError(name: string): string | null {
  if (name.trim() === "") return "A name is required.";
  if (name === "." || name === "..") return `"${name}" is not a valid name.`;
  if (/[/\\]/.test(name)) return "A name can't contain / or \\.";
  // oxlint-disable-next-line no-control-regex -- refusing control characters is the point
  if (/[\u0000-\u001f\u007f]/.test(name)) return "A name can't contain control characters.";
  return null;
}

/**
 * Why `src` cannot be moved or copied into `destDir`, or null. A folder into
 * itself or anything below it would never finish copying (each pass copies
 * the copy) and cannot be moved at all.
 */
export function intoItselfError(src: string, destDir: string): string | null {
  return isUnderRoot(destDir, src) ? "Can't put a folder inside itself" : null;
}

/**
 * `name`, or `name copy`, `name copy 2`… — the first that `taken` does not
 * hold, keeping the extension last, as Finder does.
 */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? `${stem} copy${ext}` : `${stem} copy ${n}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem} copy ${Date.now()}${ext}`;
}

/** A destination for `src` inside `destDir` that does not overwrite anything. */
async function destinationFor(src: string, destDir: string): Promise<string> {
  let taken: Set<string>;
  try {
    taken = new Set((await readDirectory(destDir, "")).map((e) => baseOf(e.path)));
  } catch {
    taken = new Set();
  }
  return `${destDir}/${freeName(baseOf(src), taken)}`;
}

interface OpenFileTab {
  id: string;
  type: string;
  filePath: string;
  dirty: boolean;
  editing: boolean;
}

/** The open file tabs showing `path` or a file under it, with their paths. */
function filesTabsAt(path: string): OpenFileTab[] {
  return useLayoutStore.getState().tabs.flatMap((t) => {
    const filePath = fileTabPath(t);
    return filePath !== null && (filePath === path || filePath.startsWith(`${path}/`))
      ? [{ id: t.id, type: t.type, filePath, dirty: !!t.dirty, editing: t.data.editing === true }]
      : [];
  });
}

export class ProjectFileOps {
  constructor(private readonly model: ProjectTreeModel) {}

  private get root() {
    return this.model.root;
  }

  /** Re-read the folders (absolute) a change touched. */
  private touched(...dirs: string[]) {
    const rels = dirs.map((d) => relativeTo(this.root, d)).filter((d): d is string => d !== null);
    return this.model.refresh(rels);
  }

  private fail(error: unknown) {
    toast.error(error instanceof Error ? error.message : String(error));
  }

  /** `name` inside `parentDir`, refused when it is not a plain name or would
   *  land outside the project. */
  private childPath(parentDir: string, name: string): string | null {
    const invalid = entryNameError(name);
    const path = `${parentDir}/${name}`;
    if (invalid || relativeTo(this.root, path) === null || relativeTo(this.root, path) === "") {
      toast.error(invalid ?? "That would land outside the project.");
      return null;
    }
    return path;
  }

  async createFile(parentDir: string, name: string): Promise<void> {
    const path = this.childPath(parentDir, name);
    if (!path) return;
    try {
      await createFile(path);
      await this.touched(parentDir);
      // A new, empty file is made to be written in: open it for editing.
      void openFile(path, { edit: true });
    } catch (e) {
      this.fail(e);
    }
  }

  async createFolder(parentDir: string, name: string): Promise<void> {
    const path = this.childPath(parentDir, name);
    if (!path) return;
    try {
      await createDirectory(path);
      await this.touched(parentDir);
    } catch (e) {
      this.fail(e);
    }
  }

  /** Rename in place. Answers the new path, or null when nothing happened. */
  async rename(oldPath: string, name: string): Promise<string | null> {
    if (`${dirOf(oldPath)}/${name}` === oldPath) return null;
    const newPath = this.childPath(dirOf(oldPath), name);
    if (!newPath) return null;
    try {
      await renamePath(oldPath, newPath);
      this.followMove(oldPath, newPath);
      await this.touched(dirOf(oldPath));
      return newPath;
    } catch (e) {
      this.fail(e);
      return null;
    }
  }

  /** Move `src` into `destDir`, never over an existing name. */
  async move(src: string, destDir: string): Promise<void> {
    const parent = dirOf(src);
    if (parent === destDir) return;
    const into = intoItselfError(src, destDir);
    if (into) {
      toast.error(into);
      return;
    }
    try {
      const dest = await destinationFor(src, destDir);
      await renamePath(src, dest);
      this.followMove(src, dest);
      await this.touched(parent, destDir);
    } catch (e) {
      this.fail(e);
    }
  }

  async copyInto(sources: readonly string[], destDir: string): Promise<void> {
    let copied = 0;
    for (const src of sources) {
      const into = intoItselfError(src, destDir);
      if (into) {
        toast.error(into);
        continue;
      }
      try {
        await copyPath(src, await destinationFor(src, destDir));
        copied++;
      } catch (e) {
        toast.error(`Couldn't copy ${baseOf(src)}: ${String(e)}`);
      }
    }
    if (copied > 0) await this.touched(destDir);
  }

  async paste(clipboard: { paths: string[]; isCut: boolean }, destDir: string): Promise<void> {
    if (!clipboard.isCut) return this.copyInto(clipboard.paths, destDir);
    for (const src of clipboard.paths) await this.move(src, destDir);
  }

  async duplicate(path: string): Promise<void> {
    try {
      await duplicatePath(path);
      await this.touched(dirOf(path));
    } catch (e) {
      this.fail(e);
    }
  }

  async delete(paths: readonly string[]): Promise<void> {
    const parents = new Set<string>();
    for (const path of paths) {
      try {
        await deletePath(path);
        parents.add(dirOf(path));
        // Through the guarded close: a tab with unsaved edits asks (Save
        // writes them back to the path), a clean one closes and frees its
        // buffer.
        for (const tab of filesTabsAt(path)) requestCloseTab(tab.id);
      } catch (e) {
        this.fail(e);
        break;
      }
    }
    await this.touched(...parents);
  }

  /**
   * A file or folder moved: keep the mention picker's recents and every open
   * tab under it pointing at where it is now. Reopening (rather than editing
   * the tab) re-classifies, so a changed extension lands in the right viewer.
   */
  private followMove(from: string, to: string) {
    void renameRecentFile(from, to, activeProjectId()).catch(() => {});
    const stale = filesTabsAt(from);
    if (stale.length === 0) return;
    const layout = useLayoutStore.getState().actions;
    const editor = useEditorStore.getState().actions;
    for (const tab of stale) {
      const dest = to + tab.filePath.slice(from.length);
      if (tab.type === "editor" && tab.dirty) {
        // Unsaved edits move with the file: the buffer is re-keyed carrying
        // the live text, and the new tab opens on it, still unsaved.
        const draft = fileDraftOf(tab.id);
        editor.moveBuffer(tab.filePath, canonicalFilePath(dest), draft);
        layout.closeTab(tab.id);
        const id = openFileAs(dest, "text", { edit: tab.editing });
        useLayoutStore.getState().actions.setTabDirty(id, draft !== undefined);
        continue;
      }
      layout.closeTab(tab.id);
      releaseFileBuffer(tab.filePath, useLayoutStore.getState().tabs);
      void openFile(dest);
    }
  }
}
