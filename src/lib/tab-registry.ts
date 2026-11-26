/*
 * The tab registry: what every tab type is, declared once.
 *
 * One entry per type, and every question about a type is asked here: where it
 * opens, whose it is, whether it stays mounted, how many the window holds,
 * whether it shows a file, whether ⌘T offers it, and what its `data` carries.
 * `TabType` is this object's keys, so a type exists exactly when it has an
 * entry, and `satisfies` makes an entry with a fact missing fail `tsc`.
 *
 * Two facts are not here, because they are React and this file is imported by
 * the layout store: a type's icon (`tabIcons` in
 * `features/layout/components/pane-tab.tsx`) and its panel
 * (`features/layout/components/tab-panels.tsx`, lazy, one chunk each). Both
 * are keyed by `TabType` and checked exhaustive, so a new entry here fails
 * `tsc` until each has it. Importing either from here would also move panels
 * between chunks (`manualChunks` in the Vite config).
 *
 * The keys are persisted (the per-project editor state, the layout store):
 * never rename one without an entry in `LEGACY_TAB_TYPES`.
 */

/**
 * Where a tab type opens (ADR-0024):
 *
 *  - `session`: the session column, which shows no tab strip.
 *  - `surface`: a tab in the surfaces pane beside the session. `minWidth` is
 *    the narrowest its layout still works at, in CSS pixels; a column showing
 *    it will not resize below that.
 *  - `destination`: a full-page view that takes the area right of the rail,
 *    one at a time, while the session runs underneath.
 *  - `surface-or-destination`: either, by how it was opened, and one at a
 *    time across both forms: opening it in one form moves it out of the
 *    other. For a tool that passes the surface test AND is a place in its own
 *    right (team chat, amended into ADR-0024). `minWidth` is its floor as a
 *    surface.
 *
 * The test: do you use it WHILE working in a session, and does it have a
 * useful form at column width (about 320–600px)? Yes to both is a surface; no
 * to either is a destination. A destination that someone needs beside the
 * session gets a peek, a compact view designed for a column, never its full
 * page squeezed into one.
 */
export type Placement =
  | { kind: "session" }
  | { kind: "surface"; minWidth: number }
  | { kind: "destination" }
  | { kind: "surface-or-destination"; minWidth: number };

/**
 * Whose a tab is.
 *
 *  - `project`: the open project's. Saved in that project's editor state, and
 *    not shown while no project is open.
 *  - `projectless`: works with no project open; the projectless centre shell
 *    renders these, and the other three scopes below.
 *  - `organisation`: its CONTENT belongs to one Organisation: its id and data
 *    embed conversation or draft ids that exist in exactly one org. Closed on
 *    every org change (`switchOrg`, and the boot reconciliation in the comms
 *    store) and NEVER written to the per-project editor state: that file is
 *    keyed by project path, the same path is commonly open in several orgs,
 *    and a persisted Space tab came back on the incoming org's mount pointing
 *    at the outgoing org's conversation.
 *  - `window`: the window's, one per window, following the user from project
 *    to project instead of staying behind in the one it was opened in. Team
 *    chat is the archetype: nothing in the tab names an org, and the panel
 *    retargets with the socket, so an org switch leaves it open. Never written
 *    to the editor state; whether it was open is a layout preference
 *    (`teamChat.open`), restored on boot.
 */
export type TabScope = "project" | "projectless" | "organisation" | "window";

/**
 * Whether a tab's panel stays mounted while another tab of its column shows.
 *
 *  - `active`: mounted only while it is the column's active tab.
 *  - `persistent`: kept mounted, hidden, across tab switches: inert, but
 *    expensive to rebuild (a session's transcript window and scroll position,
 *    an editor's state, team chat's half-typed message).
 *  - `persistent-idle-expensive`: kept mounted like the above, except in a
 *    BACKGROUND project, where it is unmounted: it keeps burning CPU or GPU
 *    while hidden (a PTY draining output, a live web embed, a PDF worker), and
 *    that idle heat costs more than the rebuild.
 *
 * A destination is never one of the persistent two: the destination screen
 * keeps its own page mounted (`tab-placement-contract.test.ts`).
 */
