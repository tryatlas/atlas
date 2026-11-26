// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
import { tauri } from "@/test/tauri-fake";

import { groupOf, useLayoutStore, type Tab } from "./layout-store";

/**
 * Dragging a tab in a strip (`moveTab`). The order is the column's order
 * everywhere, so it has to hold three things: a tab never leaves its column,
 * the other columns' tabs keep their places, and the new order is what the
 * project's layout file saves.
 */

const layout = () => useLayoutStore.getState();
const actions = () => layout().actions;

const tab = (id: string, type: Tab["type"], groupId: string): Tab => ({
  id,
  type,
  title: id,
  closable: true,
  dirty: false,
  data: {},
  groupId,
});

const column = (gid: string) =>
  layout()
    .tabs.filter((t) => groupOf(t) === gid)
    .map((t) => t.id);

beforeEach(() => {
  tauri.reset();
  useLayoutStore.setState({
    // Interleaved on purpose: a column's tabs need not be contiguous in `tabs`.
    tabs: [
      tab("chat-1", "chat", "main"),
      tab("a", "terminal", "g2"),
      tab("chat-2", "chat", "main"),
      tab("b", "log", "g2"),
      tab("c", "source-control", "g2"),
    ],
    groupOrder: ["main", "g2"],
    activeByGroup: { main: "chat-1", g2: "a" },
    focusedGroupId: "g2",
    activeTabId: "a",
    surfaces: "shown",
    zen: false,
    zenPrev: null,
  });
});

describe("moveTab", () => {
  it("moves a tab within its column, forward and back", () => {
    actions().moveTab("a", 2);
    expect(column("g2")).toEqual(["b", "c", "a"]);
    actions().moveTab("a", 0);
    expect(column("g2")).toEqual(["a", "b", "c"]);
    actions().moveTab("c", 1);
    expect(column("g2")).toEqual(["a", "c", "b"]);
  });

  it("leaves every other column's tabs exactly where they were", () => {
    actions().moveTab("c", 0);
    expect(layout().tabs.map((t) => t.id)).toEqual(["chat-1", "c", "chat-2", "a", "b"]);
    expect(column("main")).toEqual(["chat-1", "chat-2"]);
    expect(layout().tabs.every((t) => (t.type === "chat" ? groupOf(t) === "main" : true))).toBe(
      true,
    );
  });

  it("never moves a tab out of its column, even past the column's end", () => {
    actions().moveTab("a", 99);
    expect(column("g2")).toEqual(["b", "c", "a"]);
    expect(groupOf(layout().tabs.find((t) => t.id === "a"))).toBe("g2");
  });

  it("keeps the active tab and focus, and is a no-op for an unknown id", () => {
    const before = layout().tabs;
    actions().moveTab("nope", 0);
    expect(layout().tabs).toBe(before);
    actions().moveTab("a", 2);
    expect(layout().activeByGroup.g2).toBe("a");
    expect(layout().focusedGroupId).toBe("g2");
  });

  it("is the order ⌘1–9 picks by", () => {
    actions().moveTab("c", 0);
    actions().activateTabByIndex(0);
    expect(layout().activeByGroup.g2).toBe("c");
  });

  it("persists: the project's layout file saves the new order", () => {
    actions().moveTab("a", 2);
    actions().saveEditorState("/tmp/project");
    const [save] = tauri.calls("save_editor_state");
    expect(save).toBeDefined();
    const state = JSON.parse(save.args.stateJson) as {
      tabs: Array<{ id: string; groupId: string }>;
    };
    expect(state.tabs.filter((t) => t.groupId === "g2").map((t) => t.id)).toEqual(["b", "c", "a"]);
  });
});
