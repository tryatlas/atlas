// Projection: ChatMessage[] → turns → a flat, typed row index.
//
// The rows are `@tryatlas/design/session`'s (`Row`, `RowKind`): the package
// renders them, here and in the web app, and this file is desktop's projection
// onto them.
//
// The old transcript rendered one `MessageItem` per stored message and derived
// grouping (`compact`, `isLastInGroup`, dividers, time gaps) from neighbouring
// messages on EVERY render. Two problems: the turn — the thing users reason
// about, and the thing the footer and "Show changes" belong to — had no
// representation, and grouping was O(n) work repeated per frame.
//
// Here the thread is projected ONCE into a closed set of row kinds. Everything
// a row needs to render is baked into the row record at projection time. The
// rendering layer never looks at a neighbour.
//
// The closed set matters: a new row kind is a deliberate addition to the
// vocabulary of the transcript, not an ad-hoc branch in a render function.

import {
  foldWork,
  footerResponse,
  gapSeparator,
  liveThought,
  markerBlock,
  markLiveBlocks,
  mcpToolOf,
  parseShellCommand,
  RowKind,
  shortPath,
  thoughtHeadline,
  toolDisplayName,
  toolIconFor,
  type MarkerDetail,
  type MarkerRow,
  type MarkerState,
  type MarkerTool,
  type Row,
  type SubagentRow,
  type TranscriptImage,
} from "@tryatlas/design/session";
import type { ChatMessage, Subagent, ToolCallDisplay, TurnInterruption } from "@/types/agent";

// Shared so a row without images keeps a stable prop for the row's `memo`.
const NO_ATTACHMENTS: readonly TranscriptImage[] = Object.freeze([]);
import { isBashToolCall, bashCommandOf } from "./tool-calls";
import { orgToolOf, orgToolRow } from "@/features/org-actions/lib/org-tool-rows";
import {
  getFilePathFromInput,
  classifyToolFileKind,
  countChangedLines,
  countEditLines,
  isFileCreated,
} from "./tool-files";
import { isEmptyMessage, stableTurnKey } from "./turn-identity";
import { splitAtlasContext } from "./atlas-context";
import { stripNextSteps, stripNextStepsDirective } from "./next-steps";
import { detectInjectedPrompt } from "./injected-prompt";

// ── Turns ──────────────────────────────────────────────────────────────────

export interface Turn {
  id: string;
  role: "user" | "assistant";
  /** Indices into the projection's `rows` array. */
  rowStart: number;
  rowEnd: number;
  /** Original `messages` index of the turn's first message — the existing
   *  `atlas:chat-jump` event and the bash panel address messages this way. */
  messageIndex: number;
  status: "streaming" | "settled" | "error";
  /** Preview for the nav rail (user turns only). */
  preview: string;
  timestamp: string;
  toolCount: number;
  fileCount: number;
}

export interface Projection {
  rows: Row[];
  turns: Turn[];
  /** Per-turn pieces, for the next projection to reuse. See `projectRows`. */
  segments: Segment[];
}

/**
 * Tool calls that are the agent talking to ITSELF — planning, task bookkeeping,
 * scheduling. They produce no artifact the reader can inspect and no change to
 * the project, so a run of five `TaskUpdate` lines is pure noise between two
 * paragraphs of prose. Dropped at projection time so they never cost a row.
 */
const INTERNAL_TOOLS = new Set([
  "exitplanmode",
  "todowrite",
  "taskcreate",
  "taskupdate",
  "taskget",
  "tasklist",
  "taskoutput",
  "taskstop",
  "schedulewakeup",
  "reportfindings",
  "updateplan",
  "plan",
]);

function isInternalTool(tc: ToolCallDisplay): boolean {
  return INTERNAL_TOOLS.has(tc.toolName.trim().toLowerCase());
}

// ── Marker labelling ───────────────────────────────────────────────────────

/** What a tool call changed, however it reported it. */
interface FileEdit {
  /** The file the marker names — the first one the call touched. */
  path: string;
  added: number;
  removed: number;
  created: boolean;
}

/** The edit a tool call reported STRUCTURALLY, as ACP `diff` content blocks.
 *
 *  An ACP agent's tools are its own: `apply_patch(patch_id)` says nothing that
 *  `classifyToolFileKind` can read, and the edit lives entirely in the blocks.
 *  Without this the marker fell through to the generic branch — no file name,
 *  no line counts, and a click that opened the output pane instead of the diff
 *  viewer, even though the before/after text was right there.
 *
 *  Each block carries the WHOLE file either side, not the fragment that
 *  changed, so blocks naming the SAME path collapse to first-before against
 *  last-after — the state the call found the file in against the state it left
 *  it in. Summing them instead would count intermediate states the reader
 *  never sees: a line rewritten twice would read as two changed lines against
 *  a diff showing one. This is the same fold `collectTurnEdits` does for the
 *  viewer the marker opens, so the count and the diff agree.
 *
 *  A tool call is still exactly ONE marker (the row invariant), so a call that
 *  changed several files is named by the first and sized by all of them. */
