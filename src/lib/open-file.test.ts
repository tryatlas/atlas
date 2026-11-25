// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useEditorStore } from "@/features/editor/stores/editor-store";
import { editorTabId, openFile, openFileAs } from "./open-file";

beforeEach(() => {
  useLayoutStore.setState({
    tabs: [],
    groupOrder: ["main"],
    focusedGroupId: "main",
    activeByGroup: {},
    activeTabId: null,
    tabHistory: [],
  });
  useEditorStore.setState({ buffers: {}, activeBufferPath: null, pendingReveals: {} });
});

const tabIds = () => useLayoutStore.getState().tabs.map((t) => t.id);

describe("openFileAs", () => {
  it("opens one editor tab per path and returns its id", () => {
    const id = openFileAs("/p/src/a.ts", "text");
    expect(id).toBe(editorTabId("/p/src/a.ts"));
    expect(openFileAs("/p/src/a.ts", "text")).toBe(id);
    expect(tabIds()).toEqual([id]);
    expect(useLayoutStore.getState().activeTabId).toBe(id);
  });

  it("requests the reveal for an editor tab", () => {
    openFileAs("/p/src/a.ts", "text", { reveal: { line: 200, column: 4 } });
    expect(useEditorStore.getState().pendingReveals["/p/src/a.ts"]).toMatchObject({
      line: 200,
      column: 4,
    });
  });

  it("opens read-only unless asked to edit, and an edit open marks an open tab too", () => {
    const editing = (id: string) =>
      useLayoutStore.getState().tabs.find((t) => t.id === id)?.data.editing;
    const id = openFileAs("/p/src/a.ts", "text");
    expect(editing(id)).toBeUndefined();
    openFileAs("/p/src/a.ts", "text", { edit: true });
    expect(editing(id)).toBe(true);
    // A later plain open leaves the choice the tab already has.
    openFileAs("/p/src/a.ts", "text");
    expect(editing(id)).toBe(true);
  });

  it("ignores a reveal for a file that does not open in the editor", () => {
    openFileAs("/p/logo.png", "image", { reveal: { line: 2 } });
    expect(useEditorStore.getState().pendingReveals["/p/logo.png"]).toBeUndefined();
  });
});

describe("openFile", () => {
  it("classifies by extension and resolves to the tab id", async () => {
    await expect(openFile("/p/src/a.ts")).resolves.toBe(editorTabId("/p/src/a.ts"));
    await expect(openFile("/p/logo.png")).resolves.toBe("media:/p/logo.png");
  });
});

it("uses one tab and reveal key for Windows separator variants", () => {
  const native = openFileAs("c:\\project\\src\\file.ts", "text");
  const slash = openFileAs("C:/project/src/file.ts", "text", { reveal: { line: 4 } });
  expect(native).toBe(slash);
  expect(tabIds()).toEqual([slash]);
  expect(useLayoutStore.getState().tabs[0].data.filePath).toBe("C:/project/src/file.ts");
  expect(useEditorStore.getState().pendingReveals["C:/project/src/file.ts"].line).toBe(4);
});
