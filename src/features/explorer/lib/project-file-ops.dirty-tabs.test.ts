// @vitest-environment happy-dom
//
// D4: renaming, moving or deleting a file in the explorer closed its tab with
// the bare `closeTab`: unsaved edits went without a prompt, and the dirty
// buffer leaked. A move now carries the edits to the new path, still unsaved;
// a delete asks, as closing the tab by hand does.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
vi.mock("sonner", () => ({ toast: Object.assign(() => {}, { error: () => {} }) }));
vi.mock("@/features/projects/lib/active-project", () => ({ activeProjectId: () => "p" }));
vi.mock("./fs-api", () => ({
  renamePath: vi.fn(async () => {}),
  deletePath: vi.fn(async () => {}),
  renameRecentFile: vi.fn(async () => {}),
  readDirectory: vi.fn(async () => []),
  copyPath: vi.fn(async () => {}),
  createDirectory: vi.fn(async () => {}),
  createFile: vi.fn(async () => {}),
  duplicatePath: vi.fn(async () => ""),
}));

import { useConfirmStore } from "@/lib/confirm";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useEditorStore } from "@/features/editor/stores/editor-store";
import { registerFileDraft } from "@/features/editor/lib/dirty-close";
import { ProjectFileOps } from "./project-file-ops";
import type { ProjectTreeModel } from "./project-tree-model";

const OLD = "/p/src/a.ts";
const NEW = "/p/src/b.ts";
const tabOf = (path: string) =>
  useLayoutStore.getState().tabs.find((t) => t.id === `editor:${path}`);

function seed(dirty: boolean) {
  useConfirmStore.setState({ pending: null });
  useLayoutStore.setState({
    tabs: [
      {
        id: `editor:${OLD}`,
        type: "editor",
        title: "a.ts",
        closable: true,
        dirty,
        data: { filePath: OLD, fileKind: "text", editing: true },
      },
    ] as never,
    activeTabId: `editor:${OLD}`,
  });
  useEditorStore.setState({
    buffers: { [OLD]: { path: OLD, originalContent: "disk", dirty } as never },
    pendingReveals: {},
  });
}

const ops = () =>
  new ProjectFileOps({ root: "/p", refresh: async () => {} } as unknown as ProjectTreeModel);

beforeEach(() => vi.clearAllMocks());

describe("explorer changes to a file with unsaved edits", () => {
  it("a rename carries the unsaved text to the new path, still unsaved", async () => {
    seed(true);
    const off = registerFileDraft(`editor:${OLD}`, () => "edited");
    await ops().rename(OLD, "b.ts");
    off();

    expect(tabOf(OLD)).toBeUndefined();
    expect(tabOf(NEW)).toMatchObject({ dirty: true, data: { filePath: NEW, editing: true } });
    expect(useEditorStore.getState().buffers[OLD]).toBeUndefined();
    expect(useEditorStore.getState().buffers[NEW]).toMatchObject({
      originalContent: "disk",
      draft: "edited",
      dirty: true,
    });
    expect(useConfirmStore.getState().pending).toBeNull();
  });

  it("a move of the folder above it does the same", async () => {
    seed(true);
    const off = registerFileDraft(`editor:${OLD}`, () => "edited");
    await ops().move("/p/src", "/p/lib");
    off();
    expect(useEditorStore.getState().buffers["/p/lib/src/a.ts"]).toMatchObject({
      draft: "edited",
    });
  });

  it("a delete asks before dropping the edits, and Cancel keeps the tab", async () => {
    seed(true);
    await ops().delete([OLD]);
    await vi.waitFor(() => expect(useConfirmStore.getState().pending).not.toBeNull());
    useConfirmStore.getState().actions.settle("cancel");
    await new Promise((r) => setTimeout(r, 0));
    expect(tabOf(OLD)).toBeDefined();
    expect(useEditorStore.getState().buffers[OLD]).toBeDefined();
  });

  it("a delete closes a clean tab at once and frees its buffer", async () => {
    seed(false);
    await ops().delete([OLD]);
    expect(tabOf(OLD)).toBeUndefined();
    expect(useEditorStore.getState().buffers[OLD]).toBeUndefined();
    expect(useConfirmStore.getState().pending).toBeNull();
  });
});