function diffEditOf(tc: ToolCallDisplay): FileEdit | null {
  const blocks = (tc.contentBlocks ?? []).filter((b) => b.type === "diff");
  if (blocks.length === 0) return null;

  const byPath = new Map<string, { old: string; new: string; created: boolean }>();
  for (const b of blocks) {
    const seen = byPath.get(b.path);
    byPath.set(b.path, {
      // The wire OMITS `oldText` for a file the call created; an empty string
      // is a real file that happened to be empty.
      old: seen ? seen.old : (b.oldText ?? ""),
      new: b.newText,
      created: seen ? seen.created : b.oldText === undefined,
    });
  }

  let added = 0;
  let removed = 0;
  for (const file of byPath.values()) {
    const counts = countChangedLines(file.old, file.new);
    added += counts.added;
    removed += counts.removed;
  }
  return {
    path: blocks[0].path,
    added,
    removed,
    // "Created" only when the call brought nothing into existence but new
    // files — one edited file among them makes it an edit.
    created: [...byPath.values()].every((file) => file.created),
  };
}

/**
 * An Atlas memory call's tool, from either spelling of its name:
 * `mcp__atlas_memory__memory_search` (an ACP agent's) or
 * `atlas_memory.memory_search` (Atlas Agent's).
 */
export function memoryToolOf(toolName: string): string | null {
  return /^(?:mcp__atlas_memory__|atlas_memory\.)(memory_[a-z_]+)$/.exec(toolName)?.[1] ?? null;
}

/** The line a memory call reads as: what it looked for, or what it kept. */
function memoryToolRow(
  tool: string,
  args: Record<string, unknown>,
): { verb: string; detail: string } {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  switch (tool) {
    case "memory_search":
      return str(args.query)
        ? { verb: "Searched memory for", detail: str(args.query) }
        : { verb: "Searched memory", detail: "" };
    case "memory_remember":
      return str(args.kind)
        ? { verb: "Remembered a", detail: str(args.kind) }
        : { verb: "Remembered", detail: "" };
    default:
      return { verb: "Read memory", detail: "" };
  }
}

/** Where the engine moved the file its arguments name, read off its `changes`
 *  list without parsing the patch: a renamed file's row opens where it went. */
function movedPathOf(args: Record<string, unknown>, path: string | null): string | null {
  if (!path || !Array.isArray(args.changes)) return null;
  for (const change of args.changes as unknown[]) {
    if (!change || typeof change !== "object") continue;
    const c = change as { path?: unknown; movePath?: unknown };
    if (c.path !== path) continue;
    return typeof c.movePath === "string" && c.movePath.length > 0 ? c.movePath : null;
  }
  return null;
}

/**
 * One tool call → one marker. Codex shows a single line with the command
 * truncated and no separate result row; state lives in the glyph and the full
 * output lives in the panel. We match that: a tool call never produces more
 * than one row, so a tool-heavy turn costs a predictable number of rows.
 */
