// @vitest-environment happy-dom
//
// A jump to a pin lands on the pinned row, whatever row it is. The pin jump
// sent only a message index, and the transcript resolves an index against
// turn starts: an answer that follows a thought or a tool call is not its
// turn's first message, so the jump found no turn and went nowhere.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { act, cleanup, renderHook } from "@testing-library/react";
import { emitWindowEvent } from "@/lib/window-events";
import type { ChatMessage } from "@/types/agent";
import { messageJump } from "../lib/jump-to-comment";
import { projectRows } from "../lib/turn-rows";
import { useTranscriptJumps } from "./use-transcript-jumps";

afterEach(cleanup);

const msg = (id: string, role: "user" | "assistant", extra: Partial<ChatMessage> = {}) =>
  ({
    id,
    role,
    content: "",
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: "2026-11-25T00:00:00Z",
    ...extra,
  }) as ChatMessage;

// A prompt, then a turn that thinks before it answers: the answer is the
// turn's second message.
const MESSAGES = [
  msg("m1", "user", { content: "why?" }),
  msg("m2", "assistant", { mode: "thinking", thinking: "Let me look." } as Partial<ChatMessage>),
  msg("m3", "assistant", { content: "Because." }),
];

function mount() {
  const projection = projectRows(MESSAGES, {
    expanded: new Set(),
    streaming: false,
    expandedTurns: new Set(["wk:t:m2"]),
  });
  const pendingAnchorRef = { current: null as string | null };
  renderHook(() =>
    useTranscriptJumps({
      tabId: "chat-1",
      cacheKey: "k",
      projection,
      rows: projection.rows,
      scrollRef: { current: null },
      reveal: vi.fn(),
      setExpandedTurns: vi.fn(),
      pendingAnchorRef,
      pendingHighlightRef: { current: null },
      lastSeenLen: { current: 0 },
      setNewCount: vi.fn(),
    }),
  );
  return { projection, pendingAnchorRef };
}

describe("jumping to a pinned answer mid-turn", () => {
  it("lands on the answer's own row", () => {
    const { projection, pendingAnchorRef } = mount();
    expect(projection.rows.some((r) => r.id === "p:m3")).toBe(true);
    act(() => emitWindowEvent("atlas:chat-jump", messageJump(MESSAGES, 2, "chat-1")));
    expect(pendingAnchorRef.current).toBe("p:m3");
  });
});
