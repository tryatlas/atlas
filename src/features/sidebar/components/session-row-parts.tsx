// The pieces of a sidebar row that read Atlas's own state: the project badge
// (its icon is looked up over IPC), the agent mark (the agent registry), the
// running turn's clock (the chat store) and a snooze's time left. Each hands
// what it finds to the package's drawing of it (`@tryatlas/design`), which
// owns the row's anatomy, the shared clocks and the working ring.

import {
  AgentMonogram,
  ClaudeCodeMark,
  CodexMark,
  CursorAgentMark,
  ExternalAgentMark,
  KiloMark,
  OpenCodeMark,
  ProjectBadge as ProjectBadgeView,
  ProjectBadgeStack as ProjectBadgeStackView,
  WorkingDurationLabel,
  useMinuteClock,
} from "@tryatlas/design";
import { AtlasIcon } from "@/components/brand-marks";
import { agentMeta } from "@/features/agents/lib/agent-meta";
import { useChatStore } from "@/features/chat/stores/chat-store";
import type { SidebarAgent } from "@/features/chat/lib/sidebar-agents";
import { cn } from "@/lib/utils";
import { snoozeRemainingLabel } from "@/features/chat/lib/session-snooze";
import {
  projectMonogram,
  projectMonogramColor,
  useProjectIcon,
} from "@/features/projects/lib/project-icon";

/**
 * The project's badge, the size of an icon: the icon the project ships (its
 * favicon or app icon) when it has one, else its monogram on a tile tinted
 * with the project's colour. Pass `path` to look the icon up; without it the
 * badge is always the monogram.
 */
export function ProjectBadge({
  name,
  path,
  className,
}: {
  name: string;
  path?: string | null;
  className?: string;
}) {
  const icon = useProjectIcon(path);
  return (
    <ProjectBadgeView
      icon={icon}
      monogram={projectMonogram(name)}
      color={projectMonogramColor(name)}
      className={className}
    />
  );
}

/** The session's project badge, with the projects attached to it stacked
 *  after it. Their names are the stack's title; the hover card lists them
 *  with their access. */
export function ProjectBadgeStack({
  name,
  path,
  attached,
  attachedNames,
}: {
  name: string;
  path?: string | null;
  attached: readonly { displayName: string; path?: string }[];
  attachedNames: string;
}) {
  return (
    <ProjectBadgeStackView
      badge={<ProjectBadge name={name} path={path} />}
      attached={attached.map((project, i) => (
        <ProjectBadge
          key={`${i}-${project.displayName}`}
          name={project.displayName}
          path={project.path}
        />
      ))}
      title={`${name}, with ${attachedNames} attached`}
    />
  );
}

/** The mark of the agent that ran a session. */
export function SessionAgentIcon({
  agent,
  className,
}: {
  agent: SidebarAgent;
  className?: string;
}) {
  const size = cn("size-3", className);
  if (agent === "codex") return <CodexMark className={size} />;
  if (agent === "opencode") return <OpenCodeMark className={size} />;
  if (agent === "cursor") return <CursorAgentMark className={size} />;
  if (agent === "kilo") return <KiloMark className={size} />;
  if (agent === "atlas-agent") return <AtlasIcon size={12} className={className} />;
  if (agent === "claude") return <ClaudeCodeMark className={size} />;
  const meta = agentMeta(agent);
  return meta.iconDataUrl ? (
    <ExternalAgentMark dataUrl={meta.iconDataUrl} size={12} />
  ) : (
    <AgentMonogram label={meta.label} size={12} />
  );
}

/** The running turn's clock, from the start the chat store stamped on the tab.
 *  Nothing for a turn running somewhere else: there is no start to count from. */
export function WorkingDuration({ tabId }: { tabId: string | null }) {
  const startedAt = useChatStore((s) =>
    tabId ? (s.sessions[tabId]?.turnStartedAt ?? null) : null,
  );
  if (startedAt === null) return null;
  return <WorkingDurationLabel startedAt={startedAt} />;
}

/** How long until a snooze ends ("45m", "3h", "2d"), on the shared minute tick. */
export function SnoozeRemaining({ until }: { until: string }) {
  const now = useMinuteClock();
  return <>{snoozeRemainingLabel(until, new Date(now))}</>;
}