function markerFor(tc: ToolCallDisplay, turnId: string, first: boolean): MarkerRow {
  const state: MarkerState =
    tc.status === "failed"
      ? "failed"
      : tc.status === "completed"
        ? "done"
        : tc.status === "running"
          ? "running"
          : "pending";

  // A tool call that is running a terminal has an output pane worth opening
  // even before the command's first byte: watching it stream is the point.
  // Once it has finished, the pane is worth opening only if something was
  // printed — every native command carries a terminal now, and a silent
  // `git config` should not claim an output nobody can open.
  const ranTerminal =
    (tc.contentBlocks ?? []).some((b) => b.type === "terminal") &&
    (tc.status === "pending" || tc.status === "running" || !!tc.result);

  let verb = tc.toolName;
  let tool: MarkerTool = toolIconFor(tc.kind, tc.toolName);
  let detail = "";
  let cmd: string | undefined;
  let opens: MarkerDetail = tc.result || ranTerminal ? "output" : "none";
  let added = 0;
  let removed = 0;

  const args = tc.arguments ?? {};
  const fileKind = classifyToolFileKind(tc.kind, tc.toolName);
  const argsPath = getFilePathFromInput(args);
  // Two ways an edit is reported, one shape. Recognisable arguments win: a
  // tool Atlas already understands must not read differently just because the
  // agent also attached the structural blocks.
  const edit: FileEdit | null =
    fileKind === "edit" && argsPath
      ? {
          path: argsPath,
          created: isFileCreated(tc.toolName, args),
          ...countEditLines(tc.toolName, args),
        }
      : diffEditOf(tc);
  // The path the marker reports: whatever the arguments named, else whatever
  // the diff blocks did. It is what the diff viewer lands on.
  // A file the engine renamed is reported where it went.
  const path = movedPathOf(args, argsPath) ?? argsPath ?? edit?.path ?? null;

  const orgTool = orgToolOf(tc.toolName);
  const memoryTool = memoryToolOf(tc.toolName);
  const mcp = mcpToolOf(tc.toolName);
  let server: string | undefined;
  if (memoryTool) {
    const row = memoryToolRow(memoryTool, args);
    tool = "memory";
    verb = row.verb;
    detail = row.detail;
  } else if (orgTool) {
    // An organisation call (ADR-0014): the organisation icon, and the line
    // that names what it was about — the member, conversation or recorded
    // session — from the table the Logs row reads too. A failed call's text
    // is its reason, so only a settled success's answer improves the name.
    const row = orgToolRow(orgTool, args, tc.status === "completed" ? tc.result : null);
    tool = "org";
    verb = row.verb;
    detail = row.detail;
  } else if (isBashToolCall(tc)) {
    // Every one of these is the same tool. What separates `cat file` from
    // `cargo test` is the command itself, so that is what gets read — see
    // `parse-shell-command.ts` for why this is a port and not a wire field.
    // A command it cannot reduce to one action stays "Ran", verbatim.
    const command = bashCommandOf(args) || (tc.kind === "execute" ? tc.toolName : "");
    opens = "output";
    cmd = command;
    const parsed = parseShellCommand(command);
    if (parsed.kind === "read") {
      verb = "Read";
      tool = "read";
      detail = shortPath(parsed.path);
    } else if (parsed.kind === "list") {
      verb = "Listed";
      tool = "list";
      detail = parsed.path ? shortPath(parsed.path) : "";
    } else if (parsed.kind === "search") {
      verb = "Searched";
      tool = "search";
      // "pattern in dir" — the pattern verbatim, since a regex may contain
      // slashes that `shortPath` would happily eat; only the path is shortened.
      detail = parsed.path
        ? `${parsed.query ?? ""} in ${shortPath(parsed.path)}`.trim()
        : (parsed.query ?? "");
    } else {
      verb = "Ran";
      tool = "run";
      detail = command;
      // The verb already says "Ran" and `detail` already IS the command, so a
      // title repeating it would be noise.
      cmd = undefined;
    }
  } else if (edit) {
    verb = edit.created ? "Created" : "Edited";
    tool = "edit";
    detail = shortPath(edit.path);
    added = edit.added;
    removed = edit.removed;
    opens = "diff";
  } else if (fileKind === "read" && path) {
    verb = "Read";
    tool = "read";
    detail = shortPath(path);
    opens = tc.result || ranTerminal ? "output" : "none";
  } else if (typeof args.pattern === "string") {
    verb = "Searched";
    tool = "search";
    detail = args.pattern;
    opens = "output";
  } else if (mcp) {
    verb = mcp.tool;
    server = mcp.server;
    if (mcp.server === "browser") tool = "browser";
    detail = path ? shortPath(path) : "";
  } else if (path) {
    verb = toolDisplayName(tc.toolName);
    // It named a file but neither `kind` nor its arguments say what it did to
    // it. A neutral page beats guessing between the book and the pencil.
    if (tool === "tool") tool = "file";
    detail = shortPath(path);
  } else {
    verb = toolDisplayName(tc.toolName);
    detail = "";
  }

  return {
    kind: RowKind.Marker,
    id: `mk:${tc.id}`,
    turnId,
    firstInTurn: first,
    verb,
    tool,
    detail: detail.replace(/\s+/g, " ").trim(),
    state,
    toolCallId: tc.id,
    opens,
    cmd,
    path: path ?? undefined,
    ...(server && { server }),
    added,
    removed,
    startedAt: tc.startedAt,
    ...(tc.startedAt !== undefined && tc.endedAt !== undefined
      ? { durationMs: Math.max(0, tc.endedAt - tc.startedAt) }
      : {}),
  };
}

// ── Projection ─────────────────────────────────────────────────────────────

