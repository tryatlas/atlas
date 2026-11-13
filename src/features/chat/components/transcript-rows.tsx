// Desktop's half of the transcript's rows.
//
// The rows themselves are `@tryatlas/design/session`'s: props-only views the
// web app renders too. What they need from desktop arrives through one
// `TranscriptProvider` value, built here: the markdown pipeline (the parse
// cache, the worker, file chips), the actions under a message, comment pills,
// the changed-files card, and what a click on a tool line or a subagent opens.
//
// House rules the rows keep, all of which exist to keep the thread quiet and
// cheap to scroll:
//
//  1. No element grows on hover or on load. Anything expandable either toggles
//     via row state (which reflows once, deliberately) or opens the detail
//     panel. Diffs and tool output are the panel's job, never the thread's —
//     that is what keeps a turn's cost bounded no matter what the agent did.
//  2. The only things with colour are diff counts, the running-state glyph, and
//     the turn footer's primary action. Everything else is foreground/muted
//     grey. Per-tool icon SHAPES are fine; per-tool icon COLOURS are the
//     "moving blocks" problem in a new costume, and are the thing to resist.
//  3. Rows never subscribe to the chat store or the detail-panel store. Data
//     arrives as props; actions are fired imperatively via `getState()`. The
//     components below are the only desktop code a row runs, and each reads
//     only its own small slice (a comment count, the session's room).

import { createContext, memo, useContext, useMemo, type ReactNode } from "react";
import {
  TranscriptProvider,
  type MarkerRow,
  type SubagentRow,
  type TranscriptChangedFilesProps,
  type TranscriptCommentPillProps,
  type TranscriptContextValue,
  type TranscriptGroupCommentPillProps,
  type TranscriptImagesProps,
  type TranscriptMarkdownProps,
  type TranscriptRemoteAuthorProps,
  type TranscriptResponseActionsProps,
  type TranscriptUserActionsProps,
} from "@tryatlas/design/session";
import { CachedMarkdown } from "@/lib/markdown-cache";
import { formatTime } from "@/lib/format-time";
import { openDetail } from "../stores/detail-panel-store";
import { openTurnDiff } from "../lib/open-turn-diff";
import { retryLastTurn } from "../lib/retry-turn";
import { CONTINUE_AFTER_SLEEP } from "../lib/interruption-copy";
import {
  GroupCommentPill,
  RowCommentPill,
  useGroupHasComments,
  useRowHasComments,
} from "./chat-comment-pills";
import { ChangedFilesCard } from "./changed-files-card";
import { ImageAttachmentStrip } from "./image-attachments";
import { ProseRowActions } from "./prose-row-actions";
import { RemoteAuthor } from "./remote-author";
import { StreamingMarkdown } from "./streaming-markdown";
import { UserRowActions } from "./user-row-actions";

/** What every desktop slot below reads: resolved once by the transcript. */
interface TranscriptScope {
  tabId: string;
  /** Pin scope for this thread. */
  pinScopeKey: string;
  /** The session's project root: paths in a message become file chips. */
  fileRoot?: string;
}

const Scope = createContext<TranscriptScope>({ tabId: "", pinScopeKey: "" });

const Markdown = memo(function Markdown({
  source,
  priority,
  streaming,
  className,
  trustedPaths,
}: TranscriptMarkdownProps) {
  const { fileRoot } = useContext(Scope);
  // Settled prose goes through the plain cached renderer, whose root IS
  // `.prose-session`, so a scrolled-back message is a pure cache hit. The
  // streaming tail uses the block-splitting renderer, where only the
  // trailing block re-parses per frame.
  return streaming ? (
    <StreamingMarkdown source={source} streaming priority={priority} fileRoot={fileRoot} />
  ) : (
    <CachedMarkdown
      source={source}
      priority={priority}
      fileRoot={fileRoot}
      trustedPaths={trustedPaths}
      className={className}
    />
  );
});

