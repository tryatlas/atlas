// @vitest-environment happy-dom
//
// A notification click goes to the session it is about, not to the tab that
// showed it when it was raised: that tab may show another conversation now,
// and landing on it looks like the notification lied (#52).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

const jumpToSession = vi.hoisted(() => vi.fn(async () => {}));
const openThread = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/features/chat/lib/tab-project", () => ({ jumpToSession }));
vi.mock("@/features/chat/lib/open-thread", () => ({ openThread }));

import { tauri } from "@/test/tauri-fake";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { openSessionTarget } from "./open-session-target";

const chatTab = (id: string) =>
  ({ id, type: "chat", title: "Session", closable: true, dirty: false, data: {} }) as never;

const row = {
  threadId: "th-1",
  sessionId: "sess-1",
  agentId: "opencode",
  title: "The notified session",
  folderPaths: ["/proj"],
};

beforeEach(() => {
  jumpToSession.mockClear();
  openThread.mockClear();
  tauri.reset();
  tauri.handleRaw({
    threads_projects: () => [{ name: "proj", paths: ["/proj"], isCurrent: true, threads: [row] }],
  });
  useChatStore.setState({ sessions: {}, queues: {}, queueIds: {}, drafts: {} });
  useLayoutStore.setState({
    tabs: [chatTab("chat-1")],
    viewsByWs: {},
    currentViewWsId: "p-1",
  });
  useChatStore.getState().actions.createSession("chat-1");
});

const bind = (tab: string, sessionId: string) =>
  useChatStore.getState().actions.setAcpBinding(tab, "agent-1", sessionId, "/proj");

describe("openSessionTarget", () => {
  it("goes to the remembered tab while it still shows the session", async () => {
    bind("chat-1", "sess-1");
    await openSessionTarget({ tabId: "chat-1", sessionId: "sess-1", threadId: "th-1" });
    expect(jumpToSession).toHaveBeenCalledWith("chat-1");
    expect(openThread).not.toHaveBeenCalled();
  });

  it("resumes the session when its remembered tab moved on to another", async () => {
    bind("chat-1", "sess-other");
    await openSessionTarget({ tabId: "chat-1", sessionId: "sess-1", threadId: "th-1" });
    expect(jumpToSession).not.toHaveBeenCalled();
    expect(openThread).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sess-1" }));
  });

  it("resumes it by session id when the target carries no thread id", async () => {
    bind("chat-1", "sess-other");
    await openSessionTarget({ tabId: "chat-1", sessionId: "sess-1" });
    expect(jumpToSession).not.toHaveBeenCalled();
    expect(openThread).toHaveBeenCalledWith(expect.objectContaining({ threadId: "th-1" }));
  });

  it("follows the session to the tab that holds it now, in another project", async () => {
    bind("chat-1", "sess-other");
    useLayoutStore.setState({ viewsByWs: { "p-2": { tabs: [chatTab("chat-far")] } as never } });
    useChatStore.getState().actions.createSession("chat-far");
    bind("chat-far", "sess-1");
    await openSessionTarget({ tabId: "chat-1", sessionId: "sess-1", threadId: "th-1" });
    expect(jumpToSession).toHaveBeenCalledWith("chat-far");
    expect(openThread).not.toHaveBeenCalled();
  });

  it("a target naming no session goes to its tab", async () => {
    await openSessionTarget({ tabId: "chat-1" });
    expect(jumpToSession).toHaveBeenCalledWith("chat-1");
  });
});