/**
 * Per-message derived-text caches, keyed by the message OBJECT. `projectRows`
 * runs once per applied streaming batch, and these strip/split/regex passes
 * over full message bodies made its per-frame cost scale with total transcript
 * bytes, not tail size (every assistant body paid a `toLowerCase` copy inside
 * `stripNextSteps`, every user prompt a whitespace regex — per frame, forever).
 * Immer keeps settled messages identity-stable across batches, so a WeakMap
 * hit costs one lookup; only the streaming tail (fresh identity each frame)
 * recomputes, and dead entries fall out with their messages via GC.
 */
interface UserDerived {
  text: string;
  contextBlocks: number;
  preview: string;
}
const userDerivedCache = new WeakMap<ChatMessage, UserDerived>();
const proseCache = new WeakMap<ChatMessage, string>();
// A delegating session re-projects every turn, so a settled thought would
// otherwise be re-read every frame; keyed by message, which immer replaces
// whenever the thinking changes.
const headlineCache = new WeakMap<ChatMessage, string | null>();

function headlineOf(m: ChatMessage): string | null {
  let line = headlineCache.get(m);
  if (line === undefined) {
    line = thoughtHeadline(m.thinking ?? "");
    headlineCache.set(m, line);
  }
  return line;
}

function derivedUser(m: ChatMessage): UserDerived {
  const hit = userDerivedCache.get(m);
  if (hit) return hit;
  const split =
    m.atlasContext !== undefined
      ? {
          prose: m.atlasProse ?? m.content,
          context: m.atlasContext,
          blockCount: m.atlasContextBlockCount ?? 0,
        }
      : splitAtlasContext(m.content);
  const text = stripNextStepsDirective(split.prose).trim();
  const v: UserDerived = {
    text,
    contextBlocks: split.context ? split.blockCount : 0,
    preview: text.replace(/\s+/g, " ").slice(0, 80),
  };
  userDerivedCache.set(m, v);
  return v;
}

/** The text a user bubble SHOWS for `m` — injected memory/context blocks and
 *  the next-steps directive stripped. This is what a pin records, so it is the
 *  one comparison that survives ids being re-minted (`resolvePinIndex`). */
export function userMessageText(m: ChatMessage): string {
  return derivedUser(m).text;
}

/** The prose a response row SHOWS — the assistant half of a pin's durable
 *  key, the same way `userMessageText` is the prompt half. */
export function assistantMessageText(m: ChatMessage): string {
  return derivedProse(m);
}

function derivedProse(m: ChatMessage): string {
  const hit = proseCache.get(m);
  if (hit !== undefined) return hit;
  const v = stripNextSteps(m.content ?? "").trim();
  proseCache.set(m, v);
  return v;
}

export interface ProjectOptions {
  /** Ids of user bubbles / thinking blocks the reader has expanded. */
  expanded: ReadonlySet<string>;
  /** The trailing assistant message is live. */
  streaming: boolean;
  /** Turns whose tool-call block the reader has opened. */
  expandedTurns: ReadonlySet<string>;
  /** The trailing assistant turn has not finished, even if it is not streaming
   *  right now — it may be paused on a permission prompt. Drives the work
   *  header only; defaults to `streaming`. */
  turnInProgress?: boolean;
  /** The session's delegated children, keyed by their launching call id
   *  (`ChatSession.subagents`). Absent for the overwhelming majority of
   *  sessions, and then this projection behaves exactly as it did before:
   *  no subagent rows, and nothing re-attributed. */
  subagents?: Record<string, Subagent>;
}

/**
 * Project a thread into rows.
 *
 * This runs per applied streaming batch: immer gives `messages` a new identity
 * on every appended chunk. Two things keep that cheap on a long session:
 *
 * - Per-turn reuse. The thread is projected turn by turn into segments
 *   (`Segment`), and a turn whose messages, neighbour and options are the
 *   same objects as last time is not projected again: its rows come back as
 *   last time's. While an agent streams, only the live turn is projected, so
 *   the per-frame cost tracks that turn, not the length of the thread.
 * - Structural sharing inside a re-projected turn. Rows that are
 *   field-identical to the previous projection's are returned as the PREVIOUS
 *   objects, so the memo'd row views hold for every row except the ones that
 *   actually changed (typically just the streaming tail).
 */
