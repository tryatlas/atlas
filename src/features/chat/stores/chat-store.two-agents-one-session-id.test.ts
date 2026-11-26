// @vitest-environment happy-dom
//
// #86: ACP scopes a session id to its connection, so two agents can both
// answer `"1"`. Two tabs bound to the same session id under different agents
// are two conversations: a lookup that names the agent finds its own tab, and
// a delta from one agent never lands in the other agent's transcript.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import type { AgentDelta } from "@/types/agents";
import type { ChatSession } from "@/types/agent";
import { findTabByAcpSession, useChatStore } from "./chat-store";

const SAME = "1";

const tabOf = (acpSessionId: string, acpAgentId?: string) =>
  ({ acpSessionId, acpAgentId }) as unknown as ChatSession;

describe("findTabByAcpSession", () => {
  const sessions = { "tab-a": tabOf(SAME, "agent-a"), "tab-b": tabOf(SAME, "agent-b") };

  it("finds each agent's own tab when the agent is named", () => {
    expect(findTabByAcpSession(sessions, SAME, "agent-a")).toBe("tab-a");
    expect(findTabByAcpSession(sessions, SAME, "agent-b")).toBe("tab-b");
  });

  it("never answers with another agent's tab", () => {
    expect(findTabByAcpSession(sessions, SAME, "agent-c")).toBeNull();
    expect(findTabByAcpSession({ "tab-a": tabOf(SAME, "agent-a") }, SAME, "agent-b")).toBeNull();
  });

  it("falls back to a tab whose agent is not known yet, after an exact match", () => {
    const restored = { "tab-r": tabOf(SAME), "tab-b": tabOf(SAME, "agent-b") };
    expect(findTabByAcpSession(restored, SAME, "agent-b")).toBe("tab-b");
    expect(findTabByAcpSession(restored, SAME, "agent-a")).toBe("tab-r");
  });

  it("matches by the session id alone when no agent is named", () => {
    expect(findTabByAcpSession(sessions, SAME)).toBe("tab-a");
    expect(findTabByAcpSession(sessions, "other")).toBeNull();
  });
});

describe("a delta for one of two agents sharing a session id", () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {},
      pendingPermissions: {},
      queues: {},
      queueIds: {},
      drafts: {},
      activeSessionId: null,
    });
    const { actions } = useChatStore.getState();
    actions.createSession("tab-a", "claude-code");
    actions.setAcpBinding("tab-a", "agent-a", SAME, "/tmp/a");
    actions.createSession("tab-b", "codex");
    actions.setAcpBinding("tab-b", "agent-b", SAME, "/tmp/b");
  });

  it("binding the second agent's tab leaves the first agent's tab bound", () => {
    const tab = (id: string) => useChatStore.getState().sessions[id];
    expect(tab("tab-a")).toMatchObject({ acpAgentId: "agent-a", acpSessionId: SAME });
    expect(tab("tab-b")).toMatchObject({ acpAgentId: "agent-b", acpSessionId: SAME });
  });

  it("lands in that agent's tab only", () => {
    const delta = {
      kind: "text_chunk",
      agent_id: "agent-b",
      session_id: SAME,
      seq: 0,
      delta: "from b",
    } as unknown as AgentDelta;
    useChatStore.getState().actions.applyAgentDelta(delta);
    const text = (tab: string) =>
      useChatStore
        .getState()
        .sessions[tab].messages.map((m) => m.content)
        .join("");
    expect(text("tab-b")).toBe("from b");
    expect(text("tab-a")).toBe("");
  });
});
