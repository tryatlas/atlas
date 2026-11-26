import { lazy } from "react";
import type { Tab } from "../stores/layout-store";
// Chat is the default landing surface — always loaded so the first paint
// shows the agent UI without a Suspense flash.
import { ChatPanel } from "@/features/chat/components/chat-panel";
import { UnsupportedFile } from "@/features/unsupported/components/unsupported-file";
import { FileTabFrame } from "@/features/explorer/components/file-tab-frame";
import { readPullRequestTabData } from "@/features/pull-requests/lib/open-pull-request-tab";
import { readPullRequestListTabData } from "@/features/pull-requests/lib/open-pull-request-list-tab";
import { readSessionPullRequestsTabData } from "@/features/pull-requests/lib/open-session-pull-requests-tab";
import { fileTabPath, typedTab, type PersistentTabType } from "@/lib/tab-registry";
import { PlaceholderContent } from "./views/placeholder-content";

/*
 * Every tab type's panel: its lazy import and its render branch. What a type
 * IS lives in the tab registry (`@/lib/tab-registry`), which stays free of
 * React so the layout store can import it; this file is the registry's React
 * half. A new tab type adds its lazy import here and a `case` in `TabContent`
 * or, if its registry entry keeps it mounted across tab switches, in
 * `PersistentPanel`, where `tsc` demands it. `center-panel.tsx` lays out the
 * columns that host these; `tab-content-container.tsx` decides which mount.
 */

// Every other tab type is lazy. Editor/Terminal in particular pull in
// CodeMirror+Lezer (~600 KB) and xterm (~250 KB) respectively — keeping
// them eager added multi-second parse cost to cold start on machines that
// don't have them in the OS file cache yet. The Suspense fallback in the
// tab content area absorbs the brief load.
const TerminalPanel = lazy(() =>
  import("@/features/terminal/components/terminal-panel").then((m) => ({
    default: m.TerminalPanel,
  })),
);
const EditorPanel = lazy(() =>
  import("@/features/editor/components/editor-panel").then((m) => ({ default: m.EditorPanel })),
);
const MediaViewer = lazy(() =>
  import("@/features/media/components/media-viewer").then((m) => ({ default: m.MediaViewer })),
);
const SvgViewer = lazy(() =>
  import("@/features/svg/components/svg-viewer").then((m) => ({ default: m.SvgViewer })),
);
const CommsDraftTab = lazy(() =>
  import("@/features/comms/components/comms-draft-tab").then((m) => ({
    default: m.CommsDraftTab,
  })),
);
const PdfViewer = lazy(() =>
  import("@/features/pdf/components/pdf-viewer").then((m) => ({ default: m.PdfViewer })),
);
const NotebookViewer = lazy(() =>
  import("@/features/notebook/components/notebook-viewer").then((m) => ({
    default: m.NotebookViewer,
  })),
);
const CommitView = lazy(() =>
  import("@/features/git/components/commit-view").then((m) => ({ default: m.CommitView })),
);
// One pull request (`pull-request:<checkout>:<number>`); its own chunk.
const PullRequestPanel = lazy(() =>
  import("@/features/pull-requests/components/pull-request-panel").then((m) => ({
    default: m.PullRequestPanel,
  })),
);
// A repository's pull requests (`pull-requests:<checkout>`); its own chunk.
const PullRequestListPanel = lazy(() =>
  import("@/features/pull-requests/components/pull-request-list-panel").then((m) => ({
    default: m.PullRequestListPanel,
  })),
);
// One session's linked pull requests (`session-pull-requests:<threadId>`);
// its own chunk.
const SessionPullRequestsPanel = lazy(() =>
  import("@/features/pull-requests/components/session-pull-requests-panel").then((m) => ({
    default: m.SessionPullRequestsPanel,
  })),
);
// The review diff (`diff`, `session-changes`). Its own chunk, which is the only
// thing that imports the diff viewer, Shiki and their workers.
const ReviewPanel = lazy(() =>
  import("@/features/git/components/diff-viewer/review-panel").then((m) => ({
    default: m.ReviewPanel,
  })),
);
// The project tree as a surface of its own (`files-surface.ts`).
const FilesPanel = lazy(() =>
  import("@/features/explorer/components/files-panel").then((m) => ({
    default: m.FilesPanel,
  })),
);
const SourceControlPanel = lazy(() =>
  import("@/features/git/components/source-control-panel").then((m) => ({
    default: m.SourceControlPanel,
  })),
);
// Team chat is a surface tab (ADR-0024); it used to be the right slot.
const OrgAgentSidePanel = lazy(() =>
  import("@/features/org-agent/components/org-agent-side-panel").then((m) => ({
    default: m.OrgAgentSidePanel,
  })),
);
const CommsPanel = lazy(() =>
  import("@/features/comms/components/comms-panel").then((m) => ({ default: m.CommsPanel })),
);
const LogPanel = lazy(() =>
  import("@/features/log/components/log-panel").then((m) => ({ default: m.LogPanel })),
);