export function projectRows(
  messages: ChatMessage[],
  opts: ProjectOptions,
  prev?: Projection | null,
): Projection {
  // A child's calls are attributed to it by `parentToolCallId`, and they can
  // arrive in a LATER message than the launch — the agent announces the call
  // and assigns it afterwards. So they are collected in one pass up front
  // rather than looked up per launch, which would be O(children × calls) over
  // a transcript re-projected on every streaming frame.
  //
  // Skipped entirely when the session has delegated nothing, which is almost
  // every session: no allocation, no pass.
  const childCalls = new Map<string, ToolCallDisplay[]>();
  if (opts.subagents) {
    for (const m of messages) {
      for (const tc of m.toolCalls) {
        const parent = tc.parentToolCallId;
        if (!parent || !opts.subagents[parent]) continue;
        const bucket = childCalls.get(parent);
        if (bucket) bucket.push(tc);
        else childCalls.set(parent, [tc]);
      }
    }
  }

  const prevSegments = new Map<string, Segment>();
  if (prev) for (const s of prev.segments) prevSegments.set(s.id, s);

  const rows: Row[] = [];
  const turns: Turn[] = [];
  const segments: Segment[] = [];
  const lastIdx = messages.length - 1;
  const turnInProgress = opts.turnInProgress ?? opts.streaming;
  let i = 0;

  while (i < messages.length) {
    const m = messages[i];
    const isStreamingTail = opts.streaming && i === lastIdx && m.role === "assistant";
    if (!isStreamingTail && isEmptyMessage(m)) {
      i += 1;
      continue;
    }

    // A user turn is one message; an assistant turn is the whole consecutive
    // run of them (the store emits one message per block).
    let end = i + 1;
    if (m.role === "assistant") {
      while (end < messages.length && messages[end].role === "assistant") end += 1;
    }
    const final = end === messages.length;

    const old = prevSegments.get(m.id);
    let seg: Segment;
    if (old && segmentHolds(old, messages, i, end, opts, final, turnInProgress)) {
      seg = old.offset === rows.length && old.start === i ? old : shiftSegment(old, rows.length, i);
    } else {
      seg = projectSegment(messages, i, end, opts, childCalls, rows.length);
      if (old) shareRows(seg, old);
    }
    segments.push(seg);
    for (const r of seg.rows) rows.push(r);
    for (const t of seg.turns) turns.push(t);
    i = end;
  }

  return { rows, turns, segments };
}

/**
 * One turn's slice of a projection, and what it was projected from — the
 * inputs `segmentHolds` checks before handing it back unchanged.
 */
export interface Segment {
  /** The turn's first message id. */
  id: string;
  /** The messages it was projected from, by identity. */
  messages: ChatMessage[];
  /** The message just before it: the gap separator and the live clock read
   *  its timestamp. */
  before: ChatMessage | undefined;
  /** It ran to the end of the thread, where streaming and the live turn
   *  apply. */
  final: boolean;
  streaming: boolean;
  turnInProgress: boolean;
  expanded: ReadonlySet<string>;
  expandedTurns: ReadonlySet<string>;
  /** Cleared when the session rebinds to a new agent session, with the
   *  messages untouched: a turn projected with children is stale without. */
  subagents: Record<string, Subagent> | undefined;
  /** Where its rows and first message sat when its `turns` were stamped. */
  offset: number;
  start: number;
  rows: Row[];
  /** With absolute `rowStart`/`rowEnd`/`messageIndex`, per `offset`/`start`. */
  turns: Turn[];
}

function segmentHolds(
  s: Segment,
  messages: ChatMessage[],
  start: number,
  end: number,
  opts: ProjectOptions,
  final: boolean,
  turnInProgress: boolean,
): boolean {
  // A delegating session re-projects every turn: a child's calls can land in
  // messages outside its launching turn, so the slice is not the whole input.
  if (opts.subagents || s.subagents !== opts.subagents) return false;
  if (s.final !== final) return false;
  if (final && (s.streaming !== opts.streaming || s.turnInProgress !== turnInProgress)) {
    return false;
  }
  if (s.expanded !== opts.expanded || s.expandedTurns !== opts.expandedTurns) return false;
  if (s.before !== messages[start - 1]) return false;
  if (s.messages.length !== end - start) return false;
  for (let k = 0; k < s.messages.length; k++) {
    if (s.messages[k] !== messages[start + k]) return false;
  }
  return true;
}

/** The same segment at a new place in the thread: older history loaded above
 *  it, or a turn above it changed its row count. Only the indices move. */
function shiftSegment(s: Segment, offset: number, start: number): Segment {
  const dRow = offset - s.offset;
  const dMsg = start - s.start;
  return {
    ...s,
    offset,
    start,
    turns: s.turns.map((t) => ({
      ...t,
      rowStart: t.rowStart + dRow,
      rowEnd: t.rowEnd + dRow,
      messageIndex: t.messageIndex + dMsg,
    })),
  };
}

