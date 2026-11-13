// The app's one left sidebar: full height, from the window's top edge to its
// bottom, with the window's corner — traffic lights, dev badge, the sidebar
// toggle — as its top row. Under that, the project picker (the organisation
// sits at the foot of its menu) with Add project beside it, Team chat and
// Timeline, the sessions, and last a dock of icons — Memory, Knowledge, Source
// control, Usage — and the notification bell. Search (the command palette)
// sits in the corner beside the sidebar toggle. The account is the title bar's last
// control (`TopbarTrailing`), not the sidebar's.
//
// Closed, it is gone: no rail of icons stays behind. The corner moves to the
// leftmost column header at the same pixels (`CornerCluster`), so the toggle
// never jumps, and resting on the window's left edge or the toggle peeks the
// sidebar over the session (`SidebarPeek`) for a destination or a session
// without docking it. ⌘K reaches everything here too.
//
// It replaced two columns — the project rail (projects, a recent-sessions
// list, the module navigation) and the session sidebar beside each chat — so
// a session is found in one place whichever project it belongs to. Projects
// are the picker's scope and a badge on each row; Members is in the
// organisation menu (the picker's Organization submenu, and the title bar's
// breadcrumb); Agents is in Settings.
//
// Docking and hiding do not animate: the toggle is a shortcut pressed many
// times a day. Only the peek slides, because it comes and goes under the
// pointer and has to read as laid over the session rather than replacing it.
//
// The look is the package's (`SessionSidebar` and its parts in
// `@tryatlas/design`), so the web app can draw the same sidebar over its own
// data. What is Atlas's stays here: the window's corner and its drag, the
// stores each slot reads, and the peek's timing (`sidebar-peek.ts`).

import { useEffect, useRef } from "react";
import {
  SessionSidebar,
  SessionSidebarDestinations,
  SessionSidebarDock,
  SessionSidebarPeek,
} from "@tryatlas/design";
import { CornerCluster, useWindowDrag } from "@/components/titlebar";
import {
  KnowledgeButton,
  MemoryButton,
  NotificationsButton,
  SourceControlButton,
  AgentButton,
  InboxButton,
  TeamChatButton,
  TimelineButton,
  UsageButton,
} from "./sidebar-destinations";
import { SidebarProjectPicker } from "./project-picker";
import { SidebarSessions } from "./sidebar-session-list";
import { GetStarted } from "@/features/tips/components/get-started";
import {
  endPeek,
  holdPeek,
  releasePeek,
  requestPeek,
  setPeekPanel,
  useSidebarPeek,
} from "../lib/sidebar-peek";

export function AppSidebar({ className }: { className?: string }) {
  const drag = useWindowDrag();
  return (
    <SessionSidebar
      // The surface's divider and highlight are desktop's
      // (`[data-slot="session-sidebar"]` in globals.css).
      className={className}
      header={
        // The window's corner. Every stretch of it drags the window.
        <div {...drag} className="flex h-titlebar shrink-0 select-none items-center">
          <CornerCluster search />
        </div>
      }
      picker={<SidebarProjectPicker />}
      destinations={
        <SessionSidebarDestinations>
          <InboxButton />
          <TeamChatButton />
          <TimelineButton />
          <AgentButton />
        </SessionSidebarDestinations>
      }
      footer={
        // Memory, the open project's views (greyed, saying why, with none
        // open), Usage, and the notification bell at the far end.
        <SessionSidebarDock trailing={<NotificationsButton iconOnly round />}>
          <MemoryButton iconOnly round />
          <KnowledgeButton iconOnly round />
          <SourceControlButton iconOnly round />
          <UsageButton iconOnly round />
        </SessionSidebarDock>
      }
    >
      <SidebarSessions />
      <GetStarted />
    </SessionSidebar>
  );
}

/**
 * The closed sidebar: a strip along the window's left edge that peeks it,
 * and the peek itself — the same sidebar, over the session, at the same width
 * and place it docks to. Timing is `sidebar-peek.ts`'s.
 */
export function SidebarPeek() {
  const open = useSidebarPeek.use.open();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPeekPanel(panelRef.current);
    return () => setPeekPanel(null);
  }, [open]);

  // Escape closes it; leaving it open behind a docked sidebar would not.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) endPeek();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Gone with the component: docking the sidebar unmounts this.
  useEffect(() => endPeek, []);

  return (
    <SessionSidebarPeek
      open={open}
      panelRef={panelRef}
      onRequest={requestPeek}
      onHold={holdPeek}
      onRelease={releasePeek}
      // Below the title bar, so the edge never sits on the traffic lights.
      edgeClassName="top-[var(--titlebar-height)]"
    >
      <AppSidebar />
    </SessionSidebarPeek>
  );
}
