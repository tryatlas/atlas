// @vitest-environment happy-dom
//
// Agents bake their own brand into option labels (codex-acp: "No, and tell
// Codex what to do differently"), and the card rewrites any agent's brand to
// the one bound to the session. Rewriting brand by brand matched "Claude"
// inside the "Claude Code" it had just written, so a Claude Code session read
// "tell Claude Code Code".
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { cleanup, render, screen } from "@testing-library/react";
import { useChatStore } from "../stores/chat-store";
import { PermissionModal } from "./permission-modal";

afterEach(cleanup);

function pending(agentType: string, names: string[]) {
  useChatStore.setState({
    sessions: {
      "chat-1": { acpSessionId: "sess-1", agentType, messages: [] },
    } as never,
    pendingPermissions: {
      "sess-1": [
        {
          agentId: agentType,
          acpSessionId: "sess-1",
          requestId: "req-1",
          toolCall: { toolCallId: "call-1", kind: "execute", title: "ls" },
          options: names.map((name, i) => ({ optionId: `o${i}`, name, kind: "reject_once" })),
        },
      ],
    } as never,
  });
  render(<PermissionModal tabId="chat-1" />);
}

function labels(): string[] {
  return [...screen.getByTestId("permission-card").querySelectorAll("button")].map(
    (b) => b.textContent ?? "",
  );
}

describe("the permission card's agent brand", () => {
  it("names the bound agent once, whichever brand the label carried", () => {
    pending("claude-code", [
      "No, and tell Codex what to do differently",
      "No, and tell Claude Code what to do differently",
      "No, and tell Claude what to do differently",
    ]);
    for (const label of labels()) {
      expect(label).toContain("tell Claude Code what to do differently");
      expect(label).not.toContain("Code Code");
    }
  });

  it("rewrites another agent's brand to the bound one", () => {
    pending("codex", ["No, and tell Claude Code what to do differently"]);
    expect(labels()[0]).toContain("tell Codex what to do differently");
  });
});
