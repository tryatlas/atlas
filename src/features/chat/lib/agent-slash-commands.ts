import { agentMeta, catalogEntry as agentCatalogEntry } from "@/features/agents/lib/agent-meta";
import { canSignIn } from "./agent-signin";
import type { AtlasCommandNames, SlashCommand, SlashCommandHandler } from "./slash-command-model";

// `commandRequiresArgs` lives in the pure model, not the picker, so the eager
// composer can call it without pulling the lazy picker chunk into the initial
// graph; it is re-exported here for the callers that import it from this file.
export { commandRequiresArgs } from "./slash-command-model";

/** What Atlas's own command is called when the agent advertises one by the
 *  same name: the agent's keeps the plain name, Atlas's takes this prefix. */
export const ATLAS_COMMAND_PREFIX = "atlas:";

/** The slash picker's catalogue for an agent: what it advertised over ACP
 *  (`availableCommands`), plus the few commands Atlas itself handles.
 *
 *  The agent's list is the authority (ADR-0005): every command it advertises
 *  is listed and sent to it, none dropped and none answered by Atlas instead.
 *  Where one of Atlas's own names is taken, Atlas's command is listed as
 *  `/atlas:<name>`, and where that is taken too it is left out (#44). */
export function buildAgentSlashCommands(
  agentType: string,
  availableCommands: readonly unknown[] | undefined,
): SlashCommand[] {
  // Every agent gets its advertised commands — the native agent included,
  // whose list the seam now publishes. Only the legacy "custom" placeholder
  // bails out.
  if (agentType === "custom") return [];
  const fromAgent: SlashCommand[] = (availableCommands ?? [])
    .map((c) => {
      const o = (c ?? {}) as {
        name?: string;
        description?: string;
        input?: { hint?: string } | null;
      };
      const name = (o.name ?? "").replace(/^\//, "");
      const hint = typeof o.input?.hint === "string" ? o.input.hint : null;
      return {
        name,
        signature: o.input != null ? `/${name} <${hint || "args"}>` : `/${name}`,
        description: o.description ?? "",
        handler: "passthrough" as const,
      };
    })
    .filter((c) => c.name);
  const taken = new Set(fromAgent.map((c) => c.name));
  /** Atlas's command under a name the agent left free, or nothing. */
  const own = (
    name: string,
    args: string | null,
    description: string,
    handler: Exclude<SlashCommandHandler, "passthrough">,
  ): SlashCommand[] => {
    const free = [name, `${ATLAS_COMMAND_PREFIX}${name}`].find((n) => !taken.has(n));
    if (!free) return [];
    return [
      { name: free, signature: args ? `/${free} <${args}>` : `/${free}`, description, handler },
    ];
  };
  // `/login` drives Atlas's own sign-in dialog for the bound agent. Most
  // adapters do not advertise a `/login` of their own; one that does keeps it.
  //
  // Removed here, deliberately:
  //  - the per-agent `codex-login` / `atlas-login` handlers: every agent now
  //    routes through the same `AgentOAuthModal`, so the fork had no purpose
  //    beyond picking which of three dialogs to open;
  //  - the synthetic `/skills` row: Settings is not an agent command, and
  //    listing it here implied the agent understood it;
  //  - the dimmed `/clear` + `/logout` guard rows for Claude: the adapter
  //    blocklists them from `available_commands_update`, so showing rows that
  //    explain why an unadvertised command does nothing is Atlas inventing
  //    protocol surface. If an agent advertises them, they appear as
  //    passthrough like anything else.
  const login = canSignIn(agentType)
    ? own("login", null, `Sign in to ${agentMeta(agentType).label}.`, "agent-login")
    : [];
  // The other Atlas-surface commands. Like /login, these drive app
  // affordances rather than the agent — a new tab, the send queue — so the
  // app is the honest place to synthesize them. /fork is gated on the same
  // capability as the header's "branch from here"; /queue exists for every
  // agent, because the queue does.
  const local: SlashCommand[] = [
    ...(agentCatalogEntry(agentType)?.supportsFork === true
      ? own("fork", null, "Branch this conversation into a new tab", "fork")
      : []),
    ...own("queue", "message", "Queue a message to run when the agent is free", "queue"),
  ];
  return [...login, ...fromAgent, ...local];
}

/** The names typing reaches Atlas's `/fork` and `/queue` by in this catalogue,
 *  `null` where it has none. The composer's submit reads them, so text that
 *  names the agent's own command goes to the agent. */
export function atlasCommandNames(commands: readonly SlashCommand[]): AtlasCommandNames {
  return {
    fork: commands.find((c) => c.handler === "fork")?.name ?? null,
    queue: commands.find((c) => c.handler === "queue")?.name ?? null,
  };
}
