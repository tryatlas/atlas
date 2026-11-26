// @vitest-environment happy-dom
//
// What tells a chat tab that its user is writing: a change to a composer that
// is not blank, while its tab has no agent session. That, and a send, is what
// starts a session (`use-agent-bind.ts`); showing the tab and focusing the
// composer do not, since both happen on their own at launch.

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { onWindowEvent } from "@/lib/window-events";
import { useChatStore } from "../stores/chat-store";
import { useChatInputStartedSignal } from "./use-composer-focus";

const TAB = "tab-1";
const heard: string[] = [];
const off = onWindowEvent("atlas:chat-input-started", (detail) => {
  if (detail?.tabId) heard.push(detail.tabId);
});

beforeEach(() => {
  useChatStore.setState({ sessions: {} });
  useChatStore.getState().actions.createSession(TAB, "opencode");
});
afterEach(() => {
  cleanup();
  heard.length = 0;
});
afterAll(off);

const mount = (opts: { disabled?: boolean; startsBlank?: boolean } = {}) =>
  renderHook(() => useChatInputStartedSignal(TAB, opts.disabled ?? false, opts.startsBlank ?? true))
    .result.current;

describe("the composer's started-writing signal", () => {
  it("is sent when something is written into a blank composer", () => {
    const signal = mount();
    signal.noteBlank(false);
    signal.noteWritten();
    expect(heard).toEqual([TAB]);
  });

  it("is not sent for a change that leaves the composer blank", () => {
    const signal = mount();
    signal.noteWritten();
    signal.noteBlank(false);
    signal.noteBlank(true);
    signal.noteWritten();
    expect(heard).toEqual([]);
  });

  it("is sent for writing on in a draft that was there at mount", () => {
    // A restored draft never crosses blank→not blank, and a bind that failed
    // is retried by whatever is written next.
    const signal = mount({ startsBlank: false });
    signal.noteWritten();
    signal.noteWritten();
    expect(heard).toEqual([TAB, TAB]);
  });

  it("is not sent once the tab has its session", () => {
    const signal = mount({ startsBlank: false });
    useChatStore.getState().actions.setAcpBinding(TAB, "agent-1", "sess-1", "/proj");
    signal.noteWritten();
    expect(heard).toEqual([]);
  });

  it("is not sent from a disabled composer", () => {
    const signal = mount({ disabled: true, startsBlank: false });
    signal.noteWritten();
    expect(heard).toEqual([]);
  });
});
