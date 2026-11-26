// @vitest-environment happy-dom
//
// What clears "unread" and "Woke" (ADR-0028): the session in front of the
// user is marked viewed, 1.5 s after it got there. "In front of the user" is
// the active tab's session with the window focused; a turn still running is
// not something they have seen the end of.
//
// Rust decides what unread means. This hook only decides when to tell it the
// user looked, and that is the whole of the frontend's part in it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
const nativeFocus = vi.hoisted(() => ({
  focused: true,
  listeners: new Set<(focused: boolean) => void>(),
}));
vi.mock("@/lib/window-focus", () => ({
  isWindowFocused: () => nativeFocus.focused,
  onWindowFocusChange: (listener: (focused: boolean) => void) => {
    nativeFocus.listeners.add(listener);
    return () => nativeFocus.listeners.delete(listener);
  },
}));

import { act, cleanup, renderHook } from "@testing-library/react";
import { tauri } from "@/test/tauri-fake";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useChatStore } from "../stores/chat-store";
import { VIEWED_DEBOUNCE_MS } from "../stores/session-lifecycle-store";
import { useMarkActiveSessionViewed } from "./use-mark-session-viewed";

const store = () => useChatStore.getState();
const viewed = () => tauri.calls("threads_mark_viewed").map((c) => c.args.sessionId);
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const windowEvent = (name: "focus" | "blur") =>
  act(() => {
    nativeFocus.focused = name === "focus";
    for (const listener of nativeFocus.listeners) listener(nativeFocus.focused);
  });

function open(tabId: string, sessionId: string | null) {
  const { actions } = store();
  actions.createSession(tabId, "atlas-agent");
  if (sessionId) actions.setAcpBinding(tabId, "agent-1", sessionId, "/proj");
}
/** Show a tab the way the tab strip does: in the layout, which is all a tab
 *  switch changes. The chat store's `activeSessionId` is not touched. */
const activate = (tabId: string | null) =>
  act(() => useLayoutStore.setState({ activeTabId: tabId }));

beforeEach(() => {
  vi.useFakeTimers();
  tauri.reset();
  tauri.handleRaw({ threads_mark_viewed: () => true });
  localStorage.clear();
  nativeFocus.focused = true;
  // The webview still says focused during a macOS Space switch.
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  useChatStore.setState({ sessions: {}, activeSessionId: null });
  open("tab-a", "sess-a");
  open("tab-b", "sess-b");
  open("tab-new", null);
  store().actions.setActiveSession(null);
  useLayoutStore.setState({ activeTabId: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("useMarkActiveSessionViewed", () => {
  it("restates the debounce: 1.5 s", () => {
    expect(VIEWED_DEBOUNCE_MS).toBe(1_500);
  });

  it("marks the active session 1.5 s after it comes to the front, once", async () => {
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");

    await advance(VIEWED_DEBOUNCE_MS - 1);
    expect(viewed()).toEqual([]);
    await advance(1);
    expect(viewed()).toEqual(["sess-a"]);

    await advance(60_000);
    expect(viewed()).toEqual(["sess-a"]);
  });

  // ACP audit finding 103: a tab switch moves the layout's tab and nothing else. Following the
  // chat store's `activeSessionId` marked the tab left behind and never the
  // one on screen.
  it("follows the tab the layout shows, not the chat store's active session", async () => {
    act(() => store().actions.setActiveSession("tab-a"));
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-b");
    await advance(VIEWED_DEBOUNCE_MS);
    expect(viewed()).toEqual(["sess-b"]);
  });

  it("does not mark a session the user only passed through", async () => {
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");
    await advance(VIEWED_DEBOUNCE_MS - 1);
    activate("tab-b");
    await advance(VIEWED_DEBOUNCE_MS);
    expect(viewed()).toEqual(["sess-b"]);
  });

  it("has nothing to mark for a tab with no session yet, until it is bound", async () => {
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-new");
    await advance(VIEWED_DEBOUNCE_MS);
    expect(viewed()).toEqual([]);

    act(() => store().actions.setAcpBinding("tab-new", "agent-1", "sess-new", "/proj"));
    await advance(VIEWED_DEBOUNCE_MS);
    expect(viewed()).toEqual(["sess-new"]);
  });

  it("leaves a session unread while the window is in the background, and marks it on return", async () => {
    nativeFocus.focused = false;
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");
    await advance(60_000);
    expect(viewed()).toEqual([]);

    nativeFocus.focused = true;
    windowEvent("focus");
    await advance(VIEWED_DEBOUNCE_MS - 1);
    expect(viewed()).toEqual([]);
    await advance(1);
    expect(viewed()).toEqual(["sess-a"]);
  });

  it("does not mark when the window loses focus inside the 1.5 s", async () => {
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");
    await advance(VIEWED_DEBOUNCE_MS - 1);
    windowEvent("blur");
    await advance(60_000);
    expect(viewed()).toEqual([]);
  });

  it("waits for a running turn: the completion is seen when it finishes in front of the user", async () => {
    act(() => store().actions.updateSessionStatus("tab-a", "running"));
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");
    await advance(60_000);
    expect(viewed()).toEqual([]);

    act(() => store().actions.updateSessionStatus("tab-a", "idle"));
    await advance(VIEWED_DEBOUNCE_MS);
    expect(viewed()).toEqual(["sess-a"]);
  });

  it("a turn that finishes while the user is away stays unread until they come back", async () => {
    act(() => store().actions.updateSessionStatus("tab-a", "running"));
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");
    nativeFocus.focused = false;
    windowEvent("blur");

    act(() => store().actions.updateSessionStatus("tab-a", "idle"));
    await advance(60_000);
    expect(viewed()).toEqual([]);

    nativeFocus.focused = true;
    windowEvent("focus");
    await advance(VIEWED_DEBOUNCE_MS);
    expect(viewed()).toEqual(["sess-a"]);
  });

  it("waits for completion when native focus returns during a running turn", async () => {
    act(() => store().actions.updateSessionStatus("tab-a", "running"));
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");
    windowEvent("focus");
    await advance(VIEWED_DEBOUNCE_MS);
    expect(viewed()).toEqual([]);
    act(() => store().actions.updateSessionStatus("tab-a", "idle"));
    await advance(VIEWED_DEBOUNCE_MS);
    expect(viewed()).toEqual(["sess-a"]);
  });

  it("stops with its component: no mark after unmount, and no listeners left", async () => {
    const { unmount } = renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");
    await advance(VIEWED_DEBOUNCE_MS - 1);
    unmount();
    windowEvent("focus");
    await advance(60_000);
    expect(viewed()).toEqual([]);
  });

  it("a failed mark is quiet", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    tauri.handleRaw({ threads_mark_viewed: () => Promise.reject(new Error("locked")) });
    renderHook(() => useMarkActiveSessionViewed());
    activate("tab-a");
    await advance(VIEWED_DEBOUNCE_MS);
    expect(viewed()).toEqual(["sess-a"]);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