/** Hand back the previous segment's row and marker objects wherever the new
 *  ones are field-identical. Runs after `firstInTurn` is final, or a shared
 *  object could be mutated in place where no memo would see it. */
function shareRows(seg: Segment, old: Segment): void {
  const prevRows = new Map<string, Row>();
  for (const r of old.rows) prevRows.set(r.id, r);
  for (let k = 0; k < seg.rows.length; k++) {
    const row = seg.rows[k];
    const was = prevRows.get(row.id);
    if (!was) continue;
    if (was.kind === RowKind.MarkerGroup && row.kind === RowKind.MarkerGroup) {
      const oldMarkers = new Map(was.markers.map((marker) => [marker.id, marker]));
      row.markers = row.markers.map((marker) => {
        const previous = oldMarkers.get(marker.id);
        return previous && sameShallow(previous, marker) ? previous : marker;
      });
    }
    if (sameShallow(was, row)) seg.rows[k] = was;
  }
  const prevTurns = new Map<string, Turn>();
  for (const t of old.turns) prevTurns.set(t.id, t);
  for (let k = 0; k < seg.turns.length; k++) {
    const was = prevTurns.get(seg.turns[k].id);
    if (was && sameShallow(was, seg.turns[k])) seg.turns[k] = was;
  }
}

/**
 * Project one turn: the user message at `start`, or the assistant run
 * `[start, end)`. `offset` is where its rows land in the whole projection.
 */
