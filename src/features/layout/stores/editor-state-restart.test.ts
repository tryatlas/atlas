// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

// A restart of one project's layout: `<project>/.atlas/editor-state.json`.
//
// Rust stores that file as the string it was handed and returns the same
// bytes (`the_editor_state_is_returned_byte_for_byte_after_a_restart` in
// `commands/knowledge.rs`), so the shape is this store's alone and no Rust
// type describes it. The fake below is that pass-through: what
// `save_editor_state` receives is what `load_editor_state` answers. The test
// saves a layout through the real save path, loads it into a fresh layout
// through the real load path, and saves again: the second file must be the
// first.
vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
import { tauri } from "@/test/tauri-fake";

import { useLayoutStore, type Tab } from "./layout-store";
import { useTerminalStore } from "@/features/terminal/stores/terminal-store";

const PROJECT = "/Users/dev/atlas";

const actions = () => useLayoutStore.getState().actions;

const tab = (id: string, type: Tab["type"], groupId: string, data: Tab["data"] = {}): Tab => ({
  id,
  type,
  title: `title of ${id}`,
  closable: true,
  dirty: false,
  data,
  groupId,
});

/** The tab every project starts with. Not closable, so never saved. */
const WELCOME: Tab = { ...tab("welcome-chat", "chat", "main"), title: "Session", closable: false };

/** A project just opened, before its saved layout is loaded. */
function freshLayout(): void {
  useLayoutStore.setState({
    tabs: [WELCOME],
    groupOrder: ["main"],
    activeByGroup: { main: "welcome-chat" },
    focusedGroupId: "main",
    activeTabId: "welcome-chat",
    surfaces: "shown",
    zen: false,
    zenPrev: null,
    destination: null,
    destinationShown: false,
  });
}

/** The file on disk, as the pass-through commands keep it. */
let onDisk: string | null;

async function save(): Promise<Record<string, unknown>> {
  await actions().flushEditorState(PROJECT);
  expect(onDisk).not.toBeNull();
  return JSON.parse(onDisk!) as Record<string, unknown>;
}

beforeEach(() => {
  tauri.reset();
  onDisk = null;
  tauri.handleRaw({
    save_editor_state: (args) => {
      const { projectPath, stateJson } = args as { projectPath: string; stateJson: string };
      expect(projectPath).toBe(PROJECT);
      onDisk = stateJson;
      return null;
    },
    load_editor_state: () => onDisk ?? "{}",
  });
  freshLayout();
});

describe("a project's layout across a restart", () => {
  it("comes back as it was saved: columns, tabs, their data, and what was active", async () => {
    useLayoutStore.setState({
      tabs: [
        WELCOME,
        tab("chat-1", "chat", "main", { threadId: "thread-1" }),
        tab("editor-1", "editor", "split-a", { path: "/Users/dev/atlas/src/main.rs", line: 12 }),
        tab("terminal-1", "terminal", "split-a"),
        tab("diff-1", "diff", "split-b", { file: "src/lib.rs", staged: true }),
      ],
      groupOrder: ["main", "split-a", "split-b"],
      activeByGroup: { main: "chat-1", "split-a": "terminal-1", "split-b": "diff-1" },
      focusedGroupId: "split-a",
      activeTabId: "terminal-1",
    });
    const saved = await save();
    // Floor: the save wrote what was set up, not an empty layout.
    expect((saved.tabs as unknown[]).length).toBe(4);
    expect(saved.groupOrder).toEqual(["main", "split-a", "split-b"]);

    freshLayout();
    await actions().loadEditorState(PROJECT);

    const restored = useLayoutStore.getState();
    expect(restored.groupOrder).toEqual(["main", "split-a", "split-b"]);
    expect(restored.activeByGroup).toEqual({
      main: "chat-1",
      "split-a": "terminal-1",
      "split-b": "diff-1",
    });
    expect(restored.focusedGroupId).toBe("split-a");
    expect(restored.tabs.find((t) => t.id === "editor-1")).toEqual(
      tab("editor-1", "editor", "split-a", { path: "/Users/dev/atlas/src/main.rs", line: 12 }),
    );

    // Saved again, the file is the one that was loaded: nothing dropped,
    // renamed or reordered on the way through the store.
    expect(await save()).toEqual(saved);
  });

  it("loads a project with no saved layout as the fresh one", async () => {
    await actions().loadEditorState(PROJECT);

    expect(useLayoutStore.getState().tabs).toEqual([WELCOME]);
    expect(useLayoutStore.getState().groupOrder).toEqual(["main"]);
  });

  it("ignores a key it does not know, and a tab of a type it does not know", async () => {
    onDisk = JSON.stringify({
      version: 99,
      fromANewerBuild: { kept: false },
      tabs: [
        { id: "editor-1", type: "editor", title: "main.rs", data: { path: "a" }, groupId: "main" },
        { id: "x-1", type: "a-type-from-the-future", title: "?", data: {}, groupId: "main" },
      ],
      groupOrder: ["main", "split-a"],
      activeByGroup: { main: "welcome-chat" },
      focusedGroupId: "main",
    });

    await actions().loadEditorState(PROJECT);

    const ids = useLayoutStore.getState().tabs.map((t) => t.id);
    expect(ids).toContain("editor-1");
    expect(ids).not.toContain("x-1");
    // The unknown key is not carried: the next save writes this build's shape.
    expect(await save()).not.toHaveProperty("fromANewerBuild");
  });
});

