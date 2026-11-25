// @vitest-environment happy-dom
//
// An agent may send its whole command as the request's title (the native
// agent does, with no input beside it). The headline has no scroll, so a long
// one grew the card past the window and took the options off screen. The
// card names the action in the headline and draws the command in its preview
// box, the one part of the card that scrolls.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { cleanup, render, screen } from "@testing-library/react";
import { useChatStore } from "../stores/chat-store";
import { PermissionModal } from "./permission-modal";

afterEach(cleanup);

function pending(toolCall: Record<string, unknown>) {
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
          toolCall: { toolCallId: "call-1", kind: "execute", ...toolCall },
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

const HEREDOC = ["python3 - <<'EOF'", ...Array(60).fill('print("patched")'), "EOF"].join("\n");

describe("the permission card with a command for a title", () => {
  it("names the action in the headline and scrolls the command in the preview", () => {
    pending({ title: HEREDOC });
    expect(screen.getByText("Run a command")).toBeTruthy();
    const preview = screen.getByTestId("permission-preview");
    expect(preview.textContent).toBe(HEREDOC);
    // The box is what bounds the card: capped, scrolling with no bar, line
    // breaks kept.
    expect(preview.className).toContain("max-h-40");
    expect(preview.className).toContain("overflow-auto");
    expect(preview.className).toContain("hide-scrollbar");
    expect(preview.querySelector("pre")?.className).toContain("whitespace-pre-wrap");
    // Nowhere else: the command is in the card once.
    expect(screen.getByTestId("permission-card").textContent?.split("patched").length).toBe(61);
  });

  it("shows a short command once, as code, under the action", () => {
    pending({ title: "rm -rf dist" });
    expect(screen.getByText("Run a command")).toBeTruthy();
    expect(screen.getByTestId("permission-preview").textContent).toBe("rm -rf dist");
    expect(screen.getByTestId("permission-card").textContent?.split("rm -rf dist").length).toBe(2);
  });
});
