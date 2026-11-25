// What the permission card says about a tool call, in the transcript's words:
// the glyph and action its line will show once it runs ("Run a command",
// "Read main.rs"), the agent's own description of it, the command as shell
// text, and any other input as named fields.
//
// The card used to print the call's whole input as JSON. A command went in as
// a JSON string, so its line breaks and quotes came out as `\n` and `\"` —
// unreadable exactly where the user is deciding whether to run it. The command
// is the thing being approved, so it is drawn as itself, and never cut.
//
// ACP puts no limit on a tool call's `title`, and agents use it for different
// things: the native agent sends the command as the title and no input at
// all, the Claude adapter sends the command in backticks, and Claude's Bash
// sends a prose description with the command in its input. The card's
// headline is one line with no scroll, so a title only reaches it when it is
// short prose; a command always goes to the scrolling box.

import {
  mcpToolOf,
  parseShellCommand,
  shortPath,
  toolDisplayName,
  toolIconFor,
  type MarkerTool,
} from "@tryatlas/design/session";
import type { ToolCallRef } from "@/types/acp";

/** The longest title the headline takes, in characters, on one line. */
export const HEADLINE_MAX = 80;

/** The cap on one input field's text. A command is never cut: the user is
 *  approving all of it. */
const FIELD_MAX = 4000;

export interface PermissionField {
  /** The input's own key, e.g. `file_path`. */
  name: string;
  /** Its value as text: strings as they are, anything else as JSON. */
  value: string;
}

export interface PermissionSummary {
  /** The glyph the transcript gives this kind of call. */
  tool: MarkerTool;
  /** What the call will do, as the headline: "Run a command", "Read main.rs",
   *  or the agent's own short title for a call that is not a command. */
  action: string;
  /** The agent's account of why, under the headline. Null when it sent none,
   *  or when its title was the command itself. */
  description: string | null;
  /** The third-party MCP server the call goes to, beside the headline: which
   *  server gets the data is part of what is being approved. */
  source: string | null;
  /** The shell text being approved, drawn as code. Null for no command. */
  command: string | null;
  /** The rest of the input, one row per key. */
  fields: PermissionField[];
}

export function permissionSummaryOf(toolCall: ToolCallRef): PermissionSummary {
  const input = toolCall.rawInput ?? (toolCall as Record<string, unknown>).input;
  const record = isRecord(input) ? input : null;
  const toolName = toolCall.toolName ?? "";
  const mcp = toolName ? mcpToolOf(toolName) : null;
  // A title that is only the tool's raw name (`mcp__linear__save_issue`) says
  // less than the name read as words, so it counts as no title.
  const rawTitle = toolCall.title?.trim() || null;
  const title = rawTitle === toolName ? null : rawTitle;
  const fits = title !== null && title.length <= HEADLINE_MAX && !/[\r\n]/.test(title);
  const source = mcp?.server ?? null;

  // The command: from the input, or — for an `execute` call that sent none —
  // the title, which is where the native agent puts it. Only a shell call's
  // `command` is one: a third-party tool may name a parameter that too.
  const shell = toolCall.kind === "execute" || (toolCall.kind === undefined && !mcp);
  const inputCommand = shell ? stringField(record, "command") : null;
  const command =
    inputCommand ?? (toolCall.kind === "execute" && title !== null ? unwrapCommand(title) : null);
  const titleIsCommand =
    title !== null && command !== null && sameCommand(title, command, inputCommand === null);

  const inputDescription = stringField(record, "description");
  const prose = title !== null && !titleIsCommand ? title : null;

  // The line under the headline: the agent's prose title, else its input's
  // description. A non-command call's short title is the headline itself
  // ("Edit main.rs", "Fetch https://…"), so only a long one moves under it.
  const proseLine = command !== null || !fits ? prose : null;
  const description = proseLine ?? inputDescription;

  // Keys drawn above the fields, so not repeated as one. A description the
  // prose line did not stand in for stays a field: nothing is dropped.
  const shown = new Set<string>();
  if (inputCommand !== null) shown.add("command");
  if (inputDescription !== null && (proseLine === null || proseLine === inputDescription)) {
    shown.add("description");
  }
  const fields = fieldsOf(input, shown);

  if (command !== null) {
    const { tool, action } = commandAction(command);
    return { tool, action, description, command, fields, source };
  }

  return {
    tool: mcp?.server === "browser" ? "browser" : toolIconFor(toolCall.kind, toolName),
    action: fits ? title : nounFor(toolCall.kind, toolName),
    description,
    source,
    command: null,
    fields,
  };
}