describe("what reaches the layout file", () => {
  it("brings the welcome chat's conversation back", async () => {
    useLayoutStore.setState({
      tabs: [{ ...WELCOME, data: { sessionId: "session-7" } }],
    });
    expect((await save()).welcomeChat).toEqual({ sessionId: "session-7" });

    freshLayout();
    await actions().loadEditorState(PROJECT);

    expect(useLayoutStore.getState().tabs.find((t) => t.id === "welcome-chat")?.data).toEqual({
      sessionId: "session-7",
    });
  });

  it("does not replace a conversation the welcome chat started before the file loaded", async () => {
    useLayoutStore.setState({ tabs: [{ ...WELCOME, data: { sessionId: "saved" } }] });
    await save();
    useLayoutStore.setState({ tabs: [{ ...WELCOME, data: { sessionId: "live" } }] });
    await actions().loadEditorState(PROJECT);
    expect(useLayoutStore.getState().tabs[0].data).toEqual({ sessionId: "live" });
  });

  it("writes a change to a terminal's split panes alone", async () => {
    const terminals = () => useTerminalStore.getState().actions;
    useLayoutStore.setState({
      tabs: [WELCOME, tab("terminal-1", "terminal", "main")],
    });
    terminals().initTab("terminal-1", "project-1", PROJECT);
    await save();
    const writes = tauri.calls("save_editor_state").length;

    const pane = useTerminalStore.getState().tabs["terminal-1"].activePaneId!;
    terminals().splitPane("terminal-1", pane, "horizontal");
    await save();

    expect(tauri.calls("save_editor_state").length).toBe(writes + 1);
    const tree = (JSON.parse(onDisk!) as { terminalTrees: Record<string, { root: unknown }> })
      .terminalTrees["terminal-1"].root as { type: string };
    expect(tree.type).toBe("split");
  });

  it("skips a byte-identical write, and retries one that failed", async () => {
    useLayoutStore.setState({ tabs: [WELCOME, tab("editor-1", "editor", "main")] });
    await save();
    const writes = () => tauri.calls("save_editor_state").length;
    const before = writes();
    await actions().flushEditorState(PROJECT);
    expect(writes()).toBe(before);

    tauri.handleRaw({
      save_editor_state: () => {
        throw new Error("disk full");
      },
    });
    useLayoutStore.setState({ tabs: [WELCOME, tab("editor-2", "editor", "main")] });
    await actions().flushEditorState(PROJECT);
    expect(writes()).toBe(before + 1);

    tauri.handleRaw({
      save_editor_state: (args) => {
        onDisk = (args as { stateJson: string }).stateJson;
        return null;
      },
    });
    await actions().flushEditorState(PROJECT);
    expect(writes()).toBe(before + 2);
    expect(onDisk).toContain("editor-2");
  });
});