export type MountPolicy = "active" | "persistent" | "persistent-idle-expensive";

/**
 * How many tabs of a type the window holds, which is also how `addTab` finds
 * the open one.
 *
 *  - `per-id`: found by tab id, which names the thing shown (a file's path, a
 *    commit, a session, a draft). The same id focuses the open tab; another id
 *    is another tab. For a destination: another id replaces the one showing.
 *  - `one`: found by type, anywhere in the window. For a destination: the open
 *    one is reopened in place and keeps its id.
 *  - `one-per-column`: found by type within the target column; a second column
 *    gets its own, under a unique id.
 */
export type Multiplicity = "per-id" | "one" | "one-per-column";

/** A row of the ⌘T list. `key` is the bare letter that picks it and the hint
 *  shown beside it; `order` is its position in the list. */
export interface LauncherEntry {
  label: string;
  key: string;
  order: number;
}

/** What a type's `data` carries: a type and nothing at runtime. */
export interface DataShape<T> {
  readonly __shape?: T;
}
const NO_SHAPE = Object.freeze({});
const shape = <T extends object>(): DataShape<T> => NO_SHAPE;

/** A type that reads nothing from its `data`. */
type NoData = Record<string, unknown>;
/** A file tab: the absolute path of the file it shows. */
interface FileData {
  filePath: string;
}

export interface TabTypeEntry {
  placement: Placement;
  scope: TabScope;
  mount: MountPolicy;
  multiplicity: Multiplicity;
  /** Shows one file from disk: carries its absolute path in `data.filePath`,
   *  sits in a file tab's frame (`file-tab-frame.tsx`), and gets the column's
   *  docked tree beside it (`file-dock.tsx`). */
  fileBacked: boolean;
  /** Its row in the ⌘T list; `null` when ⌘T does not offer it. Surfaces only
   *  (ADR-0024): the rail and ⌘K reach the destinations. */
  launcher: LauncherEntry | null;
  data: DataShape<object>;
}