/** The transcript's reading of a command: one action it comes down to
 *  (`cat src/main.rs` → Read main.rs), or "Run a command". */
function commandAction(command: string): { tool: MarkerTool; action: string } {
  const parsed = parseShellCommand(command);
  switch (parsed.kind) {
    case "read":
      return { tool: "read", action: `Read ${shortPath(parsed.path)}` };
    case "list":
      return {
        tool: "list",
        action: parsed.path ? `List files in ${shortPath(parsed.path)}` : "List files",
      };
    case "search":
      return {
        tool: "search",
        action: parsed.query ? `Search for ${parsed.query}` : "Search files",
      };
    case "run":
      return { tool: "run", action: "Run a command" };
  }
}

/** The headline for a call with no usable title: a named tool as the
 *  transcript names it ("Save issue", "Find symbol"), else its kind. */
function nounFor(kind: string | undefined, toolName: string): string {
  if (toolName) return mcpToolOf(toolName)?.tool ?? toolDisplayName(toolName);
  switch (kind) {
    case "edit":
      return "Edit a file";
    case "read":
      return "Read a file";
    case "delete":
      return "Delete a file";
    case "move":
      return "Move a file";
    case "search":
      return "Search files";
    case "fetch":
      return "Fetch a page";
  }
  return "Use a tool";
}

/** Every input key not already drawn elsewhere, in the agent's order. A
 *  non-object input is one unnamed field. */
function fieldsOf(input: unknown, shown: ReadonlySet<string>): PermissionField[] {
  if (input === undefined || input === null) return [];
  if (!isRecord(input)) return [{ name: "", value: textOf(input) }];
  return Object.entries(input)
    .filter(([name, value]) => !shown.has(name) && value !== undefined)
    .map(([name, value]) => ({ name, value: textOf(value) }));
}

/** The longest one-line form a small object is drawn in; past it, the
 *  object is drawn as indented JSON. */
const INLINE_MAX = 60;

/** A value as the user would write it: text as it is, a list of plain values
 *  as a list (`bug, ui`), a small flat object on one line (`{ id: ATL-978 }`),
 *  and only what is left as indented JSON. */
function textOf(value: unknown): string {
  const text = typeof value === "string" ? value : (inlineOf(value) ?? jsonOf(value));
  return text.length > FIELD_MAX ? `${text.slice(0, FIELD_MAX)}\n…(truncated)` : text;
}

function inlineOf(value: unknown): string | null {
  if (isScalar(value)) return String(value);
  if (Array.isArray(value)) {
    return value.length > 0 && value.every(isPlain) ? value.map(String).join(", ") : null;
  }
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || !entries.every(([k, v]) => isPlain(k) && isPlain(v))) return null;
  const line = `{ ${entries.map(([k, v]) => `${k}: ${String(v)}`).join(", ")} }`;
  return line.length <= INLINE_MAX ? line : null;
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

/** A scalar that reads the same unquoted inside a one-line list or object:
 *  no separator, brace or line break of its own to misread as structure. */
function isPlain(value: unknown): boolean {
  return isScalar(value) && !(typeof value === "string" && /[,:{}\r\n]/.test(value));
}

function jsonOf(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** A title wrapped in backticks with the command's own backticks escaped —
 *  the Claude adapter's form — as the bare command. */
function unwrapCommand(title: string): string {
  return title.length > 1 && title.startsWith("`") && title.endsWith("`")
    ? title.slice(1, -1).replaceAll("\\`", "`")
    : title;
}

/** Whether a title is its command again, as it is or backticked. A command
 *  taken from the title is the title by construction. */
function sameCommand(title: string, command: string, fromTitle: boolean): boolean {
  if (fromTitle) return true;
  return title === command.trim() || unwrapCommand(title) === command.trim();
}
