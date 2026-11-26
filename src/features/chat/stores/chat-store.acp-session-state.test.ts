// @vitest-environment happy-dom
//
// Session state the store keeps from what the agent said, each case one ACP
// audit finding the store got wrong: lists an empty answer must clear (39),
// questions that must queue and close (41), a stray in-flight call on an idle
// session (82), a result sent only as `rawOutput` (100), a plan that outlives
// its turn (102), and the usage footer for any agent that reports usage (26).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import type { AgentDelta, ToolCall } from "@/types/agents";
import type { SwitchableAgent } from "@/types/agent";
import { loadCachedAcpModels, saveCachedAcpModels } from "../lib/acp-models-cache";
import { loadCachedAcpModes, saveCachedAcpModes } from "../lib/acp-modes-cache";
import { useChatStore } from "./chat-store";

const TAB = "tab-1";
const AGENT = "agent-1";
const ACP = "acp-1";

type Kind = AgentDelta["kind"];
type Body<K extends Kind> = Omit<
  Extract<AgentDelta, { kind: K }>,
  "kind" | "agent_id" | "session_id" | "seq"
>;
function d<K extends Kind>(kind: K, body: Body<K>, session = ACP): AgentDelta {
  return { kind, agent_id: AGENT, session_id: session, seq: 0, ...body } as unknown as AgentDelta;
}
const apply = (...deltas: AgentDelta[]) => {
  for (const delta of deltas) useChatStore.getState().actions.applyAgentDelta(delta);
};
const session = () => useChatStore.getState().sessions[TAB];
const actions = () => useChatStore.getState().actions;
const lastMessage = () => session().messages[session().messages.length - 1];

function boundTab(agentType: SwitchableAgent = "codex", acp = ACP) {
  actions().createSession(TAB, agentType);
  actions().setAcpBinding(TAB, AGENT, acp, "/tmp/project");
  actions().addMessage(TAB, "user", "go");
}

function wireTool(id: string, over: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    tool_name: "lookup",
    title: null,
    kind: "other",
    status: "completed",
    arguments: {},
    result: null,
    locations: [],
    ...over,
  };
}

const MODELS = [{ id: "m-1", name: "Model one" }];

beforeEach(() => {
  localStorage.clear();
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    queueIds: {},
    queueContent: {},
    activeSessionId: null,
  });
  // Module state keyed by ACP session id: forget what earlier cases heard.
  actions().resetSessions();
});

describe("an empty answer clears cached lists (ACP audit finding 39)", () => {
  it("models: a list only the cache stood behind goes, the cache with it", () => {
    saveCachedAcpModels("codex", { availableModels: MODELS });
    boundTab();
    expect(session().acpAvailableModels).toEqual(MODELS);

    actions().setAcpModels(TAB, null, []);

    expect(session().acpAvailableModels).toEqual([]);
    expect(loadCachedAcpModels("codex")).toBeNull();
  });

  it("models: an empty snapshot after this session's own list is stale, and ignored", () => {
    boundTab();
    actions().setAcpModels(TAB, "m-1", MODELS);
    actions().setAcpModels(TAB, null, []);
    expect(session().acpAvailableModels).toEqual(MODELS);
    expect(loadCachedAcpModels("codex")?.availableModels).toEqual(MODELS);
  });

  it("modes: an empty answer drops the cached modes", () => {
    saveCachedAcpModes("codex", {
      currentMode: "ask",
      availableModes: [{ id: "ask", name: "Ask" }],
    });
    boundTab();
    actions().setAcpModes(TAB, null, []);
    expect(loadCachedAcpModes("codex")).toBeNull();
  });

  it("commands: a list another session delivered goes when this one answers empty", () => {
    boundTab("codex", "acp-old");
    actions().setAcpAvailableCommands(TAB, [{ name: "old" }]);
    actions().setAcpBinding(TAB, AGENT, ACP, "/tmp/project");
    actions().setAcpAvailableCommands(TAB, []);
    expect(session().availableCommands).toEqual([]);
  });

  it("commands: this session's own live list survives an empty snapshot", () => {
    boundTab();
    apply(d("available_commands", { commands: [{ name: "review" }] }));
    actions().setAcpAvailableCommands(TAB, []);
    expect(session().availableCommands).toEqual([{ name: "review" }]);
  });

  it("options: a cached list goes when the session answers empty", () => {
    boundTab();
    // What `switchChatAgent` seeds from the per-agent cache.
    useChatStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [TAB]: { ...s.sessions[TAB], acpConfigOptions: [{ id: "effort" }] },
      },
    }));
    actions().setAcpConfigOptions(TAB, []);
    expect(session().acpConfigOptions).toEqual([]);
  });
});