export const TAB_REGISTRY = {
  // The session. Each one is its own tab, always in the main column, and it
  // stays mounted: remounting re-ran the "loading transcript" path and
  // rebuilt its scroll.
  chat: {
    placement: { kind: "session" },
    scope: "project",
    mount: "persistent",
    multiplicity: "per-id",
    fileBacked: false,
    launcher: { label: "Agent", key: "A", order: 0 },
    data: shape<NoData>(),
  },
  canvas: {
    placement: { kind: "destination" },
    scope: "project",
    mount: "active",
    multiplicity: "one",
    fileBacked: false,
    launcher: null,
    data: shape<NoData>(),
  },
  // Retired; a saved one still renders its placeholder.
  tasks: {
    placement: { kind: "surface", minWidth: 240 },
    scope: "project",
    mount: "active",
    multiplicity: "one-per-column",
    fileBacked: false,
    launcher: null,
    data: shape<NoData>(),
  },
  // One per FILE (id is `editor:<path>`). With no path, or an `untitled:`
  // one, an empty buffer that falls into save-as.
  editor: {
    placement: { kind: "surface", minWidth: 320 },
    scope: "project",
    mount: "persistent",
    multiplicity: "per-id",
    fileBacked: true,
    launcher: { label: "New file", key: "N", order: 2 },
    data: shape<{ filePath?: string; editing?: boolean }>(),
  },
  // The project tree: used while a session works, and a tree is a column's
  // natural shape, so a surface. One per project (these tabs are the
  // project's), wherever the open one is.
  files: {
    placement: { kind: "surface", minWidth: 240 },
    scope: "project",
    mount: "active",
    multiplicity: "one",
    fileBacked: false,
    launcher: { label: "Files", key: "F", order: 3 },
    data: shape<NoData>(),
  },
  knowledge: {
    placement: { kind: "destination" },
    scope: "project",
    mount: "active",
    multiplicity: "one",
    fileBacked: false,
    launcher: null,
    data: shape<NoData>(),
  },
  "knowledge-graph": {
    placement: { kind: "destination" },
    scope: "project",
    mount: "active",
    multiplicity: "one",
    fileBacked: false,
    launcher: null,
    data: shape<NoData>(),
  },
  memory: {
    placement: { kind: "destination" },
    scope: "project",
    mount: "active",
    multiplicity: "one",
    fileBacked: false,
    launcher: null,
    data: shape<NoData>(),
  },
  terminal: {
    placement: { kind: "surface", minWidth: 280 },
    scope: "project",
    mount: "persistent-idle-expensive",
    multiplicity: "one-per-column",
    fileBacked: false,
    launcher: { label: "Terminal", key: "T", order: 1 },
    data: shape<NoData>(),
  },
  // The working tree's changes (id is `diff:<repoPath>`). `file` is what the
  // retired standalone Git Diff module's tabs lack (`isRetiredTab`).
  diff: {
    placement: { kind: "surface", minWidth: 360 },
    scope: "project",
    mount: "active",
    multiplicity: "per-id",
    fileBacked: false,
    launcher: null,
    data: shape<{ repoPath: string; file?: unknown }>(),
  },
  // One per COMMIT (id is `commit:<repoPath>:<sha>`).
  commit: {
    placement: { kind: "surface", minWidth: 360 },
    scope: "project",
    mount: "active",
    multiplicity: "per-id",
    fileBacked: false,
    launcher: null,
    data: shape<{ repoPath: string; sha: string }>(),
  },
  // One per AGENT SESSION (id is `session-changes:<sessionId>`).
  "session-changes": {
    placement: { kind: "surface", minWidth: 320 },
    scope: "project",
    mount: "active",
    multiplicity: "per-id",
    fileBacked: false,
    launcher: null,
    data: shape<{ projectPath: string; sessionId: string }>(),
  },
  // One pull request (id is `pull-request:<repoPath>:<number>`): read and
  // acted on while the session that opened it works, and its header, Summary
  // and composer are built for a column. A restored tab's data is checked by
  // `readPullRequestTabData`, as the next two types' are by their readers.
  "pull-request": {
    placement: { kind: "surface", minWidth: 360 },
    scope: "project",
    mount: "active",
    multiplicity: "per-id",
    fileBacked: false,
    launcher: null,
    data: shape<{ repoPath: string; number: number; openedFrom?: string }>(),
  },
  // A repository's pull requests (id is `pull-requests:<repoPath>`): scanned
  // while a session works, to pick the next one to open beside it, and its
  // rows and filter bar fit a column.
  "pull-requests": {
    placement: { kind: "surface", minWidth: 360 },
    scope: "project",
    mount: "active",
    multiplicity: "per-id",
    fileBacked: false,
    launcher: { label: "Pull requests", key: "P", order: 5 },
    data: shape<{ repoPath: string }>(),
  },
  // One session's linked pull requests (id is
  // `session-pull-requests:<threadId>`): glanced at while that session works
  // (is the stack green, did review land), and a list of rows is a column's
  // natural shape.
  "session-pull-requests": {
    placement: { kind: "surface", minWidth: 320 },
    scope: "project",
    mount: "active",
    multiplicity: "per-id",
    fileBacked: false,
    launcher: null,
    data: shape<{ threadId: string; cwd: string | null }>(),
  },
  // One per window, wherever the open one is.
  "source-control": {
    placement: { kind: "surface", minWidth: 300 },
    scope: "project",
    mount: "active",
    multiplicity: "one",
    fileBacked: false,
    launcher: { label: "Source control", key: "G", order: 4 },
    data: shape<NoData>(),
  },
  log: {
    placement: { kind: "surface", minWidth: 300 },
    scope: "project",
    mount: "active",
    multiplicity: "one-per-column",
    fileBacked: false,
    launcher: { label: "Log", key: "L", order: 8 },
    data: shape<NoData>(),
  },
  // The file viewers, one per FILE each (id is `<type>:<path>`), so opening a
  // different file always gets its own tab.
  media: {
    placement: { kind: "surface", minWidth: 240 },
    scope: "project",
    mount: "active",
    multiplicity: "per-id",
    fileBacked: true,
    launcher: null,
    data: shape<FileData>(),
  },
  svg: {
    placement: { kind: "surface", minWidth: 240 },
    scope: "project",
    mount: "active",
    multiplicity: "per-id",
    fileBacked: true,
    launcher: null,
    data: shape<FileData>(),
  },
  pdf: {
    placement: { kind: "surface", minWidth: 320 },
    scope: "project",
    mount: "persistent-idle-expensive",
    multiplicity: "per-id",
    fileBacked: true,
    launcher: null,
    data: shape<FileData>(),
  },
  notebook: {
    placement: { kind: "surface", minWidth: 360 },
    scope: "project",
    mount: "active",
    multiplicity: "per-id",
    fileBacked: true,
    launcher: null,
    data: shape<FileData>(),
  },
  unsupported: {
    placement: { kind: "surface", minWidth: 240 },
    scope: "project",
    mount: "active",
    multiplicity: "per-id",
    fileBacked: true,
    launcher: null,
    data: shape<FileData>(),
  },
  usage: {
    placement: { kind: "destination" },
    scope: "organisation",
    mount: "active",
    multiplicity: "one",
    fileBacked: false,
    launcher: null,
    data: shape<NoData>(),
  },
  artifacts: {
    placement: { kind: "destination" },
    scope: "project",
    mount: "active",
    multiplicity: "one",
    fileBacked: false,
    launcher: null,
    data: shape<NoData>(),
  },
  // The Organisation's inbox: whose comments, on whose Sessions — no project.
  inbox: {
    placement: { kind: "destination" },
    scope: "projectless",
    mount: "active",
    multiplicity: "one",
    fileBacked: false,
    launcher: null,
    data: shape<NoData>(),
  },
  // The Organisation agent's full page: every conversation, or one given the
  // room. Its home is the side panel (`agent-panel`), which stays put while a
  // conversation is up here and says so — two types, not one dual one,
  // because a dual type LEAVES its column for its page (`org-agent.ts`).
  agent: {
    placement: { kind: "destination" },
    scope: "projectless",
    mount: "active",
    multiplicity: "one",
    fileBacked: false,
    launcher: null,
    data: shape<NoData>(),
  },
  // The Organisation agent at home: the side panel, its conversations as tabs
  // inside it. They keep their scroll and their half-typed questions across
  // tab switches, as team chat's do.
  "agent-panel": {
    placement: { kind: "surface", minWidth: 320 },
    scope: "window",
    mount: "persistent",
    multiplicity: "one",
    fileBacked: false,
    launcher: { label: "Ask Atlas", key: "O", order: 7 },
    data: shape<NoData>(),
  },
  // One per DRAFT (id is `comms-draft-<id>`): finding it by type would focus
  // draft A when asked to open draft B.
  "comms-draft": {
    placement: { kind: "surface", minWidth: 320 },
    scope: "organisation",
    mount: "active",
    multiplicity: "per-id",
    fileBacked: false,
    launcher: null,
    data: shape<{ convId: string; draftId: string }>(),
  },
  // A Space is per conversation, so another one replaces the one showing.
  spaces: {
    placement: { kind: "destination" },
    scope: "organisation",
    mount: "active",
    multiplicity: "per-id",
    fileBacked: false,
    launcher: null,
    data: shape<{ convId: string }>(),
  },
  // A surface beside a session (a reply while the agent works) and a
  // destination of its own (reading the team's conversations full width).
  // ADR-0024's 2026-10-24 amendment. An open conversation keeps its scroll
  // and its half-typed message across tab switches.
  "team-chat": {
    placement: { kind: "surface-or-destination", minWidth: 320 },
    scope: "window",
    mount: "persistent",
    multiplicity: "one",
    fileBacked: false,
    launcher: { label: "Team chat", key: "C", order: 6 },
    data: shape<NoData>(),
  },
} as const satisfies Record<string, TabTypeEntry>;

