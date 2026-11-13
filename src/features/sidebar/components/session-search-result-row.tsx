// A row in the header search's results: the container for the package's
// `SessionSearchResult` (flat, one line, the settled ones dimmed,
// highlighted by the search field's arrow keys rather than by focus).

import { memo } from "react";
import { SessionSearchResult } from "@tryatlas/design";
import type { SidebarSession } from "../lib/sidebar-sessions";
import { useSessionListScroll } from "../lib/session-list-scroll";
import { resolveSessionRowStatus, sessionRowLabel } from "../lib/session-row-status";
import { ProjectBadge } from "./session-row-parts";
import { SessionHoverCardPopup } from "./session-hover-card";

export const SessionSearchResultRow = memo(function SessionSearchResultRow(props: {
  session: SidebarSession;
  isHighlighted: boolean;
  isActive: boolean;
  resultId: string;
  onHighlight: (threadId: string) => void;
  onSelect: (session: SidebarSession) => void;
  onMenuTarget: (session: SidebarSession) => void;
}) {
  const { session } = props;
  const status = resolveSessionRowStatus({
    live: null,
    liveElsewhere: session.liveElsewhere,
    heldWorking: session.heldWorking,
    watching: session.pullRequests.some((p) => p.watching),
  });
  const listScrolling = useSessionListScroll.use.scrolling();
  return (
    <SessionSearchResult
      session={session}
      resultId={props.resultId}
      isHighlighted={props.isHighlighted}
      isActive={props.isActive}
      accessibleLabel={sessionRowLabel({
        title: session.title,
        statusLabel: session.settledAt !== null ? "Settled" : null,
        projectName: session.projectName,
      })}
      hoverCardDisabled={listScrolling}
      badge={<ProjectBadge name={session.projectName} path={session.projectPath} />}
      hoverCard={<SessionHoverCardPopup session={session} status={status} />}
      onHighlight={() => props.onHighlight(session.threadId)}
      onSelect={() => props.onSelect(session)}
      onContextMenu={() => props.onMenuTarget(session)}
    />
  );
});
