// Wire shapes for the agent host's Rust surface.
//
// The session-delta wire (`crates/atlas-agent-wire`) is generated from the
// Rust types into `src/bindings/agent-wire/` (`bun run bindings:gen`) and
// re-exported here under the names the app reads it by. Everything declared
// by hand below comes from elsewhere (`src-tauri`'s commands, `atlas-acp`) and
// is kept in step with its Rust by hand.

import type { Message as SessionMessage } from "@/bindings/agent-wire/Message";
import type { PlanEntry } from "@/bindings/agent-wire/PlanEntry";
import type { QueuedPrompt } from "@/bindings/agent-wire/QueuedPrompt";
import type { SessionDeltaEnvelope } from "@/bindings/agent-wire/SessionDeltaEnvelope";
import type { SessionStatus } from "@/bindings/agent-wire/SessionStatus";
import type { Usage } from "@/bindings/agent-wire/Usage";
import type { Subagent } from "@/types/agent";
import type { AgentId, AcpSessionId } from "./acp";

export type { Message as SessionMessage } from "@/bindings/agent-wire/Message";
export type { MessageImage } from "@/bindings/agent-wire/MessageImage";
export type { MessageMode } from "@/bindings/agent-wire/MessageMode";
export type { MessageRole } from "@/bindings/agent-wire/MessageRole";
export type { Origin } from "@/bindings/agent-wire/Origin";
export type { PlanEntry } from "@/bindings/agent-wire/PlanEntry";
export type { QueuedPrompt } from "@/bindings/agent-wire/QueuedPrompt";
export type { RateLimitWindow } from "@/bindings/agent-wire/RateLimitWindow";
export type { SessionStatus } from "@/bindings/agent-wire/SessionStatus";
export type { ToolCall } from "@/bindings/agent-wire/ToolCall";
export type { ToolCallStatus } from "@/bindings/agent-wire/ToolCallStatus";
export type { Usage } from "@/bindings/agent-wire/Usage";

export interface SessionKey {
  agent_id: AgentId;
  session_id: AcpSessionId;
}

/** Metadata returned by `agents_new_session` before the binding is exposed. */
export interface SessionInit {
  key: SessionKey;
  current_mode: string | null;
  available_modes: SessionModeInfo[];
}
/** One image attached to an outbound prompt. Mirrors atlas-acp's
 *  `ImageAttachment` (serde camelCase). `dataBase64` is raw base64 — no
 *  `data:` URI prefix. */
export interface ImageAttachment {
  mimeType: string;
  dataBase64: string;
}

/** One ACP-advertised session mode (e.g. Codex's read-only / auto / full-access). */
export interface SessionModeInfo {
  id: string;
  name: string;
  description?: string | null;
  /** Models only: who makes it, as the agent stated it — the gateway's
   *  `publisher`, or the name of the group an ACP agent listed it under.
   *  Absent when unstated; never inferred from the id. */
  provider?: string | null;
  /** Models only: newly released — the picker's "New" badge. */
  is_new?: boolean;
  /** Models only: superseded but still served — folded under "Legacy models". */
  legacy?: boolean;
}

/** What `native_agent_refresh_models` returns — the picker's Refresh for the
 *  native agent (ADR-0007). Mirrors Rust `NativeModelsRefresh`. */
export interface NativeModelsRefresh {
  models: SessionModeInfo[];
  /** The first entitled row: what a new session starts on. */
  defaultModel: string;
  /** Anything the user can see changed. */
  changed: boolean;
  /** The native connection was restarted so the engine picks up the new
   *  rows; open native sessions were told and rebind on their next send. */
  reconnected: boolean;
}