function projectSegment(
  messages: ChatMessage[],
  start: number,
  end: number,
  opts: ProjectOptions,
  childCalls: Map<string, ToolCallDisplay[]>,
  offset: number,
): Segment {
  const rows: Row[] = [];
  const turns: Turn[] = [];
  const lastIdx = messages.length - 1;
  let i = start;
  const m = messages[i];
  // ── User turn: exactly one row. ────────────────────────────────────────
  if (m.role === "user") {
    const derived = derivedUser(m);
    const text = derived.text;
    const turnId = `t:${m.id}`;
    // The gap separator belongs BETWEEN turns, so it is emitted before
    // `rowStart` is captured — otherwise a turn's first row would be the
    // separator, and both `firstInTurn` and every scroll anchor that targets
    // "the start of this turn" would point one row too high.
    maybeGapSeparator(rows, messages, i, turnId);
    const rowStart = rows.length;

    // Atlas's own prompt — live, or recognised by its wording on replay — is
    // not the user's words, so it is not their bubble.
    const injected = m.injected ?? detectInjectedPrompt(m.content);
    if (injected) {
      rows.push({
        kind: RowKind.Injected,
        id: `u:${m.id}`,
        turnId,
        firstInTurn: true,
        injected,
        text: m.content,
        timestamp: m.timestamp,
      });
    } else {
      rows.push({
        kind: RowKind.User,
        id: `u:${m.id}`,
        turnId,
        firstInTurn: true,
        text,
        contextBlocks: derived.contextBlocks,
        expanded: opts.expanded.has(`u:${m.id}`),
        attachments: m.attachments ?? NO_ATTACHMENTS,
        remoteAuthor: m.origin?.kind === "remote" ? m.origin.name?.trim() || "Someone else" : null,
        remoteAuthorId: m.origin?.kind === "remote" ? m.origin.id : null,
        timestamp: m.timestamp,
        ...(m.timestampApproximate && { timestampApproximate: true as const }),
        ...(m.trustedMentionPaths?.length && { trustedPaths: m.trustedMentionPaths }),
      });
    }

    turns.push({
      id: turnId,
      role: "user",
      rowStart,
      rowEnd: rows.length,
      messageIndex: i,
      status: "settled",
      preview: !injected
        ? derived.preview
        : injected.source === "restart"
          ? injected.summary
          : `Pull request watch: ${injected.summary}`,
      timestamp: m.timestamp,
      toolCount: 0,
      fileCount: 0,
    });
  } else {
    // ── Assistant turn: consume the whole consecutive assistant run. ───────
    // The store emits one message per block (text / tool / thinking); a turn is
    // the run of them between user messages. Collapsing that run here is what
    // gives the footer and the "Show changes" button something to belong to.
    const turnFirstIdx = i;
    const turnId = `t:${m.id}`;
    maybeGapSeparator(rows, messages, i, turnId);
    const rowStart = rows.length;

    // The turn is still going: running, or paused on a prompt.
    const inProgress = (opts.turnInProgress ?? opts.streaming) && end === messages.length;
    let markers: MarkerRow[] = [];
    const flushMarkers = () => {
      if (markers.length === 0) return;
      rows.push(
        markerBlock(markers, {
          turnId,
          firstInTurn: rows.length === rowStart,
          inProgress,
          expandedTurns: opts.expandedTurns,
        }),
      );
      markers = [];
    };
    let workedMs: number | null = null;
    let stopReason: string | null = null;
    let toolCount = 0;
    /** Children this turn delegated to, flushed after its last row. */
    const delegated: SubagentRow[] = [];
    let footerMsg: ChatMessage | null = null;
    let interruption: TurnInterruption | null = null;
    let interruptedMsgId = "";
    let headerShown = false;
    let sawError = false;

    while (i < messages.length && messages[i].role === "assistant") {
      const msg = messages[i];
      const tail = opts.streaming && i === lastIdx;
      if (!tail && isEmptyMessage(msg)) {
        i += 1;
        continue;
      }

      if (msg.thinking && msg.thinking.trim()) {
        flushMarkers();
        rows.push({
          kind: RowKind.Thinking,
          id: `th:${msg.id}`,
          turnId,
          firstInTurn: rows.length === rowStart,
          text: opts.expanded.has(`th:${msg.id}`) ? msg.thinking : "",
          headline: headlineOf(msg),
          live:
            tail &&
            !opts.expanded.has(`th:${msg.id}`) &&
            msg.toolCalls.length === 0 &&
            !derivedProse(msg)
              ? liveThought(msg.thinking)
              : null,
          streaming: tail,
          expanded: opts.expanded.has(`th:${msg.id}`),
        });
      }

      for (const tc of msg.toolCalls) {
        if (isInternalTool(tc)) continue;

        // A child's own call belongs under its parent's row, not in the
        // turn's stream: left here it would read as the parent's work, and
        // three children running at once would interleave into one
        // unattributable block. Collected by `childCalls` above.
        //
        // BEFORE the counters: a child's failed grep is the child's failure,
        // and counted here it set the whole turn to "error" and inflated the
        // parent's tool count with work it never did.
        if (tc.parentToolCallId && opts.subagents?.[tc.parentToolCallId]) continue;

        toolCount += 1;
        if (tc.status === "failed") sawError = true;

        // A launching call becomes the child it launched. Its own shape says
        // nothing a reader wants — see `SubagentRow`.
        const child = opts.subagents?.[tc.id];
        if (child) {
          // Collected, not pushed here. A child outlives the moment it was
          // spawned — it keeps working while the parent writes prose and runs
          // its own tools — so a row left where the launch happened gets
          // buried mid-turn and goes on changing where nobody is looking.
          // They go at the END of the turn, together, which is also where
          // Claude Desktop puts them: one block, last thing before the footer.
          const id = `sa:${tc.id}`;
          const own = (childCalls.get(tc.id) ?? []).map((c) => markerFor(c, turnId, false));
          delegated.push({
            kind: RowKind.Subagent,
            id,
            turnId,
            firstInTurn: false,
            toolCallId: tc.id,
            name: child.name.trim() || "Subagent",
            status: child.status,
            role: child.role,
            prompt: child.prompt,
            result: child.result,
            startedAt: child.startedAtMs,
            endedAt: child.endedAtMs,
            markers: own,
            workCount: child.toolCallCount,
          });
          continue;
        }

        markers.push(markerFor(tc, turnId, false));
      }

      const prose = derivedProse(msg);
      if (prose) {
        flushMarkers();
        rows.push({
          kind: RowKind.Prose,
          id: `p:${msg.id}`,
          turnId,
          firstInTurn: rows.length === rowStart,
          text: prose,
          streaming: tail,
          showHeader: !headerShown,
          model: msg.model ?? null,
          timestamp: msg.timestamp,
          ...(msg.timestampApproximate && { timestampApproximate: true as const }),
        });
        headerShown = true;
      }

      // The footer data is frozen onto the trailing message at turn_finished.
      if (msg.turnSummary || msg.suggestions || msg.contextUsage) footerMsg = msg;
      if (msg.workedMs !== undefined) workedMs = msg.workedMs;
      if (msg.stopReason !== undefined) stopReason = msg.stopReason;
      if (msg.interruption) {
        interruption = msg.interruption;
        interruptedMsgId = msg.id;
        if (msg.interruption.outcome === "failed") sawError = true;
      }
      i += 1;
    }
    flushMarkers();
    for (const row of delegated) {
      row.firstInTurn = rows.length === rowStart;
      rows.push(row);
    }

    const turnIsLive = opts.streaming && i > lastIdx;
    if (turnIsLive) markLiveBlocks(rows, rowStart);

    const turnInProgress = (opts.turnInProgress ?? opts.streaming) && i > lastIdx;
    if (rows.length > rowStart) {
      foldWork(rows, rowStart, {
        turnId,
        live: turnInProgress,
        startedAt: turnInProgress ? turnStartMs(messages, turnFirstIdx) : null,
        workedMs,
        stopped: stopReason === "cancelled",
        expandedTurns: opts.expandedTurns,
      });
    }

    if (footerMsg?.turnSummary) {
      // The response's footer goes at the end of the response, below the
      // card, so it is the last thing the turn shows (see `ProseRow.footerBelow`).
      const response = footerResponse(rows, rowStart);
      rows.push({
        kind: RowKind.TurnFooter,
        id: `f:${footerMsg.id}`,
        turnId,
        firstInTurn: false,
        files: footerMsg.turnSummary.files,
        turnKey: stableTurnKey(messages, { start: turnFirstIdx, end: i }) ?? turnId,
        repoAtTurn: footerMsg.turnSummary.repoAtTurn,
        messageId: footerMsg.id,
        hasSuggestions: (footerMsg.suggestions?.chips.length ?? 0) > 0,
        contextChip: !!footerMsg.contextUsage || !!footerMsg.usage,
        ...(response && {
          responseRowId: response.id,
          responseText: response.text,
          responseTimestamp: response.timestamp,
          // No clock where the header has one, or where the time is a replay's.
          responseShowTimestamp: !response.showHeader && !response.timestampApproximate,
        }),
      });
    }

    if (interruption) {
      rows.push({
        kind: RowKind.Interruption,
        id: `x:${interruptedMsgId}`,
        turnId,
        firstInTurn: rows.length === rowStart,
        interruption,
        latest: i >= messages.length,
      });
    }

    if (rows.length > rowStart) {
      const firstMsg = messages[turnFirstIdx];
      turns.push({
        id: turnId,
        role: "assistant",
        rowStart,
        rowEnd: rows.length,
        messageIndex: turnFirstIdx,
        status: turnIsLive ? "streaming" : sawError ? "error" : "settled",
        preview: "",
        timestamp: firstMsg.timestamp,
        toolCount,
        fileCount: footerMsg?.turnSummary?.files.length ?? 0,
      });
    }
  }

  // Mark the first row of each turn now that splices are done, then place
  // the turn in the whole projection.
  for (const t of turns) {
    if (rows[t.rowStart]) rows[t.rowStart].firstInTurn = true;
    t.rowStart += offset;
    t.rowEnd += offset;
  }

  return {
    id: m.id,
    messages: messages.slice(start, end),
    before: messages[start - 1],
    final: end === messages.length,
    streaming: opts.streaming,
    turnInProgress: opts.turnInProgress ?? opts.streaming,
    expanded: opts.expanded,
    expandedTurns: opts.expandedTurns,
    subagents: opts.subagents,
    offset,
    start,
    rows,
    turns,
  };
}

