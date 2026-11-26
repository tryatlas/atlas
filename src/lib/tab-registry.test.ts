// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));

import {
  LAUNCHER_ENTRIES,
  ORG_SCOPED_TYPES,
  PROJECTLESS_TYPES,
  TAB_REGISTRY,
  TAB_TYPES,
  WINDOW_TYPES,
  fileTabPath,
  isDestination,
  isDestinationOnly,
  isDualPlacement,
  isFileTab,
  isIdleExpensive,
  isPersistent,
  isSession,
  migrateTabType,
  multiplicityOf,
  placementOf,
  surfaceMinWidth,
  tabEntry,
  typedTab,
  type FileTabType,
  type LauncherType,
  type PersistentTabType,
  type TabData,
  type TabType,
  type TabTypeEntry,
} from "@/lib/tab-registry";
import { SURFACES } from "@/features/layout/lib/surfaces";
import { tabIcons } from "@/features/layout/components/pane-tab";

/**
 * The tab registry (`tab-registry.ts`): one entry per tab type, and every
 * list the app reads derived from it.
 *
 * The first half is characterisation. The literals below are the values each
 * list had when the facts lived in separate files (`TAB_PLACEMENT` and the
 * scope sets in a constants file, the persistent lists beside the panels, the
 * file-tab set in the explorer, `SURFACES` beside the launcher). The derived
 * views must still equal them, so changing an entry means changing a literal
 * here on purpose.
 *
 * The second half is what the registry promises about itself: that every
 * entry is whole, that the facts agree with each other and with ADR-0024, and
 * that `tsc` refuses a registry with a type or a fact missing.
 */

const TYPES = [
  "chat",
  "canvas",
  "tasks",
  "editor",
  "files",
  "knowledge",
  "knowledge-graph",
  "memory",
  "terminal",
  "diff",
  "commit",
  "session-changes",
  "pull-request",
  "pull-requests",
  "session-pull-requests",
  "source-control",
  "log",
  "media",
  "svg",
  "pdf",
  "notebook",
  "unsupported",
  "usage",
  "artifacts",
  "inbox",
  "agent",
  "agent-panel",
  "comms-draft",
  "spaces",
  "team-chat",
] as const;

const PLACEMENT: Record<(typeof TYPES)[number], string> = {
  chat: "session",
  editor: "surface 320",
  files: "surface 240",
  terminal: "surface 280",
  diff: "surface 360",
  commit: "surface 360",
  "session-changes": "surface 320",
  "pull-request": "surface 360",
  "pull-requests": "surface 360",
  "session-pull-requests": "surface 320",
  "source-control": "surface 300",
  "team-chat": "surface-or-destination 320",
  "agent-panel": "surface 320",
  "comms-draft": "surface 320",
  log: "surface 300",
  pdf: "surface 320",
  notebook: "surface 360",
  media: "surface 240",
  svg: "surface 240",
  unsupported: "surface 240",
  tasks: "surface 240",
  artifacts: "destination",
  inbox: "destination",
  agent: "destination",
  usage: "destination",
  knowledge: "destination",
  "knowledge-graph": "destination",
  memory: "destination",
  canvas: "destination",
  spaces: "destination",
};

const PROJECTLESS = [
  "usage",
  "inbox",
  "agent",
  "agent-panel",
  "comms-draft",
  "spaces",
  "team-chat",
];
const WINDOW = ["agent-panel", "team-chat"];
const ORG_SCOPED = ["usage", "comms-draft", "spaces"];
const PERSISTENT = ["chat", "editor", "terminal", "pdf", "agent-panel", "team-chat"];
const IDLE_EXPENSIVE = ["terminal", "pdf"];
const FILE_BACKED = ["editor", "media", "svg", "pdf", "notebook", "unsupported"];

/** The ⌘T list, in the order it is offered. */
const LAUNCHER = [
  ["chat", "Agent", "A"],
  ["terminal", "Terminal", "T"],
  ["editor", "New file", "N"],
  ["files", "Files", "F"],
  ["source-control", "Source control", "G"],
  ["pull-requests", "Pull requests", "P"],
  ["team-chat", "Team chat", "C"],
  ["agent-panel", "Ask Atlas", "O"],
  ["log", "Log", "L"],
];

