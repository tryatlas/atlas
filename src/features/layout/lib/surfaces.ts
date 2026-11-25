import type { ElementType } from "react";
import {
  Code,
  FolderTree,
  GitBranch,
  GitPullRequest,
  MessagesSquare,
  ScrollText,
  Terminal,
} from "lucide-react";
import { AgentIcon } from "@/features/org-agent/lib/agent-icon";
import { AtlasIcon } from "@/components/brand-marks";
import { LAUNCHER_ENTRIES, multiplicityOf, type LauncherType } from "@/lib/tab-registry";
import { useLayoutStore } from "../stores/layout-store";
import {
  currentRepoPath,
  openPullRequestListTab,
} from "@/features/pull-requests/lib/open-pull-request-list-tab";

/**
 * What a split column can open: the `+` menu and the "Open a surface" launcher
 * an empty column shows. One list, so the two
 * can never offer different things.
 *
 * `key` is a bare letter. It is the hint shown beside each row AND the key that
 * picks it — inside the open `+` menu, and anywhere while a focused column is
 * showing the launcher — so `⌘T` then `A` is a new agent (which opens in the
 * session column, like every session), `⌘T` then `T` a terminal. The hint and the match read the same field, so they cannot drift.
 *
 * Surfaces only (ADR-0024): Knowledge, Memory, Spaces and the other
 * destinations take the window, so they are not offered as a column's tab
 * (`tab-placement-contract.test.ts`). The rail and ⌘K reach them.
 *
 * A row is a tab type's `launcher` entry in the tab registry
 * (`@/lib/tab-registry`); what opening one does is `openSurface`, below.
 */
export interface Surface {
  type: LauncherType;
  label: string;
  icon: ElementType;
  key: string;
}

/** Each row's icon: the one its tab shows (`tabIcons` in `pane-tab.tsx`).
 *  Here and not in the registry, which holds no React. Keyed by the types
 *  whose registry entry has a `launcher`, so offering a new one does not
 *  compile until it has an icon. */
const SURFACE_ICONS: Record<LauncherType, ElementType> = {
  chat: AtlasIcon,
  terminal: Terminal,
  editor: Code,
  files: FolderTree,
  "source-control": GitBranch,
  "pull-requests": GitPullRequest,
  "team-chat": MessagesSquare,
  "agent-panel": AgentIcon,
  log: ScrollText,
};

/** The rows, from the tab registry: a type is offered when its entry has a
 *  `launcher`, in that entry's `order`. */
export const SURFACES: readonly Surface[] = LAUNCHER_ENTRIES.map(({ type, label, key }) => ({
  type,
  label,
  icon: SURFACE_ICONS[type],
  key,
}));

/** Open `surface` as a new tab in split column `groupId`. */
export function openSurface(surface: Surface, groupId: string): void {
  const { addTab } = useLayoutStore.getState().actions;
  const ts = Date.now();
  if (surface.type === "editor") {
    // The synthetic `untitled:<ts>` path starts the editor on an empty buffer
    // that falls into save-as on ⌘S (see `editor-panel.tsx`).
    addTab(
      {
        id: `editor-untitled-${ts}`,
        type: "editor",
        title: "Untitled",
        closable: true,
        dirty: false,
        data: { filePath: `untitled:${ts}` },
      },
      groupId,
    );
    return;
  }
  if (surface.type === "pull-requests") {
    // One list per checkout: the open project's.
    const repoPath = currentRepoPath();
    if (repoPath) openPullRequestListTab({ repoPath, groupId });
    return;
  }
  addTab(
    {
      // A type the window holds one of goes by its type: `addTab` focuses
      // the open one wherever it is.
      id: multiplicityOf(surface.type) === "one" ? surface.type : `${surface.type}-${ts}`,
      type: surface.type,
      title: surface.type === "chat" ? "Agents" : surface.label,
      closable: true,
      dirty: false,
      data: {},
    },
    groupId,
  );
}

/**
 * The surface a key press picks: a bare letter, no modifiers, not mid-IME
 * composition. Shared by the `+` menu and the launcher.
 */
export function surfaceForKey(e: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}): Surface | null {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return null;
  const key = e.key.toLowerCase();
  return SURFACES.find((s) => s.key.toLowerCase() === key) ?? null;
}
