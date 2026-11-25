// A rename from the sidebar reaches the tab showing that session. It used to
// stop at `threads_rename`: the sidebar showed the new name and the open tab
// the old one until the chat was reopened.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
const renameThread = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/features/chat/lib/history-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/chat/lib/history-api")>()),
  renameThread,
}));
const tabShowingSession = vi.hoisted(() => vi.fn((): string | null => "tab-1"));
vi.mock("@/features/chat/lib/open-thread", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/chat/lib/open-thread")>()),
  tabShowingSession,
}));

import { useChatStore } from "@/features/chat/stores/chat-store";
import { renameSession } from "./sidebar-actions";

const session = { threadId: "t1", sessionId: "s1", title: "Old name" } as never;
const titleOf = (tabId: string) => useChatStore.getState().sessions[tabId]?.title;

beforeEach(() => {
  renameThread.mockReset();
  renameThread.mockResolvedValue(undefined);
  tabShowingSession.mockReturnValue("tab-1");
  useChatStore.setState({ sessions: {} });
  useChatStore.getState().actions.createSession("tab-1", "atlas-agent");
  useChatStore.getState().actions.setSessionTitle("tab-1", "Old name");
});

describe("renameSession", () => {
  it("renames the thread and the open tab showing it", async () => {
    await renameSession(session, "  New name ");
    expect(renameThread).toHaveBeenCalledWith("t1", "New name");
    expect(titleOf("tab-1")).toBe("New name");
  });

  it("leaves the tab alone when the backend refuses the rename", async () => {
    renameThread.mockRejectedValue(new Error("locked"));
    await renameSession(session, "New name");
    expect(titleOf("tab-1")).toBe("Old name");
  });

  it("has no tab to update when none shows the session", async () => {
    tabShowingSession.mockReturnValue(null);
    await renameSession(session, "New name");
    expect(titleOf("tab-1")).toBe("Old name");
  });
});
