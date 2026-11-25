// @vitest-environment happy-dom
import { createElement, type ReactNode } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Guards the column's render path: which panel each tab type mounts, and
 * which panels stay mounted (`tab-panels.tsx`, `tab-content-container.tsx`).
 *
 * HISTORY. `TabContentContainer` used to mount persistent tab types through an
 * if/else-if chain keyed on `tab.type` that ended in an unconditional
 * `<TerminalPanel/>` fallback. `tsc` could not catch a missing branch there:
 * `tab.type` was typed as the full `TabType` union in every arm, so every
 * branch — including the fallback — type-checked whether or not it was the
 * *right* component. A type added to the persistent list without a branch
 * did not fail to compile and did not throw; it silently fell into the
 * terminal branch and spawned a real PTY keyed to that tab's id.
 *
 * This shipped. Commit 32767aff8 ("comms UI update", 2026-09-11) made
 * `"spaces"` persistent and idle-expensive but never added a matching branch,
 * so opening a Space in alpha-0.3.2 mounted PowerShell inside a tab titled
 * "… — Space". Fixed by 1322c8f2.
 *
 * NOW. Whether a type stays mounted is its `mount` policy in the tab registry
 * (`@/lib/tab-registry`). `PersistentTabType` is derived from those entries,
 * `persistentTabs` is narrowed to it by a type predicate, and `PersistentPanel`
 * is a `switch` whose `default` assigns the tab to `never`. A missing case is
 * a COMPILE ERROR, which is a stronger guarantee than anything here.
 *
 * What the type system still cannot see is that a case mounts the RIGHT
 * panel, so this suite renders. The panels are replaced by markers (the real
 * ones are the whole lazy-loaded panel tree and every store it touches), and
 * the switches and the keep-mounted logic are the real ones:
 *
 *   1. every tab type mounts its own panel, by a table written out below: a
 *      terminal is mounted for a terminal tab and for nothing else, so the
 *      `switch` has not been reshaped back into a catch-all;
 *   2. a persistent type's panel stays mounted (the same DOM node, hidden)
 *      when another tab of its column shows, and an `active` one unmounts;
 *   3. in a background project the idle-expensive types unmount and the
 *      other persistent ones stay.
 *
 * The idle-expensive types being a subset of the persistent ones, which this
 * suite used to assert, is now one field's three values and cannot be
 * otherwise. `src/lib/tab-registry.test.ts` holds the lists themselves.
 */

const { panel, passthrough } = vi.hoisted(() => ({
  /** A module whose `name` export renders a marker instead of the panel. */
  panel: (name: string, marker: string) => async () => {
    const react = await import("react");
    return { [name]: () => react.createElement("div", { "data-panel": marker }) };
  },
  /** A module whose `name` export renders only its children. */
  passthrough: (name: string) => async () => {
    const react = await import("react");
    return {
      [name]: (props: { children?: ReactNode }) =>
        react.createElement(react.Fragment, null, props.children),
    };
  },
}));

vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));

vi.mock("@/features/chat/components/chat-panel", panel("ChatPanel", "chat"));
vi.mock("@/features/terminal/components/terminal-panel", panel("TerminalPanel", "terminal"));
vi.mock("@/features/editor/components/editor-panel", panel("EditorPanel", "editor"));
vi.mock("@/features/media/components/media-viewer", panel("MediaViewer", "media"));
vi.mock("@/features/svg/components/svg-viewer", panel("SvgViewer", "svg"));
vi.mock("@/features/pdf/components/pdf-viewer", panel("PdfViewer", "pdf"));
vi.mock("@/features/notebook/components/notebook-viewer", panel("NotebookViewer", "notebook"));
vi.mock(
  "@/features/unsupported/components/unsupported-file",
  panel("UnsupportedFile", "unsupported"),
);
vi.mock("@/features/comms/components/comms-draft-tab", panel("CommsDraftTab", "comms-draft"));
vi.mock("@/features/comms/components/comms-panel", panel("CommsPanel", "comms"));
vi.mock("@/features/git/components/commit-view", panel("CommitView", "commit"));
vi.mock("@/features/git/components/diff-viewer/review-panel", panel("ReviewPanel", "review"));
vi.mock(
  "@/features/git/components/source-control-panel",
  panel("SourceControlPanel", "source-control"),
);
vi.mock(
  "@/features/pull-requests/components/pull-request-panel",
  panel("PullRequestPanel", "pull-request"),
);
vi.mock(
  "@/features/pull-requests/components/pull-request-list-panel",
  panel("PullRequestListPanel", "pull-requests"),
);
vi.mock(
  "@/features/pull-requests/components/session-pull-requests-panel",
  panel("SessionPullRequestsPanel", "session-pull-requests"),
);
vi.mock("@/features/explorer/components/files-panel", panel("FilesPanel", "files"));
vi.mock(
  "@/features/org-agent/components/org-agent-side-panel",
  panel("OrgAgentSidePanel", "org-agent"),
);
vi.mock("@/features/log/components/log-panel", panel("LogPanel", "log"));
vi.mock(
  "@/features/layout/components/views/placeholder-content",
  panel("PlaceholderContent", "placeholder"),
);
vi.mock("@/features/layout/components/surface-launcher", panel("SurfaceLauncher", "launcher"));
vi.mock("@/features/explorer/components/file-tab-frame", passthrough("FileTabFrame"));
vi.mock("@/features/explorer/components/file-dock", passthrough("FileDockColumn"));

