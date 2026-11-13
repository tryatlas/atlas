// The sidebar's destinations, one component each, so each subscribes to its
// own slice of the layout store and hands the package's button
// (`SessionSidebarDestination`) what it found. Inbox, Team chat, Timeline and Agent are labelled rows;
// Usage sits icon-only beside search, and Memory, Knowledge, Source control
// and the bell are the footer's icon dock (`app-sidebar.tsx`). Each toggles what it opens (back to the
// session when it is already on screen) and lights while its view is the one
// showing. Team chat stays visible when it is locked, greyed, saying what
// unlocks it.
//
// No motion on any of them: they are pressed many times a day, and the view
// they open is the feedback. Hover is a colour step only.

import type { ComponentProps } from "react";
import { Bell, BookOpen, GitBranch, MessagesSquare } from "lucide-react";
import { useAppStore } from "@/features/app/stores/app-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import {
  DESTINATIONS,
  destinationShown,
  toggleDestination,
} from "@/features/layout/lib/destinations";
import { sourceControlShown, toggleSourceControl } from "@/features/layout/lib/source-control";
import { agentPageShown, toggleAgentPage } from "@/features/layout/lib/org-agent";
import {
  teamChatDestinationShown,
  toggleTeamChatDestination,
} from "@/features/layout/lib/team-chat";
import { unlockHint, useTeamAccess } from "@/features/comms/lib/team-chat-access";
import { useCommsStore } from "@/features/comms/stores/comms-store";
import { hasUnreadConversation } from "@/features/comms/lib/derive";
import {
  hasUnread,
  useNotificationsStore,
} from "@/features/notifications/stores/notifications-store";
import { useOrgStore } from "@/features/organisations/stores/org-store";
import { useInboxStore, useInboxUnreadPoll } from "@/features/inbox/stores/inbox-store";
import { SessionSidebarDestination } from "@tryatlas/design";

const noop = () => {};

/** What the sidebar's top row and footer dock pass a destination button. */
type DockButtonProps = Pick<
  ComponentProps<typeof SessionSidebarDestination>,
  "iconOnly" | "hintSide" | "round"
>;

/** Team chat, as the destination (it is a surface too, from the surfaces
 *  pane's `+` and ⌘T); a dot while a conversation has anything unread (the
 *  server's counts), like the bell's. The selector answers a boolean, so a
 *  message landing re-renders the button only when the dot itself changes. */
export function TeamChatButton() {
  const open = useLayoutStore(teamChatDestinationShown);
  const access = useTeamAccess();
  const unread = useCommsStore((s) => hasUnreadConversation(s.reads, s.conversations));
  return (
    <SessionSidebarDestination
      icon={MessagesSquare}
      label="Team chat"
      data-tip-anchor="team-chat"
      active={open}
      locked={unlockHint(access, "team chat")}
      dot={unread && !access.locked}
      data-testid={unread && !access.locked ? "team-chat-unread" : undefined}
      onClick={access.locked ? (access.unlock ?? noop) : toggleTeamChatDestination}
    />
  );
}

/** The Organisation's inbox, when the active Organisation is synced: a dot
 *  while something is unread (polled — nothing pushes the inbox). A
 *  local-only Organisation has no inbox and no row. */
export function InboxButton() {
  const open = useLayoutStore((s) => destinationShown(s, "inbox"));
  const remoteOrgId = useOrgStore(
    (s) => s.organisations.find((o) => o.id === s.activeOrganisationId)?.remoteId ?? null,
  );
  useInboxUnreadPoll(remoteOrgId);
  const unread = useInboxStore((s) => (s.unread ?? 0) > 0);
  if (!remoteOrgId) return null;
  return (
    <SessionSidebarDestination
      icon={DESTINATIONS.inbox.icon}
      label="Inbox"
      active={open}
      dot={unread}
      data-testid={unread ? "inbox-unread" : undefined}
      onClick={() => toggleDestination("inbox")}
    />
  );
}

export function TimelineButton() {
  const open = useLayoutStore((s) => destinationShown(s, "artifacts"));
  return (
    <SessionSidebarDestination
      icon={DESTINATIONS.artifacts.icon}
      label="Timeline"
      data-tip-anchor="timeline"
      active={open}
      onClick={() => toggleDestination("artifacts")}
    />
  );
}

/** The Organisation agent, full page: every conversation, and the open one
 *  given the room. Its home is the side panel (⌘⌥A, `org-agent.ts`). */
export function AgentButton() {
  const open = useLayoutStore(agentPageShown);
  return (
    <SessionSidebarDestination
      icon={DESTINATIONS.agent.icon}
      label="Agent"
      data-tip-anchor="ask-atlas"
      active={open}
      onClick={toggleAgentPage}
    />
  );
}

export function MemoryButton(props: DockButtonProps) {
  const open = useLayoutStore((s) => destinationShown(s, "memory"));
  return (
    <SessionSidebarDestination
      {...props}
      icon={DESTINATIONS.memory.icon}
      label="Memory"
      data-tip-anchor="memory"
      active={open}
      onClick={() => toggleDestination("memory")}
    />
  );
}

export function UsageButton(props: DockButtonProps) {
  const open = useLayoutStore((s) => destinationShown(s, "usage"));
  return (
    <SessionSidebarDestination
      {...props}
      icon={DESTINATIONS.usage.icon}
      label="Usage"
      active={open}
      onClick={() => toggleDestination("usage")}
    />
  );
}

// Knowledge and source control belong to a project; without one open they
// say so instead of opening a view with nothing in it.

export function KnowledgeButton(props: DockButtonProps) {
  const open = useLayoutStore((s) => destinationShown(s, "knowledge"));
  const hasProject = useAppStore((s) => !!s.currentProject);
  return (
    <SessionSidebarDestination
      {...props}
      icon={BookOpen}
      label="Knowledge"
      hint={hasProject ? undefined : "Open a project to open its knowledge base"}
      active={open}
      disabled={!hasProject}
      onClick={() => toggleDestination("knowledge")}
    />
  );
}

export function SourceControlButton(props: DockButtonProps) {
  const open = useLayoutStore(sourceControlShown);
  const hasProject = useAppStore((s) => !!s.currentProject);
  return (
    <SessionSidebarDestination
      {...props}
      icon={GitBranch}
      label="Source control"
      hint={hasProject ? undefined : "Open a project to see its source control"}
      active={open}
      disabled={!hasProject}
      onClick={toggleSourceControl}
    />
  );
}

/** Opens the notification drawer; a dot while the active org has unread. */
export function NotificationsButton(props: DockButtonProps) {
  const activeOrgId = useOrgStore.use.activeOrganisationId();
  const unread = useNotificationsStore((s) => hasUnread(s.items, activeOrgId));
  const { toggle } = useNotificationsStore.use.actions();
  return (
    <SessionSidebarDestination
      {...props}
      icon={Bell}
      label="Notifications"
      // Where the drawer returns focus when it is dismissed.
      data-notifications-bell=""
      dot={unread}
      onClick={() => toggle(activeOrgId)}
    />
  );
}
