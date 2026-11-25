// @vitest-environment happy-dom
//
// Closing a file tab with unsaved edits used to close it outright: the edits
// went with the unmounted editor and the file's buffer stayed `dirty: true`,
// so the next tab on that file read as unsaved before it was touched. These
// pin the prompt (Save / Don't save / Cancel) and the buffer release.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { useConfirmStore } from "@/lib/confirm";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useEditorStore } from "../stores/editor-store";
import { requestCloseTab } from "@/features/chat/lib/close-tab";
import {
  confirmCloseFileTabs,
  dirtyFileTabs,
  registerFileSaver,
  releaseOrphanedFileBuffers,
} from "./dirty-close";

const PATH = "/p/src/App.tsx";
const TAB = `editor:${PATH}`;

function editorTab(id: string, dirty: boolean) {
  return {
    id,
    type: "editor",
    title: "App.tsx",
    closable: true,
    dirty,
    data: { filePath: PATH },
  };
}

function seed(dirty: boolean, extraTabs: ReturnType<typeof editorTab>[] = []) {
  useLayoutStore.setState({
    tabs: [editorTab(TAB, dirty), ...extraTabs] as never,
    activeTabId: TAB,
  });
  useEditorStore.setState({
    buffers: { [PATH]: { path: PATH, originalContent: "x", dirty } as never },
    pendingReveals: {},
  });
}

const tabOpen = (id = TAB) => useLayoutStore.getState().tabs.some((t) => t.id === id);
const buffer = () => useEditorStore.getState().buffers[PATH];

/** Wait for the prompt, then answer it. */
async function answer(choice: "confirm" | "alternate" | "cancel") {
  await vi.waitFor(() => expect(useConfirmStore.getState().pending).not.toBeNull());
  const pending = useConfirmStore.getState().pending!;
  expect(pending).toMatchObject({ confirmLabel: "Save", alternateLabel: "Don't save" });
  useConfirmStore.getState().actions.settle(choice);
  // Let the close continuation run.
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  useConfirmStore.setState({ pending: null });
});

describe("closing a file tab", () => {
  it("closes a clean tab at once, and drops the file's buffer", () => {
    seed(false);
    requestCloseTab(TAB);
    expect(tabOpen()).toBe(false);
    expect(buffer()).toBeUndefined();
    expect(useConfirmStore.getState().pending).toBeNull();
  });

  it("keeps the tab and its edits on Cancel", async () => {
    seed(true);
    requestCloseTab(TAB);
    expect(tabOpen()).toBe(true);
    await answer("cancel");
    expect(tabOpen()).toBe(true);
    expect(buffer()).toBeDefined();
  });

  it("closes without writing on Don't save, and drops the buffer", async () => {
    seed(true);
    const save = vi.fn(async () => true);
    const unregister = registerFileSaver(TAB, save);
    requestCloseTab(TAB);
    await answer("alternate");
    expect(save).not.toHaveBeenCalled();
    expect(tabOpen()).toBe(false);
    expect(buffer()).toBeUndefined();
    unregister();
  });

  it("saves through the tab's panel on Save, closing only when the write landed", async () => {
    seed(true);
    const save = vi.fn(async () => false);
    const unregister = registerFileSaver(TAB, save);
    requestCloseTab(TAB);
    await answer("confirm");
    expect(save).toHaveBeenCalledOnce();
    expect(tabOpen()).toBe(true);

    save.mockResolvedValue(true);
    requestCloseTab(TAB);
    await answer("confirm");
    expect(tabOpen()).toBe(false);
    unregister();
  });

  it("keeps the buffer while another tab still shows the file", () => {
    seed(false, [editorTab("editor:split", false)]);
    requestCloseTab(TAB);
    expect(tabOpen()).toBe(false);
    expect(buffer()).toBeDefined();
  });
});