import { TabContentContainer } from "@/features/layout/components/tab-content-container";
import type { ProjectView, Tab } from "@/features/layout/stores/layout-store";
import {
  TAB_TYPES,
  isIdleExpensive,
  isPersistent,
  type PersistentTabType,
  type TabType,
} from "@/lib/tab-registry";

/**
 * The marker each tab type's panel leaves in a column. A `Record`, so a new
 * tab type does not compile until its row says what it mounts.
 *
 * A destination has no panel here: it never enters a column (ADR-0024), and a
 * saved one that did would show the placeholder.
 */
const MOUNTS: Record<TabType, string> = {
  chat: "chat",
  canvas: "placeholder",
  tasks: "placeholder",
  editor: "editor",
  files: "files",
  knowledge: "placeholder",
  "knowledge-graph": "placeholder",
  memory: "placeholder",
  terminal: "terminal",
  diff: "review",
  commit: "commit",
  "session-changes": "review",
  "pull-request": "pull-request",
  "pull-requests": "pull-requests",
  "session-pull-requests": "session-pull-requests",
  "source-control": "source-control",
  log: "log",
  media: "media",
  svg: "svg",
  pdf: "pdf",
  notebook: "notebook",
  unsupported: "unsupported",
  usage: "placeholder",
  artifacts: "placeholder",
  inbox: "placeholder",
  agent: "placeholder",
  "agent-panel": "org-agent",
  "comms-draft": "comms-draft",
  spaces: "placeholder",
  "team-chat": "comms",
};

/** The persistent types, by name: a new one does not compile until it is
 *  listed, and so rendered by the keep-mounted tests below. */
const PERSISTENT: Record<PersistentTabType, true> = {
  chat: true,
  editor: true,
  terminal: true,
  pdf: true,
  "agent-panel": true,
  "team-chat": true,
};
const PERSISTENT_TYPES = Object.keys(PERSISTENT) as PersistentTabType[];

/** Data a restored tab of each type would carry, so no panel falls back to
 *  the placeholder for want of it. */
const DATA: Partial<Record<TabType, Record<string, unknown>>> = {
  editor: { filePath: "/p/a.ts" },
  media: { filePath: "/p/a.png" },
  svg: { filePath: "/p/a.svg" },
  pdf: { filePath: "/p/a.pdf" },
  notebook: { filePath: "/p/a.ipynb" },
  unsupported: { filePath: "/p/a.bin" },
  diff: { repoPath: "/p" },
  commit: { repoPath: "/p", sha: "abc" },
  "session-changes": { projectPath: "/p", sessionId: "s" },
  "pull-request": { repoPath: "/p", number: 7 },
  "pull-requests": { repoPath: "/p" },
  "session-pull-requests": { threadId: "t", cwd: "/p" },
  "comms-draft": { convId: "c", draftId: "d" },
};

const GROUP = "g2";

const tab = (type: TabType): Tab => ({
  id: `${type}-1`,
  type,
  title: type,
  closable: true,
  dirty: false,
  data: DATA[type] ?? {},
  groupId: GROUP,
});