export interface SessionSnapshot {
  agent_id: AgentId;
  session_id: AcpSessionId;
  cwd: string;
  plugin_id: string;
  status: SessionStatus;
  current_mode: string | null;
  current_model: string | null;
  available_modes: SessionModeInfo[];
  /** Models the agent advertised. ACP has no `models` field on a session: an
   *  agent offering a choice says so with a `category: "model"` select among
   *  its config options, which the host projects into this list. Drives the
   *  composer's model pill; empty when the agent advertises no such option. */
  available_models: SessionModeInfo[];
  available_commands: unknown[];
  /** Raw ACP config-option state — advertised config options and their current
   *  values, kept current by the `config_options_updated` delta. The composer
   *  renders these as generic knobs, minus the ones a dedicated picker owns. */
  config_options?: unknown[];
  /** Whether the agent's transport accepts image content blocks in prompts
   *  (`promptCapabilities.image`). Drives the composer's attach routing:
   *  true → picked/pasted images become inline base64 attachments; false →
   *  they degrade to path mention chips. */
  prompt_image_supported: boolean;
  plan: PlanEntry[];
  messages: SessionMessage[];
  /** Children this session delegated to, in launch order. Carried with the
   *  transcript — a reloaded session whose subagents were dropped would show
   *  the same delegated work as plain tool calls. Empty on the metadata-only
   *  read (`agents_snapshot_meta`), like `messages`. */
  subagents?: Subagent[];
  usage: Usage;
  created_at: string;
  updated_at: string;
  /** The `seq` of the last delta this snapshot reflects. A client that
   *  buffered the stream applies only deltas above it. */
  as_of_seq?: number;
  /** Permission prompts still waiting, oldest first — what lets a reload (or a
   *  late joiner) mid-prompt still answer. */
  pending_permissions?: PendingPermissionWire[];
  /** The newest elicitation still waiting, if any. */
  pending_elicitation?: PendingElicitationWire | null;
  /** The session's turn queue (owned by Rust; the composer strip mirrors it). */
  queue?: QueuedPrompt[];
  /** A hold keeps this session running without its tab (Universal RC). */
  held?: boolean;
}

/** A still-open permission prompt on a snapshot — the `permission_request`
 *  delta's fields. */
export interface PendingPermissionWire {
  request_id: string;
  tool_call: unknown;
  options: unknown;
}

/** A still-open elicitation on a snapshot — the `elicitation_requested`
 *  delta's fields. */
export interface PendingElicitationWire {
  request_id: string;
  mode: "form" | "url";
  message: string;
  requested_schema?: unknown;
  url?: string | null;
}

/**
 * Not a session delta: the manager's per-agent loading status (`Downloading
 * Node.js…`, `Installing @agentclientprotocol/codex-acp 1.11.0…`) while a
 * plugin's connect is in flight. Keyed by PLUGIN id because there is no
 * session — and no `agent_id` — until the connect finishes. `null` clears it.
 * Mirrors `AgentManagerEvent::LoadingStatusChanged` forwarded onto the
 * `atlas:agents` window event as `{kind: "loading_status", plugin_id, status}`.
 */
export interface LoadingStatusEvent {
  kind: "loading_status";
  plugin_id: string;
  status: string | null;
}

/**
 * Not a session delta: where an installed agent's update is. Keyed by plugin
 * id — an update belongs to the agent, not to one session. `waiting`: queued
 * behind a reply still running. `restarting`: the old process was dropped
 * once idle, and open chats reconnect on their next send. `installing`: the
 * new version is downloading. `ready`: it is installed. `failed`: the install
 * did not finish; the next connect retries it.
 */
export interface AgentUpdateEvent {
  kind: "agent_update";
  plugin_id: string;
  version: string;
  phase: "waiting" | "restarting" | "installing" | "ready" | "failed";
  error: string | null;
}

/** Everything the `atlas:agents` window event can carry. Session-scoped
 *  deltas, plus the session-less loading status and update events above. */
export type AgentStreamEvent = AgentDelta | LoadingStatusEvent | AgentUpdateEvent;

/**
 * Single multiplexed delta stream emitted on the `atlas:agents` window event.
 * `kind` discriminates; `agent_id` + `session_id` route to the right tab, and
 * `seq` is its dense per-session stream position (see
 * `SessionSnapshot.as_of_seq`).
 */
export type AgentDelta = SessionDeltaEnvelope;