// D1: quit, project close and org switch close many tabs at once, and used to
// drop every unsaved edit in them without a word.
describe("closing many file tabs at once", () => {
  const other = (dirty: boolean) => ({ ...editorTab("editor:/q/b.ts", dirty), title: "b.ts" });

  function seedProjects(activeDirty: boolean, backgroundDirty: boolean) {
    useLayoutStore.setState({
      tabs: [editorTab(TAB, activeDirty)] as never,
      currentViewWsId: "p",
      viewsByWs: {
        p: { tabs: [editorTab(TAB, false)] },
        q: { tabs: [other(backgroundDirty), { ...other(true), id: "chat:x", type: "chat" }] },
      } as never,
    });
  }

  it("finds the unsaved file tabs of every mounted project, or of one", () => {
    seedProjects(true, true);
    expect(dirtyFileTabs().map((t) => t.id)).toEqual([TAB, "editor:/q/b.ts"]);
    expect(dirtyFileTabs("p").map((t) => t.id)).toEqual([TAB]);
    expect(dirtyFileTabs("q").map((t) => t.id)).toEqual(["editor:/q/b.ts"]);
    seedProjects(false, false);
    expect(dirtyFileTabs()).toEqual([]);
  });

  it("keeps a background project's view in step when its tab saves", () => {
    seedProjects(false, true);
    useLayoutStore.getState().actions.setTabDirty("editor:/q/b.ts", false);
    expect(dirtyFileTabs("q")).toEqual([]);
  });

  it("goes ahead at once when nothing is unsaved", async () => {
    await expect(confirmCloseFileTabs([], "Quitting")).resolves.toBe(true);
    expect(useConfirmStore.getState().pending).toBeNull();
  });

  it("stops on Cancel and goes ahead on Don't save, without writing", async () => {
    seedProjects(true, true);
    const save = vi.fn(async () => true);
    const off = registerFileSaver(TAB, save);
    const cancelled = confirmCloseFileTabs(dirtyFileTabs(), "Quitting");
    await vi.waitFor(() => expect(useConfirmStore.getState().pending).not.toBeNull());
    expect(useConfirmStore.getState().pending).toMatchObject({
      confirmLabel: "Save all",
      alternateLabel: "Don't save",
    });
    useConfirmStore.getState().actions.settle("cancel");
    await expect(cancelled).resolves.toBe(false);

    const dropped = confirmCloseFileTabs(dirtyFileTabs(), "Quitting");
    await vi.waitFor(() => expect(useConfirmStore.getState().pending).not.toBeNull());
    useConfirmStore.getState().actions.settle("alternate");
    await expect(dropped).resolves.toBe(true);
    expect(save).not.toHaveBeenCalled();
    off();
  });

  it("saves every tab on Save, and refuses when any write failed", async () => {
    seedProjects(true, true);
    const saveA = vi.fn(async () => true);
    const saveB = vi.fn(async () => false);
    const offA = registerFileSaver(TAB, saveA);
    const offB = registerFileSaver("editor:/q/b.ts", saveB);
    const first = confirmCloseFileTabs(dirtyFileTabs(), "Quitting");
    await vi.waitFor(() => expect(useConfirmStore.getState().pending).not.toBeNull());
    useConfirmStore.getState().actions.settle("confirm");
    await expect(first).resolves.toBe(false);
    expect(saveA).toHaveBeenCalledOnce();
    expect(saveB).toHaveBeenCalledOnce();

    saveB.mockResolvedValue(true);
    const second = confirmCloseFileTabs(dirtyFileTabs(), "Quitting");
    await vi.waitFor(() => expect(useConfirmStore.getState().pending).not.toBeNull());
    useConfirmStore.getState().actions.settle("confirm");
    await expect(second).resolves.toBe(true);
    offA();
    offB();
  });

  it("drops a torn-down project's buffers unless another project still shows the file", () => {
    seedProjects(false, false);
    useEditorStore.setState({
      buffers: {
        [PATH]: { path: PATH, originalContent: "x", dirty: true } as never,
        "/gone.ts": { path: "/gone.ts", originalContent: "y", dirty: true } as never,
      },
    });
    releaseOrphanedFileBuffers([PATH, "/gone.ts"]);
    expect(buffer()).toBeDefined();
    expect(useEditorStore.getState().buffers["/gone.ts"]).toBeUndefined();
  });
});
