// Deleting asks first, then deletes. Nothing on disk vetoes it any more:
// liveness is ACP state only, so a stale `liveElsewhere` on the row (the
// field is deprecated and always false from Rust) is not read.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
const confirmDeleteChat = vi.hoisted(() => vi.fn(async () => true));
const deleteThread = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/features/chat/lib/confirm-delete-chat", () => ({ confirmDeleteChat }));
vi.mock("@/features/chat/lib/history-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/chat/lib/history-api")>()),
  deleteThread,
}));

import { deleteSession } from "./sidebar-actions";

const session = (liveElsewhere: boolean) =>
  ({ threadId: "t1", sessionId: "s1", title: "Fix it", liveElsewhere }) as never;

beforeEach(() => {
  confirmDeleteChat.mockClear();
  deleteThread.mockClear();
});

describe("deleteSession", () => {
  it("asks, then deletes, whatever a stale liveElsewhere says", async () => {
    await deleteSession(session(true));
    expect(confirmDeleteChat).toHaveBeenCalledWith("Fix it");
    expect(deleteThread).toHaveBeenCalledWith("t1");
  });

  it("asks, then deletes", async () => {
    await deleteSession(session(false));
    expect(confirmDeleteChat).toHaveBeenCalledWith("Fix it");
    expect(deleteThread).toHaveBeenCalledWith("t1");
  });
});
