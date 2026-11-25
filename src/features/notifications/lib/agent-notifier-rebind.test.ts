// @vitest-environment happy-dom
//
// A finish after a reopen is announced. Rust restarts turn_seq at every bind,
// the same session id included, and delivery dedupes a key for the window's
// life: keyed on `session:turn_seq` alone, the first turns after a reopen or a
// restarted agent reused keys already delivered and were swallowed. The key
// carries the bind epoch now; a re-delivery within one bind still dedupes.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
const deliverNotification = vi.hoisted(() => vi.fn((_decision: unknown) => true));
vi.mock("./deliver", () => ({
  deliverNotification,
  notificationToastId: vi.fn(),
  openNotificationTarget: vi.fn(),
}));
vi.mock("@/lib/window-focus", () => ({
  isWindowFocused: () => false,
  lastInteraction: () => 0,
}));

import { useChatStore } from "@/features/chat/stores/chat-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import type { AgentDelta } from "@/types/agents";
import { isNewBind, turnNonce } from "./agent-notifier-rules";
import { notifyAgentEvent } from "./agent-notifier";

const finished = (turnSeq: number) =>
  ({
    kind: "turn_finished",
    agent_id: "agent-1",
    session_id: "acp-1",
    stop_reason: "end_turn",
    turn_seq: turnSeq,
  }) as unknown as AgentDelta;

const doneKeys = () =>
  deliverNotification.mock.calls
    .map(([d]) => d as { kind: string; dedupeKey: string })
    .filter((d) => d.kind === "agent-done")
    .map((d) => d.dedupeKey);

const bind = () =>
  useChatStore.getState().actions.setAcpBinding("chat-1", "agent-1", "acp-1", "/work");

/** What `turn_finished` does to the tab before the notifier hears it. */
const ranTurn = (turnSeq: number) =>
  useChatStore.setState((s) => ({
    sessions: { ...s.sessions, "chat-1": { ...s.sessions["chat-1"], currentTurnSeq: turnSeq } },
  }));

beforeEach(() => {
  deliverNotification.mockClear();
  useLayoutStore.setState({ activeTabId: "other" } as never);
  useChatStore.setState({ sessions: {} });
  useChatStore.getState().actions.createSession("chat-1", "atlas-agent");
});

describe("finish notifications across a rebind", () => {
  it("announces the first turn after the same session is bound again", () => {
    bind();
    ranTurn(1);
    notifyAgentEvent(finished(1));
    // A re-delivery of the same turn, same bind: deduped by its key.
    notifyAgentEvent(finished(1));
    bind();
    ranTurn(1);
    notifyAgentEvent(finished(1));

    const keys = doneKeys();
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });
});

describe("isNewBind", () => {
  it("is a bind when a tab takes a session, or the same one's turn mark resets", () => {
    expect(isNewBind(undefined, { acpSessionId: "a" })).toBe(true);
    expect(isNewBind({ acpSessionId: "b" }, { acpSessionId: "a" })).toBe(true);
    expect(
      isNewBind({ acpSessionId: "a", currentTurnSeq: 3 }, { acpSessionId: "a", currentTurnSeq: 0 }),
    ).toBe(true);
  });

  it("is not a bind when a turn moves on, or nothing is bound", () => {
    expect(
      isNewBind({ acpSessionId: "a", currentTurnSeq: 1 }, { acpSessionId: "a", currentTurnSeq: 2 }),
    ).toBe(false);
    expect(isNewBind({ acpSessionId: "a" }, {})).toBe(false);
  });

  it("names a turn by bind and seq", () => {
    expect(turnNonce(2, 1)).not.toBe(turnNonce(1, 1));
  });
});