describe("the lists derived from the registry", () => {
  it("are the same tab types, in the same order", () => {
    expect([...TAB_TYPES]).toEqual([...TYPES]);
    expect(Object.keys(TAB_REGISTRY)).toEqual([...TYPES]);
  });

  it("place every type where it was placed", () => {
    const placed = Object.fromEntries(
      TAB_TYPES.map((type) => {
        const p: { kind: string; minWidth?: number } = placementOf(type);
        return [type, p.minWidth === undefined ? p.kind : `${p.kind} ${p.minWidth}`];
      }),
    );
    expect(placed).toEqual(PLACEMENT);
  });

  it("answer the placement questions the same way", () => {
    const kindOf = (type: TabType) => PLACEMENT[type].split(" ")[0];
    for (const type of TAB_TYPES) {
      const kind = kindOf(type);
      expect(isSession(type), type).toBe(kind === "session");
      expect(isDestinationOnly(type), type).toBe(kind === "destination");
      expect(isDualPlacement(type), type).toBe(kind === "surface-or-destination");
      expect(isDestination(type), type).toBe(
        kind === "destination" || kind === "surface-or-destination",
      );
      const min = PLACEMENT[type].split(" ")[1];
      expect(surfaceMinWidth(type), type).toBe(min === undefined ? null : Number(min));
    }
  });

  it("scope the same types to no project, the window and the Organisation", () => {
    expect([...PROJECTLESS_TYPES]).toEqual(PROJECTLESS);
    expect([...WINDOW_TYPES]).toEqual(WINDOW);
    expect([...ORG_SCOPED_TYPES]).toEqual(ORG_SCOPED);
  });

  it("keep the same types mounted, and drop the same ones in a background project", () => {
    expect(TAB_TYPES.filter(isPersistent)).toEqual(PERSISTENT);
    expect(TAB_TYPES.filter(isIdleExpensive)).toEqual(IDLE_EXPENSIVE);
  });

  it("call the same types file tabs", () => {
    expect(TAB_TYPES.filter((t) => isFileTab(t))).toEqual(FILE_BACKED);
    // It takes a saved tab's type too, which may be anything.
    expect(isFileTab("mission-control")).toBe(false);
    expect(isFileTab("constructor")).toBe(false);
  });

  it("offer the same launcher entries, in the same order, under the tab's own icon", () => {
    expect(LAUNCHER_ENTRIES.map((s) => [s.type, s.label, s.key])).toEqual(LAUNCHER);
    expect(SURFACES.map((s) => [s.type, s.label, s.key])).toEqual(LAUNCHER);
    for (const s of SURFACES) expect(s.icon, s.type).toBe(tabIcons[s.type]);
  });

  it("still map a renamed type forward and drop an unknown one", () => {
    expect(migrateTabType("mission-control")).toBe("usage");
    expect(migrateTabType("terminal")).toBe("terminal");
    expect(migrateTabType("settings")).toBeNull();
  });
});

describe("every registry entry", () => {
  const FACTS = [
    "placement",
    "scope",
    "mount",
    "multiplicity",
    "fileBacked",
    "launcher",
    "data",
  ] as const satisfies readonly (keyof TabTypeEntry)[];

  it("has every fact, and nothing else", () => {
    expect(TAB_TYPES.length).toBeGreaterThanOrEqual(30);
    for (const type of TAB_TYPES) {
      expect(Object.keys(tabEntry(type)).sort(), type).toEqual([...FACTS].sort());
    }
  });

  it("holds a value each fact allows", () => {
    for (const type of TAB_TYPES) {
      const e = tabEntry(type);
      expect(["session", "surface", "destination", "surface-or-destination"], type).toContain(
        e.placement.kind,
      );
      expect(["project", "projectless", "organisation", "window"], type).toContain(e.scope);
      expect(["active", "persistent", "persistent-idle-expensive"], type).toContain(e.mount);
      expect(["per-id", "one", "one-per-column"], type).toContain(e.multiplicity);
      expect(typeof e.fileBacked, type).toBe("boolean");
    }
  });

  it("is placed by ADR-0024's rule", () => {
    // The session is one type; it is not a surface and not a destination.
    expect(TAB_TYPES.filter(isSession)).toEqual(["chat"]);
    for (const type of TAB_TYPES) {
      const e = tabEntry(type);
      const min = surfaceMinWidth(type);
      if (e.placement.kind === "session" || e.placement.kind === "destination") {
        expect(min, type).toBeNull();
      } else {
        // Below 200px nothing lays out; above 600px it is not a column tool.
        expect(min, type).toBeGreaterThanOrEqual(200);
        expect(min, type).toBeLessThanOrEqual(600);
      }
    }
  });

  it("is a destination only in ways a full page can be", () => {
    for (const type of TAB_TYPES.filter(isDestinationOnly)) {
      const e = tabEntry(type);
      // The destination screen keeps its own page mounted; a column never does.
      expect(e.mount, type).toBe("active");
      // ⌘T opens a column's tab.
      expect(e.launcher, type).toBeNull();
      // There is one destination screen, so "one per column" means nothing.
      expect(e.multiplicity, type).not.toBe("one-per-column");
      expect(e.fileBacked, type).toBe(false);
    }
  });

  it("is one in the window when it is the window's, or opens in both forms", () => {
    for (const type of TAB_TYPES) {
      const e = tabEntry(type);
      if (e.scope === "window") expect(e.multiplicity, type).toBe("one");
      if (isDualPlacement(type)) expect(e.scope, type).toBe("window");
    }
  });

  it("is found by its id when it shows a file, in a column", () => {
    for (const type of TAB_TYPES.filter((t) => isFileTab(t))) {
      expect(multiplicityOf(type), type).toBe("per-id");
      expect(placementOf(type).kind, type).toBe("surface");
    }
  });

  it("has a launcher row with a letter and a place of its own", () => {
    const keys = LAUNCHER_ENTRIES.map((s) => s.key);
    for (const key of keys) expect(key).toMatch(/^[A-Z]$/);
    expect(new Set(keys).size).toBe(keys.length);
    expect(LAUNCHER_ENTRIES.map((s) => s.order)).toEqual(LAUNCHER_ENTRIES.map((_, i) => i));
  });
});