const view = (tabs: Tab[], active: string): ProjectView => ({
  tabs,
  activeTabId: active,
  groupOrder: ["main", GROUP],
  activeByGroup: { [GROUP]: active },
  focusedGroupId: GROUP,
  tabHistory: [],
  tabHistoryIndex: 0,
});

const column = (tabs: Tab[], active: string, projectActive = true) =>
  createElement(TabContentContainer, {
    groupId: GROUP,
    view: view(tabs, active),
    isActive: projectActive,
    projectId: "p",
  });

const markers = (root: HTMLElement) =>
  [...root.querySelectorAll("[data-panel]")].map((el) => el.getAttribute("data-panel"));

const node = (root: HTMLElement, marker: string) => root.querySelector(`[data-panel="${marker}"]`);

afterEach(cleanup);

describe("the column's render contract", () => {
  it("covers every tab type (a floor, so the tables cannot pass empty)", () => {
    expect(Object.keys(MOUNTS).sort()).toEqual([...TAB_TYPES].sort());
    expect(TAB_TYPES.length).toBeGreaterThanOrEqual(30);
    expect(PERSISTENT_TYPES.sort()).toEqual(TAB_TYPES.filter(isPersistent).sort());
    expect(PERSISTENT_TYPES.length).toBeGreaterThanOrEqual(5);
  });

  for (const type of TAB_TYPES) {
    it(`${type}: mounts its own panel, and a terminal only for a terminal`, async () => {
      const { container } = render(column([tab(type)], `${type}-1`));
      await waitFor(() => expect(markers(container)).toEqual([MOUNTS[type]]));
      // A catch-all terminal is how a Space tab spawned a PTY in alpha-0.3.2.
      expect(markers(container).includes("terminal")).toBe(type === "terminal");
    });
  }

  it("keeps every persistent type mounted when another tab of the column shows", async () => {
    const tabs = [...PERSISTENT_TYPES.map(tab), tab("log"), tab("commit")];
    const { container, rerender } = render(column(tabs, "log-1"));

    // Hidden behind the log: every persistent panel, and nothing else. The
    // commit tab is neither active nor persistent, so it has no panel.
    const kept = [...PERSISTENT_TYPES.map((t) => MOUNTS[t]), "log"].sort();
    await waitFor(() => expect(markers(container).sort()).toEqual(kept));
    const before = new Map(PERSISTENT_TYPES.map((t) => [t, node(container, MOUNTS[t])]));

    // Another tab shows: the log's panel goes, the commit's comes, and each
    // persistent panel is the SAME node, so it was never remounted.
    rerender(column(tabs, "commit-1"));
    await waitFor(() => expect(node(container, "commit")).not.toBeNull());
    expect(node(container, "log")).toBeNull();
    for (const type of PERSISTENT_TYPES) {
      expect(node(container, MOUNTS[type]), type).toBe(before.get(type));
    }

    // And when one of them shows, the rest stay as they were.
    rerender(column(tabs, "editor-1"));
    await waitFor(() => expect(node(container, "commit")).toBeNull());
    for (const type of PERSISTENT_TYPES) {
      expect(node(container, MOUNTS[type]), type).toBe(before.get(type));
    }
  });

  it("in a background project, unmounts the idle-expensive types and keeps the rest", async () => {
    const tabs = [...PERSISTENT_TYPES.map(tab), tab("log")];
    const { container, rerender } = render(column(tabs, "log-1"));
    await waitFor(() => expect(markers(container)).toHaveLength(tabs.length));
    const before = new Map(PERSISTENT_TYPES.map((t) => [t, node(container, MOUNTS[t])]));

    rerender(column(tabs, "log-1", false));
    const idle = PERSISTENT_TYPES.filter(isIdleExpensive);
    // A PTY, a web embed, a PDF worker: the ones that burn while hidden.
    expect(idle.length).toBeGreaterThanOrEqual(2);
    await waitFor(() => {
      for (const type of idle) expect(node(container, MOUNTS[type]), type).toBeNull();
    });
    for (const type of PERSISTENT_TYPES.filter((t) => !isIdleExpensive(t))) {
      expect(node(container, MOUNTS[type]), type).toBe(before.get(type));
    }
  });
});