type Registry = typeof TAB_REGISTRY;

export type TabType = keyof Registry;

/** Every tab type, in the order the registry declares them. */
export const TAB_TYPES = Object.keys(TAB_REGISTRY) as readonly TabType[];

/** The entry for `type`, widened so a fact can be compared to any value. */
export function tabEntry(type: TabType): TabTypeEntry {
  return TAB_REGISTRY[type];
}

/** The tab types `test` holds for, in registry order, as a type-erased set. */
function typesWhere(test: (entry: TabTypeEntry) => boolean): ReadonlySet<TabType> {
  return new Set(TAB_TYPES.filter((type) => test(tabEntry(type))));
}

// ── Placement ────────────────────────────────────────────────────────────────

type PlacementKind<K extends TabType> = Registry[K]["placement"]["kind"];

/** The tab types that can show as a destination (only, or as one of two
 *  forms), as a type, so a map keyed by it (the destination screen's panels,
 *  their titles) must cover every one. */
export type DestinationType = {
  [K in TabType]: PlacementKind<K> extends "destination" | "surface-or-destination" ? K : never;
}[TabType];

/** The tab types that are only ever destinations: never a column's tab. */
export type DestinationOnlyType = {
  [K in TabType]: PlacementKind<K> extends "destination" ? K : never;
}[TabType];

