import type { SessionMessage, SessionSnapshot } from "@/types/agents";
import { toolLocations, toolResultText, type SnapshotLive } from "../stores/chat-store";

/**
 * Map an atlas-agents `SessionMessage` (the rich Rust snapshot state returned by
 * `agents.snapshot()`) onto the wire shape `chat-store.replaceMessages` expects.
 *
 * Shared by the sidebar's resume (`open-thread.ts`) and `openAgentSession`
 * (`open-agent-session.ts`) so the two resume/hydrate paths stay byte-identical —
 * previously each kept its own copy and they could drift.
 *
 * Carries `result` through so a resumed transcript shows each tool call's output
 * instead of an empty card (the snapshot persists it as `ToolCall.result`).
 *
 * Carries `id` and `status` for the same reason. Dropping them here meant
 * `replaceMessages` had nothing to use and re-minted both, so every tool call in
 * a reopened conversation rendered as succeeded — a failed edit and a rejected
 * command looked exactly like ones that worked (ATL-220). The `id` matters
 * beyond display: it is the key `findToolCall` matches later deltas on, so a
 * re-minted one would push a duplicate card for a tool call that is still
 * running when the resume lands.
 */
export function snapshotMessageToWire(m: SessionMessage) {
  return {
    // Positional (`msg-{entry}`) and stable for the session, so a repaint of
    // the same conversation keeps every unchanged row's key.
    id: m.id,
    role: m.role === "system" ? ("system" as const) : m.role,
    content: m.content,
    timestamp: m.timestamp,
    // A replayed message's time is when Atlas replayed it, not when it was said.
    ...(m.timestamp_approximate ? { timestampApproximate: true } : {}),
    model: m.model ?? null,
    // The turn's timing, on the message that ends it — so "Worked for" and
    // "Stopped after" survive a reload.
    ...(m.worked_ms !== undefined ? { workedMs: m.worked_ms } : {}),
    ...(m.stop_reason !== undefined ? { stopReason: m.stop_reason } : {}),
    // Snake-case wire pair → the composer's attachment shape, so a reopened
    // message draws the same tiles it showed when it was sent.
    ...(m.images?.length
      ? { attachments: m.images.map((i) => ({ mimeType: i.mime_type, dataBase64: i.data })) }
      : {}),
    // How the message reads, and a thought's text: without them a thought
    // reopened as an empty reply (audit #6).
    mode: m.mode,
    ...(m.thinking ? { thinking: m.thinking } : {}),
    toolCalls: m.tool_calls.map((tc) => ({
      id: tc.id,
      toolName: tc.tool_name,
      kind: tc.kind ?? null,
      arguments: (tc.arguments ?? {}) as Record<string, unknown>,
      // `rawOutput` stands in when it is the call's only result (ACP audit finding 100).
      result: toolResultText(tc) ?? null,
      status: tc.status,
      ...(tc.started_at_ms !== undefined ? { startedAt: tc.started_at_ms } : {}),
      ...(tc.ended_at_ms !== undefined ? { endedAt: tc.ended_at_ms } : {}),
      // As the live path reads them (`toChatToolCall`): the diff and terminal
      // blocks, the paths, and the subagent launch it belongs to (audit #97).
      contentBlocks: tc.content_blocks,
      locations: toolLocations(tc.locations),
      parentToolCallId: tc.parent_tool_call_id ?? undefined,
    })),
  };
}

/**
 * What a snapshot says is live beyond its transcript, in the shape
 * `chat-store.hydrateSessionSnapshot` takes: the open permission prompts and
 * elicitation (so a tab reopened, or a window reloaded, mid-prompt can still
 * answer), the turn queue Rust holds, and whether a hold keeps the session
 * running past its tab.
 */
export function snapshotLive(snapshot: SessionSnapshot): SnapshotLive {
  return {
    agentId: snapshot.agent_id,
    turnSeq: snapshot.turn_seq,
    pendingPermissions: snapshot.pending_permissions,
    pendingElicitation: snapshot.pending_elicitation,
    queue: snapshot.queue,
    held: snapshot.held,
  };
}
