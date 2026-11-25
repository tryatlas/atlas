import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDetail, TimelineEntry } from "../types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
vi.mock("@/features/agents/lib/agent-meta", () => ({ agentMeta: () => undefined }));

import { completeSession, exportSession } from "./export";

const source = { projectPath: "/project", remoteProjectId: null, entriesReady: true };
const entry = (extra: Partial<TimelineEntry> = {}): TimelineEntry => ({
  id: "entry",
  kind: "response",
  at: "2026-11-24T00:00:00Z",
  turnSeq: 1,
  text: "preview",
  truncated: true,
  bodyBytes: 80_000,
  bodyRef: "body-blob",
  toolName: null,
  toolTitle: null,
  toolStatus: null,
  paths: [],
  arguments: null,
  argumentsRef: null,
  result: null,
  resultRef: null,
  resultBinary: false,
  commitSha: null,
  commitSubject: null,
  branch: null,
  linkState: null,
  insertions: 0,
  deletions: 0,
  files: [],
  ...extra,
});
const detail = (entries: TimelineEntry[]): SessionDetail => ({
  summary: {
    id: "session",
    title: "Complete export",
    agent: null,
    model: null,
    source: "native",
    startedAt: "2026-11-24T00:00:00Z",
    updatedAt: "2026-11-24T00:01:00Z",
    lastActivityAt: "2026-11-24T00:01:00Z",
    activeSeconds: 60,
    wallSeconds: 60,
    messageCount: 1,
    toolCallCount: 0,
    checkpointCount: 0,
    branches: [],
    insertions: 0,
    deletions: 0,
    filesTouched: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    contextUsed: null,
    contextSize: null,
    needsAttention: false,
    attentionReason: null,
  },
  entries,
  counts: { prompts: 0, responses: 1, thinking: 0, toolCalls: 0, checkpoints: 0 },
  tools: [],
});

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.save.mockReset().mockResolvedValue("/export/session.json");
});

describe("complete Session exports", () => {
  it("writes the full local payload and leaves the screen preview unchanged", async () => {
    const body = "complete body\n".repeat(8_000);
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "artifacts_payload" ? { text: body, binary: false, bytes: body.length } : null,
    );
    const preview = detail([entry()]);
    expect(await exportSession(preview, "json", source)).toBe(true);
    const write = mocks.invoke.mock.calls.find(([command]) => command === "write_file_content");
    expect(JSON.parse(write![1].content).entries[0]).toMatchObject({
      text: body,
      truncated: false,
    });
    expect(preview.entries[0].text).toBe("preview");
  });

  it("loads tool arguments and results from the owning cloud Session", async () => {
    mocks.invoke.mockImplementation(async (_command: string, args: { part: string }) => ({
      text: `full ${args.part}`,
      binary: false,
      bytes: 70_000,
    }));
    const result = await completeSession(
      detail([
        entry({
          kind: "tool_call",
          truncated: false,
          bodyRef: null,
          arguments: "args preview",
          result: "result preview",
        }),
      ]),
      { ...source, remoteProjectId: "remote-project" },
    );
    expect(result.entries[0]).toMatchObject({ arguments: "full arguments", result: "full result" });
    expect(mocks.invoke).toHaveBeenCalledWith("artifacts_cloud_payload", {
      projectId: "remote-project",
      sessionId: "session",
      rowId: "entry",
      part: "result",
    });
  });

  it("does not write an incomplete export when a payload read fails", async () => {
    mocks.invoke.mockRejectedValue(new Error("network unavailable"));
    await expect(exportSession(detail([entry()]), "md", source)).rejects.toThrow(
      "network unavailable",
    );
    expect(mocks.invoke.mock.calls.some(([command]) => command === "write_file_content")).toBe(
      false,
    );
  });

  it("refuses a timeline still loading and performs no work after cancellation", async () => {
    await expect(
      exportSession(detail([]), "json", { ...source, entriesReady: false }),
    ).rejects.toThrow("complete timeline");
    expect(mocks.save).not.toHaveBeenCalled();
    mocks.save.mockResolvedValue(null);
    expect(await exportSession(detail([entry()]), "json", source)).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