/** The tab types that open in either form (`surface-or-destination`). */
export type DualPlacementType = {
  [K in TabType]: PlacementKind<K> extends "surface-or-destination" ? K : never;
}[TabType];

/** Where `type` opens. */
export function placementOf(type: TabType): Placement {
  return tabEntry(type).placement;
}

/** Whether `type` is the session: the one thing the main column holds. */
export function isSession(type: TabType): boolean {
  return placementOf(type).kind === "session";
}

/** Whether `type` can show on the destination screen, in either placement. */
export function isDestination(type: TabType): type is DestinationType {
  const kind = placementOf(type).kind;
  return kind === "destination" || kind === "surface-or-destination";
}

/** Whether `type` is only ever a destination: never in a column, never in
 *  the per-project editor state. What the layout store routes by. */
export function isDestinationOnly(type: TabType): type is DestinationOnlyType {
  return placementOf(type).kind === "destination";
}

/** Whether `type` opens in either form, by how it was opened. */
export function isDualPlacement(type: TabType): type is DualPlacementType {
  return placementOf(type).kind === "surface-or-destination";
}

/** The narrowest a column showing `type` may be, in CSS pixels; `null` for a
 *  type that never sits in a surfaces column. */
export function surfaceMinWidth(type: TabType): number | null {
  const p = placementOf(type);
  return p.kind === "surface" || p.kind === "surface-or-destination" ? p.minWidth : null;
}

// ── Scope ────────────────────────────────────────────────────────────────────

/** Tab types that work with NO project open. The projectless centre shell
 *  renders only these; the rest of a project's tabs stay in the store
 *  untouched and reappear when a project opens. */
export const PROJECTLESS_TYPES = typesWhere((e) => e.scope !== "project");

/** Tab types that belong to the WINDOW, not to a project (`TabScope`). */
export const WINDOW_TYPES = typesWhere((e) => e.scope === "window");

/** Tab types whose content belongs to one Organisation (`TabScope`).
 *  Settings is deliberately not one: it is projectless but org-agnostic. */
export const ORG_SCOPED_TYPES = typesWhere((e) => e.scope === "organisation");

// ── Mount policy ─────────────────────────────────────────────────────────────

/**
 * The types kept mounted across tab switches, as a type: `PersistentPanel`'s
 * `switch` is checked exhaustive against it, so giving a type a persistent
 * mount policy without giving it a `case` there is a COMPILE ERROR. That is
 * the point: with the literals erased, a missing branch fell through to the
 * terminal and mounted a PTY instead of the panel (how the Spaces tab
 * regressed in 32767aff8).
 */
export type PersistentTabType = {
  [K in TabType]: Registry[K]["mount"] extends "persistent" | "persistent-idle-expensive"
    ? K
    : never;
}[TabType];