describe("tab data", () => {
  const tab = <K extends TabType>(type: K, data: Record<string, unknown>) => ({
    id: "t",
    type,
    title: "t",
    data,
  });

  it("is typed by the tab's type once the type is narrowed", () => {
    const t = typedTab(tab("commit" as TabType, { repoPath: "/r", sha: "abc" }));
    let read = "";
    switch (t.type) {
      case "commit":
        read = `${t.data.repoPath}@${t.data.sha}`;
        break;
      default:
        break;
    }
    expect(read).toBe("/r@abc");
    // The same object: a view, not a copy.
    const raw = tab("pdf", { filePath: "/a.pdf" });
    expect(typedTab(raw)).toBe(raw);
  });

  it("gives a file tab's path, and nothing for any other tab", () => {
    expect(fileTabPath(tab("pdf", { filePath: "/a.pdf" }))).toBe("/a.pdf");
    expect(fileTabPath(tab("editor", {}))).toBeNull();
    expect(fileTabPath(tab("editor", { filePath: 3 }))).toBeNull();
    // A diff carries no file path of this kind, even if its data has the key.
    expect(fileTabPath(tab("diff", { filePath: "/a.ts" }))).toBeNull();
    expect(fileTabPath({ type: "mission-control", data: { filePath: "/a" } })).toBeNull();
  });
});

/**
 * What `tsc` refuses. Each `@ts-expect-error` fails `bun run typecheck` the
 * day the line under it starts to compile, which is the day the registry
 * stopped demanding that fact.
 */
describe("the registry's types", () => {
  const whole: TabTypeEntry = {
    placement: { kind: "surface", minWidth: 320 },
    scope: "project",
    mount: "active",
    multiplicity: "per-id",
    fileBacked: false,
    launcher: null,
    data: {},
  };

  it("refuse an entry with a fact missing", () => {
    const { multiplicity: _dropped, ...partial } = whole;
    // @ts-expect-error an entry needs every fact
    const entry: TabTypeEntry = partial;
    // @ts-expect-error and only the values a fact allows
    const wrong: TabTypeEntry = { ...whole, mount: "always" };
    expect([entry, wrong]).toHaveLength(2);
  });

  it("refuse a registry with a type missing", () => {
    const { terminal: _dropped, ...rest } = TAB_REGISTRY;
    // @ts-expect-error every tab type needs an entry
    const registry: Record<TabType, TabTypeEntry> = rest;
    expect(Object.keys(registry)).not.toContain("terminal");
  });

  it("refuse a type that is not in the registry", () => {
    // @ts-expect-error not a tab type
    const type: TabType = "settings";
    expect(TAB_TYPES).not.toContain(type);
  });

  it("derive the narrowed unions from the entries", () => {
    // Each assignment fails `tsc` if the derived union drifts from its entry.
    const persistent: PersistentTabType = "team-chat";
    const file: FileTabType = "notebook";
    const offered: LauncherType = "pull-requests";
    // @ts-expect-error a log panel is not kept mounted
    const notPersistent: PersistentTabType = "log";
    // @ts-expect-error a diff is not a file tab
    const notFile: FileTabType = "diff";
    // @ts-expect-error ⌘T does not offer a destination
    const notOffered: LauncherType = "knowledge";
    const data: TabData<"commit"> = { repoPath: "/r", sha: "abc" };
    // @ts-expect-error a commit tab's data names a commit
    const wrongData: TabData<"commit"> = { repoPath: "/r" };
    expect([persistent, file, offered, notPersistent, notFile, notOffered]).toHaveLength(6);
    expect([data, wrongData]).toHaveLength(2);
  });
});
