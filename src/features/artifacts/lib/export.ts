/**
 * Take a Session out of Atlas.
 *
 * Two formats because there are two reasons to want one: **JSON** is the record
 * as the store holds it — every field, machine-readable, suitable for a script
 * or a bug report — and **Markdown** is the record as a person reads it, which
 * is what gets pasted into a ticket or a review.
 *
 * Both formats hydrate the complete persisted payloads before writing; the
 * screen can show previews while the export preserves the full Session.
 * Scrubbing already happened before persistence, so neither redacts further.
 */

import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";

import { agentMeta } from "@/features/agents/lib/agent-meta";
import { agentLabel, formatDuration, prettyModel, tokenLabel } from "./board";
import type { SessionDetail, TimelineEntry } from "../types";
import { formatDateTime, formatTime } from "@/lib/format-time";
import { cloudPayload, localPayload } from "./payload-api";
import type { PayloadPart } from "./session-timeline";

export type ExportFormat = "json" | "md";

export interface ExportSource {
  projectPath: string;
  remoteProjectId: string | null;
  entriesReady: boolean;
}

/** Resolve every preview before writing. A failed read leaves no partial export. */
export async function completeSession(
  detail: SessionDetail,
  source: ExportSource,
): Promise<SessionDetail> {
  if (!source.entriesReady) throw new Error("Wait for the complete timeline before exporting.");
  const entries: TimelineEntry[] = [];
  const expand = async (entry: TimelineEntry): Promise<TimelineEntry> => {
    const full = { ...entry };
    const payload = async (part: PayloadPart, ref: string | null): Promise<string> => {
      const value = ref
        ? await localPayload(source.projectPath, ref)
        : source.remoteProjectId
          ? await cloudPayload(source.remoteProjectId, detail.summary.id, entry.id, part)
          : null;
      if (!value) throw new Error(`The full ${part} for entry ${entry.id} is unavailable.`);
      return value.text ?? `[Binary payload: ${value.bytes} bytes]`;
    };
    if (entry.truncated || entry.bodyRef) {
      full.text = await payload("body", entry.bodyRef);
      full.truncated = false;
    }
    if (entry.kind === "tool_call") {
      if (entry.argumentsRef || (source.remoteProjectId && entry.arguments !== null)) {
        full.arguments = await payload("arguments", entry.argumentsRef);
      }
      if (entry.resultRef || (source.remoteProjectId && entry.result !== null)) {
        full.result = await payload("result", entry.resultRef);
      }
    }
    return full;
  };
  for (let start = 0; start < detail.entries.length; start += 4) {
    entries.push(...(await Promise.all(detail.entries.slice(start, start + 4).map(expand))));
  }
  return { ...detail, entries };
}

/**
 * A filename someone can find again.
 *
 * The title leads because that is what the Session is *about*; the id tails it
 * so two exports of two similarly-named Sessions never collide.
 */
function filename(detail: SessionDetail, format: ExportFormat): string {
  const title = (detail.summary.title ?? "session")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${title || "session"}-${detail.summary.id.slice(-8)}.${format}`;
}

/**
 * Prompt for a location and write the Session there.
 *
 * Resolves `false` when the dialog is dismissed, which is not an error and must
 * not be reported as one.
 */
export async function exportSession(
  detail: SessionDetail,
  format: ExportFormat,
  source: ExportSource,
): Promise<boolean> {
  if (!source.entriesReady) throw new Error("Wait for the complete timeline before exporting.");
  const path = await save({
    defaultPath: filename(detail, format),
    filters: [
      format === "json"
        ? { name: "JSON", extensions: ["json"] }
        : { name: "Markdown", extensions: ["md"] },
    ],
  });
  if (!path) return false;
  const complete = await completeSession(detail, source);
  // `write_file_content` rather than the fs plugin: the plugin is not in the
  // capability set, and this command is already how the canvas export writes.
  await invoke("write_file_content", {
    path,
    content: format === "json" ? toJson(complete) : toMarkdown(complete),
  });
  return true;
}

function toJson(detail: SessionDetail): string {
  return JSON.stringify(detail, null, 2);
}

function toMarkdown(detail: SessionDetail): string {
  const s = detail.summary;
  const lines: string[] = [];

  lines.push(`# ${s.title ?? "Untitled session"}`, "");
  lines.push(`- **Agent** — ${s.agent ? agentLabel(s.agent, agentMeta) : "unknown"}`);
  if (s.model) lines.push(`- **Model** — ${prettyModel(s.model)}`);
  if (s.branches[0]) lines.push(`- **Branch** — \`${s.branches[0]}\``);
  lines.push(`- **Started** — ${formatDateTime(s.startedAt)}`);
  lines.push(`- **Duration** — ${formatDuration(s.activeSeconds)}`);
  const tokens = tokenLabel(s);
  if (tokens) lines.push(`- **Tokens** — ${tokens}`);
  lines.push(`- **Tool calls** — ${s.toolCallCount}`);
  if (s.checkpointCount > 0) lines.push(`- **Checkpoints** — ${s.checkpointCount}`);
  lines.push("");

  for (const entry of detail.entries) {
    lines.push(...entryMarkdown(entry), "");
  }
  return lines.join("\n");
}

function entryMarkdown(entry: TimelineEntry): string[] {
  const at = formatTime(entry.at, { timeStyle: "medium" });
  switch (entry.kind) {
    case "prompt":
      return [`## Prompt · ${at}`, "", fence(entry.text ?? "")];
    case "response":
      // Responses are already markdown, so they are inlined rather than fenced —
      // fencing them would export a wall of literal backticks.
      return [`## Response · ${at}`, "", entry.text ?? ""];
    case "thinking":
      return [`## Thinking · ${at}`, "", fence(entry.text ?? "")];
    case "tool_call": {
      const head = `## ${entry.toolName ?? "Tool call"} · ${at}${
        entry.toolStatus === "failed" ? " — failed" : ""
      }`;
      const out = [head, ""];
      if (entry.paths.length) out.push(entry.paths.map((p) => `\`${p}\``).join(" "), "");
      if (entry.arguments) out.push("**Arguments**", "", fence(entry.arguments, "json"));
      if (entry.result) out.push("**Result**", "", fence(entry.result));
      return out;
    }
    case "checkpoint": {
      const sha = entry.commitSha?.slice(0, 7) ?? "unknown";
      const stat =
        entry.insertions || entry.deletions ? ` (+${entry.insertions} −${entry.deletions})` : "";
      const out = [`## Checkpoint \`${sha}\` · ${at}`, "", entry.commitSubject ?? "_no subject_"];
      if (stat) out.push("", `Changed${stat}:`);
      if (entry.files.length) out.push("", ...entry.files.map((f) => `- \`${f}\``));
      return out;
    }
  }
}

/**
 * Fence a payload without letting it break out.
 *
 * A result containing its own triple backtick would end the block early and
 * spill the rest as prose, so the fence grows past the longest run inside it.
 */
function fence(text: string, language = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = "`".repeat(longest + 1);
  return `${ticks}${language}\n${text}\n${ticks}`;
}