describe("elicitations queue, and a withdrawn one closes (ACP audit finding 41)", () => {
  const ask = (id: string) =>
    d("elicitation_requested", {
      request_id: id,
      mode: "form",
      message: `question ${id}`,
      requested_schema: null,
      url: null,
    });

  it("a second question waits behind the first, and shows once the first is answered", () => {
    boundTab();
    apply(ask("e-1"), ask("e-2"));
    expect(session().pendingElicitation?.requestId).toBe("e-1");

    actions().clearElicitation(TAB, "e-1");
    expect(session().pendingElicitation?.requestId).toBe("e-2");
    actions().clearElicitation(TAB);
    expect(session().pendingElicitation).toBeUndefined();
  });

  it("closing a waiting one by id leaves the one shown", () => {
    boundTab();
    apply(ask("e-1"), ask("e-2"));
    actions().clearElicitation(TAB, "e-2");
    expect(session().pendingElicitation?.requestId).toBe("e-1");
    actions().clearElicitation(TAB, "e-1");
    expect(session().pendingElicitation).toBeUndefined();
  });

  it("the same question reported again is not queued twice", () => {
    boundTab();
    apply(ask("e-1"), ask("e-1"));
    actions().clearElicitation(TAB, "e-1");
    expect(session().pendingElicitation).toBeUndefined();
  });

  it("the turn ending withdraws every open question", () => {
    boundTab();
    apply(d("status", { status: "running", turn_seq: 1 }), ask("e-1"), ask("e-2"));
    apply(d("turn_finished", { stop_reason: "cancelled", turn_seq: 1 }));
    expect(session().pendingElicitation).toBeUndefined();
    expect(session().queuedElicitations).toBeUndefined();
  });
});

describe("an in-flight call on an idle session (ACP audit finding 82)", () => {
  it("is drawn but does not mark the session busy", () => {
    boundTab();
    expect(session().status).toBe("idle");
    apply(
      d("tool_call_upserted", {
        message_id: "t",
        tool_call: wireTool("late", { status: "running" }),
      }),
    );
    expect(lastMessage().toolCalls[0].id).toBe("late");
    expect(session().inflightToolIds?.late).toBeUndefined();
  });

  it("during a turn it is tracked as before", () => {
    boundTab();
    apply(
      d("status", { status: "running", turn_seq: 1 }),
      d("tool_call_upserted", {
        message_id: "t",
        tool_call: wireTool("ls", { status: "running" }),
      }),
    );
    expect(session().inflightToolIds).toEqual({ ls: true });
  });
});

describe("a result sent only as rawOutput (ACP audit finding 100)", () => {
  it("shows the raw output when there is no content", () => {
    boundTab();
    apply(
      d("tool_call_upserted", {
        message_id: "t",
        tool_call: wireTool("mcp", { raw_output: { rows: 3 } }),
      }),
    );
    expect(lastMessage().toolCalls[0].result).toBe(JSON.stringify({ rows: 3 }, null, 2));
  });

  it("a string raw output goes as it is; content still wins when there is some", () => {
    boundTab();
    apply(
      d("tool_call_upserted", {
        message_id: "t",
        tool_call: wireTool("a", { raw_output: "done" }),
      }),
      d("tool_call_upserted", {
        message_id: "t",
        tool_call: wireTool("b", { result: "text", raw_output: { ignored: true } }),
      }),
    );
    const calls = lastMessage().toolCalls;
    expect(calls.map((c) => c.result)).toEqual(["done", "text"]);
  });
});

describe("the plan lives until replaced (ACP audit finding 102)", () => {
  it("a new turn keeps the plan, and the plan keeps its priorities", () => {
    boundTab();
    apply(
      d("status", { status: "running", turn_seq: 1 }),
      d("plan_updated", {
        plan: [
          { content: "write it", status: "completed", priority: "high" },
          { content: "test it", status: "pending" },
        ],
      }),
      d("turn_finished", { stop_reason: "end_turn", turn_seq: 1 }),
      d("status", { status: "idle", turn_seq: 1 }),
      d("status", { status: "running", turn_seq: 2 }),
    );
    expect(session().livePlan).toEqual([
      { id: "plan-0", description: "write it", status: "completed", priority: "high" },
      { id: "plan-1", description: "test it", status: "pending" },
    ]);
  });

  it("a snapshot's plan keeps its priorities too", () => {
    boundTab();
    actions().hydrateSessionSnapshot(TAB, "idle", [
      { content: "ship", status: "pending", priority: "low" },
    ]);
    expect(session().livePlan?.[0].priority).toBe("low");
  });
});

describe("the per-turn usage footer is for any agent that reports usage (ACP audit finding 26)", () => {
  it("an ACP agent's cumulative usage gives its turn a footer", () => {
    boundTab("codex");
    apply(
      d("status", { status: "running", turn_seq: 1 }),
      d("message_appended", {
        message: {
          id: "r1",
          role: "assistant",
          mode: "text",
          content: "done",
          tool_calls: [],
          timestamp: "2026-11-25T00:00:00Z",
        },
      }),
      d("usage_updated", {
        usage: {
          input_tokens: 40,
          output_tokens: 5,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          reasoning_tokens: 0,
          cost: 0,
          currency: null,
        },
      }),
      d("turn_finished", { stop_reason: "end_turn", turn_seq: 1 }),
    );
    expect(lastMessage().usage).toMatchObject({ input: 40, output: 5 });
  });
});