function UserActions({ row, messageId, canRetry, toggleAbove }: TranscriptUserActionsProps) {
  const { tabId, pinScopeKey } = useContext(Scope);
  return (
    <UserRowActions
      tabId={tabId}
      text={row.text}
      canRetry={canRetry}
      messageId={messageId}
      timestamp={row.timestamp}
      timestampApproximate={row.timestampApproximate === true}
      pinScopeKey={pinScopeKey}
      toggleAbove={toggleAbove}
    />
  );
}

function ResponseActions(props: TranscriptResponseActionsProps) {
  const { tabId, pinScopeKey } = useContext(Scope);
  return <ProseRowActions tabId={tabId} pinScopeKey={pinScopeKey} {...props} />;
}

function Images({ images, className }: TranscriptImagesProps) {
  return <ImageAttachmentStrip images={images} className={className} />;
}

function Author({ id, fallback }: TranscriptRemoteAuthorProps) {
  const { tabId } = useContext(Scope);
  return <RemoteAuthor tabId={tabId} id={id} fallback={fallback} />;
}

function CommentPill({ anchorId }: TranscriptCommentPillProps) {
  const { tabId } = useContext(Scope);
  return <RowCommentPill tabId={tabId} chatKey={anchorId} />;
}

function GroupPill({ anchorIds, onOpen }: TranscriptGroupCommentPillProps) {
  const { tabId } = useContext(Scope);
  return <GroupCommentPill tabId={tabId} chatKeys={anchorIds} onOpen={onOpen} />;
}

function ChangedFiles({ row }: TranscriptChangedFilesProps) {
  const { tabId } = useContext(Scope);
  return <ChangedFilesCard turnKey={row.turnKey} tabId={tabId} files={row.files} />;
}

function useRowDiscussed(anchorId: string): boolean {
  return useRowHasComments(useContext(Scope).tabId, anchorId);
}

function useGroupDiscussed(anchorIds: readonly string[]): boolean {
  return useGroupHasComments(useContext(Scope).tabId, anchorIds);
}

const CLOCK: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
const clock = (timestamp: string) => formatTime(timestamp, CLOCK);

/**
 * The transcript's rows, as desktop wires them: the package's
 * `TranscriptProvider` with desktop's slots, scoped to one tab.
 */
export function DesktopTranscriptProvider({
  tabId,
  pinScopeKey,
  fileRoot,
  onToggleExpand,
  onToggleGroup,
  children,
}: TranscriptScope & {
  onToggleExpand: (rowId: string) => void;
  onToggleGroup: (rowId: string) => void;
  children: ReactNode;
}) {
  const scope = useMemo(() => ({ tabId, pinScopeKey, fileRoot }), [tabId, pinScopeKey, fileRoot]);
  const value = useMemo<TranscriptContextValue>(
    () => ({
      Markdown,
      UserActions,
      ResponseActions,
      Images,
      RemoteAuthor: Author,
      CommentPill,
      GroupCommentPill: GroupPill,
      ChangedFiles,
      useRowDiscussed,
      useGroupDiscussed,
      formatTime: clock,
      onToggleExpand,
      onToggleGroup,
      onOpenMarker: (row: MarkerRow) => {
        if (row.opens === "diff") {
          // Changes get the real viewer, not the sidebar. The turn id is what
          // the diff is scoped by; the path just says which file to land on.
          openTurnDiff(row.turnId, row.path);
        } else if (row.opens === "output") {
          openDetail(tabId, { kind: "output", toolCallId: row.toolCallId });
        }
      },
      onOpenSubagent: (row: SubagentRow) =>
        openDetail(tabId, { kind: "subagent", toolCallId: row.toolCallId }),
      onRetry: () => void retryLastTurn(tabId),
      // Continue is an ordinary message, sent through `atlas:chat-send` like a
      // suggestion chip, so every agent gets it.
      onContinue: () =>
        window.dispatchEvent(
          new CustomEvent("atlas:chat-send", { detail: { tabId, text: CONTINUE_AFTER_SLEEP } }),
        ),
    }),
    [tabId, onToggleExpand, onToggleGroup],
  );
  return (
    <Scope.Provider value={scope}>
      <TranscriptProvider value={value}>{children}</TranscriptProvider>
    </Scope.Provider>
  );
}
