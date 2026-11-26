// @vitest-environment happy-dom
//
// Which of the three prompts a permission request is drawn as — plan review,
// question card, or the plain card — and whether the plan review adds Atlas's
// own "approve and bypass" action, come from what the request IS on the wire:
// its ACP tool kind and its structured fields. Never the agent's id, never a
// tool name (ADR-0002, ACP audit finding 34). Before, any call whose arguments held a
// `plan` string or a `questions` array was drawn as a plan or a question —
// hiding the command it would run — and the bypass action appeared only for
// the `claude-code` id, so the same adapter installed under another id lost it.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { cleanup, render, screen } from "@testing-library/react";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "../stores/chat-store";
import { PermissionModal } from "./permission-modal";

afterEach(cleanup);

const EXIT_PLAN_OPTIONS = [
  { optionId: "exit-plan-default", name: "Yes", kind: "allow_once" },
  { optionId: "exit-plan-accept-edits", name: "Yes, and accept edits", kind: "allow_once" },
  { optionId: "reject", name: "No, keep planning", kind: "reject_once" },
];

function pending(
  agentType: string,
  toolCall: Record<string, unknown>,
  options = EXIT_PLAN_OPTIONS,
) {
  useLayoutStore.setState({ activeByGroup: { main: "chat-1" }, activeTabId: "chat-1" } as never);
  useChatStore.setState({
    sessions: { "chat-1": { acpSessionId: "sess-1", agentType, messages: [] } } as never,
    pendingPermissions: {
      "sess-1": [
        {
          agentId: agentType,
          acpSessionId: "sess-1",
          requestId: "req-1",
          toolCall: { toolCallId: "call-1", title: "Ready to code?", ...toolCall },
          options,
        },
      ],
    } as never,
  });
  render(<PermissionModal tabId="chat-1" />);
}

const PLAN = { kind: "switch_mode", rawInput: { plan: "1. Do the thing" } };

describe("the plan review's bypass action follows the prompt's shape", () => {
  it("is offered to any agent whose plan prompt omits bypass, whatever its id", () => {
    pending("claude-acp", PLAN);
    expect(screen.getByTestId("plan-review")).toBeTruthy();
    expect(screen.getByText("Yes, and bypass permissions")).toBeTruthy();
  });

  it("is not offered when the prompt's options are not the mode-encoding family", () => {
    pending("claude-code", PLAN, [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
      { optionId: "reject", name: "Decline", kind: "reject_once" },
    ]);
    expect(screen.getByTestId("plan-review")).toBeTruthy();
    expect(screen.queryByText("Yes, and bypass permissions")).toBeNull();
  });
});

describe("a call is drawn as a plan or a question only by its kind and fields", () => {
  it("draws a command whose arguments hold a `plan` as the command", () => {
    pending("atlas-agent", { kind: "execute", rawInput: { command: "make", plan: "1. x" } });
    expect(screen.queryByTestId("plan-review")).toBeNull();
  });

  it("draws a command whose arguments hold `questions` as the command", () => {
    pending("atlas-agent", {
      kind: "execute",
      title: "quiz",
      rawInput: { command: "quiz", questions: [{ question: "Which?", options: ["a", "b"] }] },
    });
    expect(screen.queryByText("Which?")).toBeNull();
  });
});
