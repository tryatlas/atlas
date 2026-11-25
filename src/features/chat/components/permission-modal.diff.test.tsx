// @vitest-environment happy-dom
//
// #33: the permission card drew only the call's `rawInput`. An agent may send
// a proposed edit as a `diff` block and nothing else, so the user was asked to
// approve a change the card never showed. The request carries its diff and
// the places it names (`permission_tool_call` in `atlas-agent-delta`), and the
// card draws both.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { cleanup, render, screen, within } from "@testing-library/react";
import { useChatStore } from "../stores/chat-store";
import { PermissionModal } from "./permission-modal";

afterEach(cleanup);

function pendingEdit(toolCall: Record<string, unknown>) {
  useChatStore.setState({
    sessions: {
      "chat-1": { acpSessionId: "sess-1", agentType: "atlas-agent", messages: [] },
    } as never,
    pendingPermissions: {
      "sess-1": [
        {
          agentId: "atlas-agent",
          acpSessionId: "sess-1",
          requestId: "req-1",
          toolCall: { toolCallId: "call-1", title: "Edit auth.ts", kind: "edit", ...toolCall },
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Decline", kind: "reject_once" },
          ],
        },
      ],
    } as never,
  });
  render(<PermissionModal tabId="chat-1" />);
}

describe("the permission card draws what the request changes", () => {
  it("shows the request's diff when its input says nothing", () => {
    pendingEdit({
      rawInput: {},
      contentBlocks: [
        {
          type: "diff",
          path: "/repo/src/auth.ts",
          oldText: "import a;\nlet token = read();\nexport { token };\n",
          newText: "import a;\nlet token = readFrom(process.env.HOME);\nexport { token };\n",
        },
      ],
    });
    const diff = screen.getByTestId("permission-diff");
    expect(within(diff).getByText("/repo/src/auth.ts")).toBeTruthy();
    expect(diff.textContent).toContain("-let token = read();");
    expect(diff.textContent).toContain("+let token = readFrom(process.env.HOME);");
    expect(within(diff).getByLabelText("1 added, 1 removed")).toBeTruthy();
  });

  it("shows a created file whole", () => {
    pendingEdit({
      contentBlocks: [{ type: "diff", path: "/repo/notes.md", newText: "one\ntwo\n" }],
    });
    const diff = screen.getByTestId("permission-diff");
    expect(diff.textContent).toContain("+one");
    expect(diff.textContent).toContain("+two");
    expect(within(diff).getByLabelText("2 added, 0 removed")).toBeTruthy();
  });

  it("names the places the request is about", () => {
    pendingEdit({
      rawInput: { pattern: "TODO" },
      locations: [{ path: "/repo/src/a.ts", line: 12 }, { path: "/repo/src/b.ts" }],
    });
    expect(screen.getByText("/repo/src/a.ts:12, /repo/src/b.ts")).toBeTruthy();
  });

  it("still shows the input beside the diff", () => {
    pendingEdit({
      rawInput: { replace_all: true },
      contentBlocks: [{ type: "diff", path: "/repo/a.ts", oldText: "a\n", newText: "b\n" }],
    });
    expect(screen.getByTestId("permission-diff")).toBeTruthy();
    // As a named field, not JSON.
    expect(screen.getByText("replace_all")).toBeTruthy();
    expect(screen.getByTestId("permission-preview").textContent).toBe("replace_alltrue");
  });

  it("ignores blocks that are not well-formed diffs", () => {
    pendingEdit({
      rawInput: { command: "ls" },
      contentBlocks: [
        { type: "terminal", terminalId: "t1" },
        { type: "diff", path: 7, newText: "x" },
        { type: "diff", path: "/repo/a.ts" },
        "not a block",
      ],
      locations: "not a list",
    });
    expect(screen.queryByTestId("permission-diff")).toBeNull();
    expect(screen.getByTestId("permission-card")).toBeTruthy();
  });
});
