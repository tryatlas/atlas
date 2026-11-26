// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));

import {
  LAUNCHER_ENTRIES,
  TAB_TYPES,
  WINDOW_TYPES,
  isDestination,
  isDestinationOnly,
  isDualPlacement,
  isPersistent,
  placementOf,
  surfaceMinWidth,
  type DestinationType,
  type DualPlacementType,
  type TabType,
} from "@/lib/tab-registry";
import { LAYOUT_TEMPLATES } from "@/features/layout/templates";
import { SURFACES } from "@/features/layout/lib/surfaces";
import { useLayoutStore, type Tab } from "@/features/layout/stores/layout-store";

/**
 * Guards ADR-0024: surfaces sit beside the session, destinations take the
 * window.
 *
 * A type's placement is one fact of its entry in the tab registry
 * (`@/lib/tab-registry`), so `tsc` already refuses a tab type without one,
 * and the destination screen's `switch` refuses a destination without a page.
 * What it cannot see is a destination being offered somewhere that would put
 * it in a column anyway: the ⌘T list, a layout template, zen, or the column
 * renderer's keep-mounted policy.
 *
 * Three of those are registry data now, so this suite reads the data: a
 * type's launcher row and its mount policy sit in the same entry as its
 * placement. Zen rearranges columns in the layout store by hand, so that one
 * is checked by running it. Nothing here reads source text.
 *
 * A full page squeezed into a column is what this ADR exists to stop. If you
 * need a destination beside the session, the answer is a peek (a compact
 * view designed for a column), not a launcher row or a persistent mount.
 *
 * The 2026-10-24 amendment adds `surface-or-destination`, for a tool that
 * passes the surface test and is also a place of its own (team chat). Such a
 * type may be offered as a surface; it must also be one per window, since
 * opening it in one form moves it out of the other.
 */

const kindOf = (type: TabType) => placementOf(type).kind;
const DESTINATIONS = TAB_TYPES.filter((t) => kindOf(t) === "destination");
const DUAL = TAB_TYPES.filter((t) => kindOf(t) === "surface-or-destination");
const SURFACES_ = TAB_TYPES.filter((t) => {
  const kind = kindOf(t);
  return kind === "surface" || kind === "surface-or-destination";
});

const sessionTab = (id: string): Tab => ({
  id,
  type: "chat",
  title: id,
  closable: false,
  dirty: false,
  data: {},
  groupId: "main",
});

beforeEach(() => {
  useLayoutStore.setState({
    tabs: [sessionTab("welcome")],
    groupOrder: ["main"],
    activeByGroup: { main: "welcome" },
    focusedGroupId: "main",
    activeTabId: "welcome",
    surfaces: "shown",
    zen: false,
    zenPrev: null,
    destination: null,
    destinationShown: false,
    lastForm: {},
  });
});

describe("tab placement (ADR-0024)", () => {
  it("has a non-trivial set of each kind (a floor, so no check below passes empty)", () => {
    expect(DESTINATIONS.length).toBeGreaterThan(3);
    expect(SURFACES_.length).toBeGreaterThan(3);
    expect(TAB_TYPES.filter((t) => kindOf(t) === "session")).toEqual(["chat"]);
  });

  it("every surface declares a believable minimum width", () => {
    for (const type of SURFACES_) {
      const min = surfaceMinWidth(type);
      // Below 200px nothing lays out; above 600px it is not a column tool.
      expect(min, type).toBeGreaterThanOrEqual(200);
      expect(min, type).toBeLessThanOrEqual(600);
    }
  });

  it("a type in both forms is a destination type, never destination-only, and one per window", () => {
    expect(DUAL).toContain("team-chat");
    for (const type of DUAL) {
      expect(isDualPlacement(type), type).toBe(true);
      expect(isDestination(type), type).toBe(true);
      expect(isDestinationOnly(type), type).toBe(false);
      expect(WINDOW_TYPES.has(type), `${type} must be one per window`).toBe(true);
    }
    for (const type of DESTINATIONS) {
      expect(isDestinationOnly(type), type).toBe(true);
      expect(isDualPlacement(type), type).toBe(false);
    }
  });

  it("the placement types partition the tab types the same way the predicates do", () => {
    // Compile-time: each line fails `tsc` if the derived union drifts.
    const dual: DualPlacementType = "team-chat";
    const asDestination: DestinationType = dual;
    const timeline: DestinationType = "artifacts";
    expect([asDestination, timeline]).toEqual(["team-chat", "artifacts"]);
  });

  it("the ⌘T list offers surfaces only", () => {
    // The registry's rows, and the list the `+` menu and the launcher render.
    expect(LAUNCHER_ENTRIES.length).toBeGreaterThan(3);
    expect(SURFACES.map((s) => s.type)).toEqual(LAUNCHER_ENTRIES.map((s) => s.type));
    for (const { type } of SURFACES) expect(kindOf(type), type).not.toBe("destination");
  });

  it("no layout template puts a destination in a column, and each starts with the session", () => {
    for (const template of LAYOUT_TEMPLATES) {
      expect(template.columns[0]?.type, template.id).toBe("chat");
      for (const col of template.columns) {
        expect(kindOf(col.type), `${template.id}: ${col.type}`).not.toBe("destination");
      }
    }
  });

  it("zen shows the session alone and opens nothing", () => {
    // A window with a session and a terminal beside it.
    useLayoutStore.setState((s) => ({
      tabs: [...s.tabs, { ...sessionTab("term"), type: "terminal", closable: true, groupId: "g2" }],
      groupOrder: ["main", "g2"],
      activeByGroup: { main: "welcome", g2: "term" },
    }));
    const before = useLayoutStore.getState().tabs.map((t) => t.id);
    useLayoutStore.getState().actions.toggleZenMode();
    const { zen, tabs, groupOrder, activeByGroup, surfaces, destination } =
      useLayoutStore.getState();
    expect(zen).toBe(true);
    expect(tabs.map((t) => t.id)).toEqual(before);
    for (const t of tabs) expect(kindOf(t.type), t.type).not.toBe("destination");
    expect(tabs.find((t) => t.id === activeByGroup[groupOrder[0]])?.type).toBe("chat");
    // The terminal keeps running in its column, out of sight.
    expect(surfaces).toBe("hidden");
    expect(destination).toBeNull();

    useLayoutStore.getState().actions.toggleZenMode();
    const after = useLayoutStore.getState();
    expect(after.zen).toBe(false);
    expect(after.surfaces).toBe("shown");
    expect(after.groupOrder).toEqual(["main", "g2"]);
    expect(after.activeByGroup).toEqual({ main: "welcome", g2: "term" });
  });

  it("the column renderer keeps no destination mounted", () => {
    const kept = TAB_TYPES.filter(isPersistent);
    expect(kept.length).toBeGreaterThanOrEqual(5);
    for (const type of kept) expect(kindOf(type), type).not.toBe("destination");
  });
});