/** Whether `type` stays mounted while another tab of its column shows. */
export function isPersistent(type: TabType): type is PersistentTabType {
  return tabEntry(type).mount !== "active";
}

/** Whether `type` is unmounted in a background project (`MountPolicy`). */
export function isIdleExpensive(type: TabType): boolean {
  return tabEntry(type).mount === "persistent-idle-expensive";
}

// ── Multiplicity ─────────────────────────────────────────────────────────────

/** How `addTab` finds the open tab of `type` (`Multiplicity`). */
export function multiplicityOf(type: TabType): Multiplicity {
  return tabEntry(type).multiplicity;
}

// ── File tabs ────────────────────────────────────────────────────────────────

/** The tab types that show one file from disk. */
export type FileTabType = {
  [K in TabType]: Registry[K]["fileBacked"] extends true ? K : never;
}[TabType];

const FILE_TAB_TYPES: ReadonlySet<string> = typesWhere((e) => e.fileBacked);

/** Whether `type` shows one file from disk. Takes any string: callers hold
 *  saved tabs too, whose type may be one this build no longer knows. */
export function isFileTab(type: string): type is FileTabType {
  return FILE_TAB_TYPES.has(type);
}

/** The absolute path of the file `tab` shows; `null` for a tab that is not a
 *  file tab, or a file tab with no path yet. */
export function fileTabPath(tab: { type: string; data: Record<string, unknown> }): string | null {
  return isFileTab(tab.type) && typeof tab.data.filePath === "string" ? tab.data.filePath : null;
}

// ── The launcher ─────────────────────────────────────────────────────────────

/** The tab types ⌘T offers, as a type. */
export type LauncherType = {
  [K in TabType]: Registry[K]["launcher"] extends null ? never : K;
}[TabType];

/** The ⌘T list's rows, in the order it shows them. */
export const LAUNCHER_ENTRIES: readonly (LauncherEntry & { type: LauncherType })[] =
  TAB_TYPES.flatMap((type) => {
    const launcher = tabEntry(type).launcher;
    return launcher ? [{ ...launcher, type: type as LauncherType }] : [];
  }).sort((a, b) => a.order - b.order);

// ── Data ─────────────────────────────────────────────────────────────────────

/** What a tab of type `K` carries in `data`. */
export type TabData<K extends TabType> = Registry[K]["data"] extends DataShape<infer T> ? T : never;

/** `T` with its `type` pinned to one tab type and its `data` typed to match:
 *  a union over `T`'s types, so narrowing `type` narrows `data`. */
export type TypedTab<T extends { type: TabType }> = {
  [K in T["type"]]: Omit<T, "type" | "data"> & { type: K; data: TabData<K> };
}[T["type"]];

/**
 * `tab`, with its `data` typed by its `type`: `switch (t.type)` then reads
 * `t.data.filePath` with no cast. The one place the registry's shapes are
 * laid over a tab's stored data.
 *
 * It asserts and does not check. `data` is persisted, so a tab restored from
 * an older build can carry anything; a reader that must survive that
 * validates instead (`readPullRequestTabData`, `fileTabPath`).
 */
export function typedTab<T extends { type: TabType; data: Record<string, unknown> }>(
  tab: T,
): TypedTab<T> {
  return tab as unknown as TypedTab<T>;
}

// ── Renamed types ────────────────────────────────────────────────────────────

/**
 * Tab types that were renamed. Persisted layout / editor state written by an
 * older build still carries the old name; `migrateTabType` maps it forward so
 * the tab comes back instead of being dropped as unknown.
 */
export const LEGACY_TAB_TYPES: Record<string, TabType> = { "mission-control": "usage" };

/** The current name for a stored tab type: the mapped type for a legacy name,
 *  the type itself when it is still valid, `null` when it is neither. */
export function migrateTabType(type: string): TabType | null {
  const legacy = LEGACY_TAB_TYPES[type];
  if (legacy) return legacy;
  return (TAB_TYPES as readonly string[]).includes(type) ? (type as TabType) : null;
}
