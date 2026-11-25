// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { groupOf, useLayoutStore, type Tab } from "./layout-store";

/**
 * How many tabs of one type the window holds, and which open tab a second
 * `addTab` lands on. One row per tab type, through the store's public
 * actions only.
 *
 * Four rules, and every type follows exactly one:
 *
 *  - `per-id`: a tab is found by its id. The same id focuses the open tab,
 *    wherever it is; another id is another tab.
 *  - `one`: a tab is found by its type. One in the window, whatever id and
 *    column the caller asked for.
 *  - `one-per-column`: a tab is found by its type within the target column.
 *    One per column; a second column gets its own, under a unique id.
 *  - a destination never enters a column. `destination` reopens the open one
 *    of its type in place, keeping its id; `destination-per-id` replaces it
 *    when the id differs.
 *
 * The table is written out here as literals rather than read from the code,
 * so it fails when a type's rule changes.
 */

type Rule = "per-id" | "one" | "one-per-column" | "destination" | "destination-per-id";

const RULES: Record<Tab["type"], Rule> = {
  chat: "per-id",
  canvas: "destination",
  tasks: "one-per-column",
  editor: "per-id",
  files: "one",
  knowledge: "destination",
  "knowledge-graph": "destination",
  memory: "destination",
  terminal: "one-per-column",
  diff: "per-id",
  commit: "per-id",
  "session-changes": "per-id",
  "pull-request": "per-id",
  "pull-requests": "per-id",
  "session-pull-requests": "per-id",
  "source-control": "one",
  log: "one-per-column",
  media: "per-id",
  svg: "per-id",
  pdf: "per-id",
  notebook: "per-id",
  unsupported: "per-id",
  usage: "destination",
  artifacts: "destination",
  inbox: "destination",
  agent: "destination",
  "agent-panel": "one",
  "comms-draft": "per-id",
  spaces: "destination-per-id",
  "team-chat": "one",
};

const layout = () => useLayoutStore.getState();
const actions = () => layout().actions;

const tab = (id: string, type: Tab["type"], title = id): Tab => ({
  id,
  type,
  title,
  closable: true,
  dirty: false,
  data: {},
});

/** The ids of the open column tabs of `type`, with their columns. */
const open = (type: Tab["type"]) =>
  layout()
    .tabs.filter((t) => t.id !== "welcome")
    .filter((t) => t.type === type)
    .map((t) => `${t.id}@${groupOf(t)}`);

beforeEach(() => {
  // A session in the main column and two empty surfaces columns. The session
  // is `welcome`, left out of `open()` so the chat row counts only its own.
  useLayoutStore.setState({
    tabs: [{ ...tab("welcome", "chat"), groupId: "main" }],
    groupOrder: ["main", "g2", "g3"],
    activeByGroup: { main: "welcome" },
    focusedGroupId: "g2",
    activeTabId: null,
    surfaces: "shown",
    zen: false,
    zenPrev: null,
    destination: null,
    destinationShown: false,
    lastForm: {},
    tabHistory: [],
    tabHistoryIndex: -1,
  });
});

describe("tab multiplicity, by type", () => {
  it("has a rule for every tab type", () => {
    expect(Object.keys(RULES)).toHaveLength(30);
  });

  for (const [type, rule] of Object.entries(RULES) as [Tab["type"], Rule][]) {
    // A session always opens in the main column; everything else was asked
    // into `g2`.
    const home = type === "chat" ? "main" : "g2";
    const other = type === "chat" ? "main" : "g3";

    if (rule === "per-id") {
      it(`${type}: found by id`, () => {
        actions().addTab(tab("a", type), "g2");
        expect(open(type)).toEqual([`a@${home}`]);

        // The same id again, asked into another column: the open tab, where
        // it is.
        actions().addTab(tab("a", type), "g3");
        expect(open(type)).toEqual([`a@${home}`]);
        expect(layout().focusedGroupId).toBe(home);
        expect(layout().activeByGroup[home]).toBe("a");
        expect(layout().activeTabId).toBe("a");

        // Another id in the same column: a second tab.
        actions().addTab(tab("b", type), "g2");
        expect(open(type)).toEqual([`a@${home}`, `b@${home}`]);
        expect(layout().activeByGroup[home]).toBe("b");

        // And a third in another column.
        actions().addTab(tab("c", type), "g3");
        expect(open(type)).toEqual([`a@${home}`, `b@${home}`, `c@${other}`]);
        expect(layout().destination).toBeNull();
      });
    }

    if (rule === "one") {
      it(`${type}: one in the window, found by type`, () => {
        actions().addTab(tab("a", type), "g2");
        expect(open(type)).toEqual(["a@g2"]);

        // Another id, the same column.
        actions().addTab(tab("b", type), "g2");
        expect(open(type)).toEqual(["a@g2"]);

        // Another id, another column, with the focus elsewhere: still the
        // open one, and the focus goes to it.
        actions().setActiveTab("welcome");
        actions().addTab(tab("c", type), "g3");
        expect(open(type)).toEqual(["a@g2"]);
        expect(layout().focusedGroupId).toBe("g2");
        expect(layout().activeByGroup.g2).toBe("a");
        expect(layout().activeTabId).toBe("a");
      });
    }

    if (rule === "one-per-column") {
      it(`${type}: one per column, found by type within the column`, () => {
        actions().addTab(tab("a", type), "g2");
        expect(open(type)).toEqual(["a@g2"]);

        // Another id, the same column: the open one.
        actions().addTab(tab("b", type), "g2");
        expect(open(type)).toEqual(["a@g2"]);
        expect(layout().activeByGroup.g2).toBe("a");

        // The same id, another column: that column's own, under a unique id.
        actions().addTab(tab("a", type), "g3");
        expect(open(type)).toEqual(["a@g2", "a-2@g3"]);
        expect(layout().focusedGroupId).toBe("g3");
        expect(layout().activeByGroup.g3).toBe("a-2");

        // And again there: the one that column has.
        actions().addTab(tab("d", type), "g3");
        expect(open(type)).toEqual(["a@g2", "a-2@g3"]);
        expect(layout().destination).toBeNull();
      });
    }

    if (rule === "destination" || rule === "destination-per-id") {
      it(`${type}: a destination, ${rule === "destination" ? "reopened in place" : "one per id"}`, () => {
        actions().addTab(tab("a", type), "g2");
        expect(open(type)).toEqual([]);
        expect(layout().destination?.id).toBe("a");
        expect(layout().destinationShown).toBe(true);

        // Another id of the same type.
        actions().hideDestination();
        actions().addTab(tab("b", type, "second"), "g2");
        expect(open(type)).toEqual([]);
        expect(layout().destination?.type).toBe(type);
        expect(layout().destination?.id).toBe(rule === "destination" ? "a" : "b");
        // In place or not, it takes the newer title.
        expect(layout().destination?.title).toBe("second");
        expect(layout().destinationShown).toBe(true);
      });
    }
  }

  it("a type in both forms is one in the window across them", () => {
    actions().addTab(tab("team-chat", "team-chat"), "g2");
    actions().showDestination(tab("team-chat", "team-chat"));
    expect(open("team-chat")).toEqual([]);
    expect(layout().destination?.type).toBe("team-chat");

    // Leaving its column emptied and collapsed `g2`, so it comes back in the
    // column that is left.
    actions().addTab(tab("team-chat", "team-chat"), "g3");
    expect(open("team-chat")).toEqual(["team-chat@g3"]);
    expect(layout().destination).toBeNull();
  });
});
