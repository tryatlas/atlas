// @vitest-environment happy-dom
//
// The thin callers, rendered: the drain hook, the panel's handlers and the
// window events, wired as `chat-panel.tsx` wires them, over the app's own
// `sessionSend` and the shared Tauri fake. What a send DOES is pinned in
// `lib/session-send.test.ts`; this pins that the callers hand the module the
// right things at the right time: a tick on every change it reads, the
// render's holds, a fresh watch per mount, and the panel's handle on its bind.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

import { createElement, useRef, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { tauri } from "@/test/tauri-fake";
import { pluginIdForAgent } from "@/types/agent";
import { grantLocksComposer, useAiGrantStore, useNoAiGrant } from "../stores/ai-grant-store";
import { useChatStore } from "../stores/chat-store";
import { useRcStore } from "../stores/rc-store";
import { createChatPanelHandlers, type ChatSendHandler } from "../lib/chat-panel-handlers";
import { sessionSend } from "../lib/session-send";
import type { BindControl } from "./use-agent-bind";
import { useComposerGates } from "./use-composer-gates";
import { useChatPanelEvents, useQueueDrain } from "./use-queue-drain";
import { emitWindowEvent } from "@/lib/window-events";
import { askAgent } from "@/features/ask-agent/lib/ask-agent";
import { useLayoutStore } from "@/features/layout/stores/layout-store";

const TAB = "tab-1";
const SESSION = "sess-1";

const store = () => useChatStore.getState();
const session = () => store().sessions[TAB];
const count = (cmd: string) => tauri.calls(cmd).length;
const pauses = () => tauri.calls("agents_queue_pause").map((c) => c.args.paused);
const sentTexts = () => tauri.calls("agents_send").map((c) => String(c.args.text).split("\n")[0]);
const settle = () => act(() => new Promise<void>((r) => setTimeout(r, 20)));

let bind: { [K in keyof BindControl]: ReturnType<typeof vi.fn<() => void>> };

/** The send half of `ChatPanel`, with nothing rendered. */
function usePanelSend() {
  const live = useChatStore((s) => s.sessions[TAB]);
  const grantHold = grantLocksComposer(useNoAiGrant(), live?.agentType ?? "", false);
  const bindControlRef = useRef<BindControl | null>(bind);
  const handleSendRef = useRef<ChatSendHandler | null>(null);
  const handleStopRef = useRef<(() => void) | null>(null);
  useQueueDrain({ tabId: TAB, session: live, grantHold, bindControlRef });
  useChatPanelEvents(TAB, handleSendRef, handleStopRef);
  const handlers = createChatPanelHandlers({ tabId: TAB, bindControlRef, setBindEpoch: () => {} });
  handleSendRef.current = handlers.handleSend;
  handleStopRef.current = handlers.handleStop;
  return handlers;
}

const bindTab = () => act(() => store().actions.setAcpBinding(TAB, "agent-1", SESSION, "/tmp"));

beforeEach(() => {
  tauri.reset();
  sessionSend.reset();
  let ids = 0;
  tauri.handleRaw({ agents_queue_add: () => `q-${++ids}` });
  localStorage.clear();
  useChatStore.setState({
    sessions: {},
    pendingPermissions: {},
    queues: {},
    queueIds: {},
    drafts: {},
    activeSessionId: null,
  });
  store().actions.createSession(TAB, "claude-code");
  useAiGrantStore.setState({ entitlement: null });
  useRcStore.setState({ bySession: {} });
  bind = { retry: vi.fn(), abandon: vi.fn(), kick: vi.fn(), warm: vi.fn() };
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the drain hook", () => {
  it("ticks when the bind lands: the held message goes once, through the panel's bind handle", async () => {
    const { result } = renderHook(usePanelSend);
    await act(() => result.current.handleSend("hello", []));
    expect(session().pendingSend?.content).toBe("hello");
    // The module was handed this panel's `kick`.
    expect(bind.kick).toHaveBeenCalledTimes(1);

    bindTab();
    await waitFor(() => expect(sentTexts()).toEqual(["hello"]));
    act(() => store().actions.updateSessionStatus(TAB, "idle"));
    await settle();
    expect(count("agents_send")).toBe(1);
  });

  it("ticks on a turn end and on nothing else: one drain request per turn", async () => {
    bindTab();
    act(() => store().actions.updateSessionStatus(TAB, "running"));
    renderHook(usePanelSend);
    await settle();
    const atMount = count("agents_queue_drain");

    // A streaming write to the session is not something the drain reads.
    act(() => {
      store().actions.addMessage(TAB, "assistant", "…");
    });
    await settle();
    expect(count("agents_queue_drain")).toBe(atMount);

    act(() => store().actions.updateSessionStatus(TAB, "idle"));
    await waitFor(() => expect(count("agents_queue_drain")).toBe(atMount + 1));
  });

  it("shows the module the render's holds: Rust's queue pauses and reopens with them", async () => {
    bindTab();
    renderHook(usePanelSend);
    await waitFor(() => expect(pauses()).toEqual([false]));

    act(() => {
      useChatStore.setState((s) => {
        s.sessions[TAB].unrestoredModeId = "plan";
      });
    });
    await waitFor(() => expect(pauses()).toEqual([false, true]));
    act(() => {
      useChatStore.setState((s) => {
        s.sessions[TAB].unrestoredModeId = undefined;
      });
    });
    await waitFor(() => expect(pauses()).toEqual([false, true, false]));

    act(() => {
      useChatStore.setState((s) => {
        s.sessions[TAB].agentType = "atlas-agent";
      });
      useAiGrantStore.setState({ entitlement: { state: "noGrant" } as never });
    });
    await waitFor(() => expect(pauses()).toEqual([false, true, false, true]));
  });

  it("starts a fresh watch per mount: a remounted panel reads as a bind, and drains", async () => {
    bindTab();
    const first = renderHook(usePanelSend);
    await waitFor(() => expect(count("agents_queue_drain")).toBe(1));
    // A re-render with nothing changed is not a tick.
    first.rerender();
    await settle();
    expect(count("agents_queue_drain")).toBe(1);

    first.unmount();
    renderHook(usePanelSend);
    await waitFor(() => expect(count("agents_queue_drain")).toBe(2));
  });
});

describe("the panel's handlers", () => {
  it("Stop while starting hands the module this panel's abandon", async () => {
    const { result } = renderHook(usePanelSend);
    await act(() => result.current.handleSend("hello", []));
    act(() => result.current.handleStop());
    expect(bind.abandon).toHaveBeenCalledTimes(1);
    expect(tauri.calls("agents_kill_plugin").map((c) => c.args.pluginId)).toEqual([
      pluginIdForAgent("claude-code"),
    ]);
    expect(session().pendingSend).toBeUndefined();
  });

  it("forwards the attachments and the held bubble's id", async () => {
    bindTab();
    const { result } = renderHook(usePanelSend);
    const image = { mime: "image/png", data: "AAAA" } as never;
    await act(() =>
      result.current.handleSend("look", [], [image], { recorded: true, clientMessageId: "b-1" }),
    );
    expect(tauri.calls("agents_send")[0].args).toMatchObject({
      attachments: [image],
      clientMessageId: "b-1",
    });
  });
});

describe("the window events", () => {
  it("atlas:chat-send and the stop event reach this tab's handlers, and no other tab's", async () => {
    bindTab();
    renderHook(usePanelSend);
    const send = (tabId: string, text: string) =>
      act(() => void emitWindowEvent("atlas:chat-send", { tabId, text }));
    const stop = (tabId: string) => act(() => void emitWindowEvent("atlas:chat-stop", { tabId }));

    send("another-tab", "not mine");
    send(TAB, "mine");
    await waitFor(() => expect(sentTexts()).toEqual(["mine"]));

    stop("another-tab");
    expect(count("agents_cancel")).toBe(0);
    stop(TAB);
    expect(tauri.calls("agents_cancel").map((c) => c.args.stop)).toEqual([true]);
  });

  // The real emitter, not the helper called by hand: `askAgent` (the "Ask
  // agent" action every feature uses) emits a cancelable `atlas:chat-send`,
  // and learns from the listener's `preventDefault` that a panel took it.
  it("an ask from another feature goes out through this tab's send path, and is told it landed", async () => {
    bindTab();
    act(() => {
      useLayoutStore.setState(useLayoutStore.getInitialState(), true);
      useLayoutStore.getState().actions.addTab({
        id: TAB,
        type: "chat",
        title: TAB,
        closable: true,
        dirty: false,
        data: {},
      });
      store().actions.setActiveSession(TAB);
    });
    renderHook(usePanelSend);

    let result: Awaited<ReturnType<typeof askAgent>> | undefined;
    await act(async () => {
      result = await askAgent({ context: [], prompt: "why did the push fail?", send: true });
    });

    expect(result).toMatchObject({ tabId: TAB, sent: true, created: false });
    await waitFor(() => expect(sentTexts()).toEqual(["why did the push fail?"]));
    // Sent, so not also left in the composer.
    expect(store().drafts[TAB] ?? "").toBe("");
  });

  it("an ask no panel is mounted for is not sent: it waits in the draft", async () => {
    act(() => {
      useLayoutStore.setState(useLayoutStore.getInitialState(), true);
      useLayoutStore.getState().actions.addTab({
        id: TAB,
        type: "chat",
        title: TAB,
        closable: true,
        dirty: false,
        data: {},
      });
      store().actions.setActiveSession(TAB);
    });
    vi.useFakeTimers();
    try {
      const asked = askAgent({ context: [], prompt: "nobody home", send: true });
      await vi.runAllTimersAsync();
      expect(await asked).toMatchObject({ tabId: TAB, sent: false });
    } finally {
      vi.useRealTimers();
    }
    expect(count("agents_send")).toBe(0);
    expect(store().drafts[TAB]).toBe("nobody home");
  });
});

describe("the composer's gates", () => {
  // The composer also feeds the session-projects store from the thread list;
  // that read answers nothing here.
  const gates = (running = false) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return renderHook(
      ({ running }) => useComposerGates({ tabId: TAB, running, disabledProp: false }),
      {
        initialProps: { running },
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(QueryClientProvider, { client }, children),
      },
    );
  };

  it("read the same facts the send handler does, through the one gate", async () => {
    bindTab();
    const { result } = gates();
    expect(result.current).toMatchObject({
      disabled: false,
      modeUnrestored: false,
      remoteDriving: false,
    });

    act(() => {
      useChatStore.setState((s) => {
        s.sessions[TAB].unrestoredModeId = "plan";
      });
    });
    expect(result.current).toMatchObject({ modeUnrestored: true });
    // The same state, as the module the handler calls sees it.
    expect(sessionSend.state(TAB).session?.unrestoredModeId).toBe("plan");
  });

  it("lock for the grant only on the gateway agent, and never while a turn runs", async () => {
    bindTab();
    const { result, rerender } = gates();
    // After the composer's own probe has answered (nothing, here).
    await settle();
    const noGrant = () =>
      act(() => useAiGrantStore.setState({ entitlement: { state: "noGrant" } as never }));

    noGrant();
    // Another agent runs on the user's own credentials: no lock.
    expect(result.current.disabled).toBe(false);
    expect(sessionSend.state(TAB).grantHold).toBe(false);

    act(() =>
      useChatStore.setState((s) => {
        s.sessions[TAB].agentType = "atlas-agent";
      }),
    );
    await settle();
    noGrant();
    expect(result.current.disabled).toBe(true);
    expect(sessionSend.state(TAB).grantHold).toBe(true);
    // The lock waits for the turn; the hold on the queue does not.
    rerender({ running: true });
    expect(result.current.disabled).toBe(false);
    expect(sessionSend.state(TAB).grantHold).toBe(true);
  });
});