export const GROUP_OF = (t: Tab) => t.groupId ?? "main";
/** A tab whose registry entry keeps it mounted across tab switches. */
export type PersistentTab = Tab & { type: PersistentTabType };

/**
 * Mounts one persistent tab's panel.
 *
 * A `switch` with a `never` default, NOT an if/else-if chain with a catch-all.
 * The chain this replaced ended in an unconditional `<TerminalPanel/>`, and
 * because `tab.type` was the full `TabType` union in every arm, a persistent
 * type with no branch of its own type-checked perfectly and quietly rendered a
 * terminal — spawning a real PTY keyed to that tab's id. That shipped: a Space
 * tab mounted PowerShell in alpha-0.3.2. Here `tab.type` is narrowed to
 * `PersistentTabType`, so omitting a case fails `tsc` at `_exhaustive`.
 */
export function PersistentPanel({
  tab,
  projectId,
  height,
}: {
  tab: PersistentTab;
  projectId: string;
  height: number;
}) {
  const t = typedTab(tab);
  switch (t.type) {
    case "editor":
      return (
        <FileTabFrame tabId={tab.id} projectId={projectId} filePath={t.data.filePath} ownHeader>
          <EditorPanel tabId={tab.id} filePath={t.data.filePath} containerHeight={height} />
        </FileTabFrame>
      );
    case "pdf":
      return (
        <FileTabFrame tabId={tab.id} projectId={projectId} filePath={t.data.filePath}>
          <PdfViewer filePath={t.data.filePath} tabId={tab.id} />
        </FileTabFrame>
      );
    case "team-chat":
      return <CommsPanel />;
    case "agent-panel":
      return <OrgAgentSidePanel />;
    // Chat is normally handled by the caller, which needs its own
    // `visibility:hidden` wrapper rather than `display:none`. Listed anyway so
    // the exhaustiveness check below is real and not a hole.
    case "chat":
      return <ChatPanel tabId={tab.id} />;
    case "terminal":
      return <TerminalPanel tabId={tab.id} projectId={projectId} />;
    default: {
      const _exhaustive: never = t;
      void _exhaustive;
      return <PlaceholderContent tab={tab} />;
    }
  }
}

export function TabContent({ tab, projectId = null }: { tab: Tab; projectId?: string | null }) {
  // A file tab sits in its frame: the header band, and room for the column's
  // docked project tree (`file-tab-frame.tsx`, `file-dock.tsx`).
  const framed = (content: React.ReactNode) => (
    <FileTabFrame tabId={tab.id} projectId={projectId} filePath={fileTabPath(tab) ?? undefined}>
      {content}
    </FileTabFrame>
  );
  const t = typedTab(tab);
  switch (t.type) {
    case "chat":
      return <ChatPanel tabId={tab.id} />;
    case "log":
      return <LogPanel />;
    case "source-control":
      return <SourceControlPanel />;
    case "files":
      return <FilesPanel projectId={projectId} />;
    case "media":
      return framed(<MediaViewer filePath={t.data.filePath} />);
    case "svg":
      return framed(<SvgViewer filePath={t.data.filePath} />);
    case "pdf":
      return framed(<PdfViewer filePath={t.data.filePath} tabId={tab.id} />);
    case "notebook":
      return framed(<NotebookViewer filePath={t.data.filePath} />);
    case "diff":
      return <ReviewPanel tabId={tab.id} repoPath={t.data.repoPath} />;
    case "commit":
      return <CommitView repoPath={t.data.repoPath} sha={t.data.sha} />;
    case "pull-request": {
      const pr = readPullRequestTabData(tab.data);
      return pr ? (
        <PullRequestPanel tabId={tab.id} repoPath={pr.repoPath} number={pr.number} />
      ) : (
        <PlaceholderContent tab={tab} />
      );
    }
    case "pull-requests": {
      const list = readPullRequestListTabData(tab.data);
      return list ? (
        <PullRequestListPanel repoPath={list.repoPath} />
      ) : (
        <PlaceholderContent tab={tab} />
      );
    }
    case "session-pull-requests": {
      const session = readSessionPullRequestsTabData(tab.data);
      return session ? (
        <SessionPullRequestsPanel tabId={tab.id} threadId={session.threadId} cwd={session.cwd} />
      ) : (
        <PlaceholderContent tab={tab} />
      );
    }
    case "session-changes":
      return (
        <ReviewPanel tabId={tab.id} repoPath={t.data.projectPath} sessionId={t.data.sessionId} />
      );
    case "comms-draft":
      return <CommsDraftTab convId={t.data.convId} draftId={t.data.draftId} />;
    case "unsupported":
      return framed(<UnsupportedFile filePath={t.data.filePath} />);
    default:
      return <PlaceholderContent tab={tab} />;
  }
}