/**
 * One-level equality for row/turn records. Arrays compare element-by-identity —
 * an array a projection rebuilds is still equal when its ELEMENTS are the same
 * stable records. (`TurnFooterRow.files` is the frozen `turnSummary.files`
 * itself, so it compares equal by identity before that.)
 */
function sameShallow(a: object, b: object): boolean {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const va = (a as Record<string, unknown>)[k];
    const vb = (b as Record<string, unknown>)[k];
    if (va === vb) continue;
    if (Array.isArray(va) && Array.isArray(vb) && va.length === vb.length) {
      let eq = true;
      for (let i = 0; i < va.length; i++) {
        if (va[i] !== vb[i]) {
          eq = false;
          break;
        }
      }
      if (eq) continue;
    }
    return false;
  }
  return true;
}

/** When the live clock of the assistant turn at `firstIdx` starts: the user
 *  message it answers. Null when there is none to count from. */
function turnStartMs(messages: ChatMessage[], firstIdx: number): number | null {
  const prev = messages[firstIdx - 1];
  if (!prev || prev.role !== "user") return null;
  const t = Date.parse(prev.timestamp);
  return Number.isFinite(t) ? t : null;
}

/** Faint "N ago" divider marking a real pause between turns. */
function maybeGapSeparator(rows: Row[], messages: ChatMessage[], i: number, turnId: string): void {
  if (i === 0) return;
  // A replayed message's time is when Atlas replayed it, so a pause measured
  // against it is no pause the conversation had.
  if (messages[i].timestampApproximate || messages[i - 1].timestampApproximate) return;
  const row = gapSeparator(
    messages[i - 1].timestamp,
    messages[i].timestamp,
    `gs:${messages[i].id}`,
    turnId,
  );
  if (row) rows.push(row);
}
