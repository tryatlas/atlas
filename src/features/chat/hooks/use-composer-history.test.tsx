// @vitest-environment happy-dom
//
// ↑/↓ through the session's sent messages, as a terminal does: ↑ on the first
// line walks back, ↓ on the last walks forward and past the newest gives back
// the draft, and an open picker or a caret mid-text keeps the arrows.

import { renderHook } from "@testing-library/react";
import { createRef } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChatInputHandle } from "../components/chat-input";
import { useChatStore } from "../stores/chat-store";
import { sentMessages, useComposerHistory } from "./use-composer-history";

function fakeInput(initial = "") {
  let value = initial;
  let edge = true;
  const input = {
    getValue: () => value,
    setValue: (text: string) => {
      value = text;
    },
    caretAtEdge: () => edge,
  } as unknown as ChatInputHandle;
  return {
    input,
    type: (text: string) => {
      value = text;
    },
    setEdge: (at: boolean) => {
      edge = at;
    },
    value: () => value,
  };
}

function setup({ draft = "", pickerOpen = false } = {}) {
  const fake = fakeInput(draft);
  const inputRef = createRef<ChatInputHandle>() as { current: ChatInputHandle | null };
  inputRef.current = fake.input;
  const { result } = renderHook(() =>
    useComposerHistory({
      tabId: "tab-1",
      inputRef,
      projectPath: null,
      writeComposer: (text) => fake.input.setValue(text),
      pickerOpen: () => pickerOpen,
    }),
  );
  const press = (key: "ArrowUp" | "ArrowDown", init: KeyboardEventInit = {}) =>
    result.current(new KeyboardEvent("keydown", { key, ...init }));
  return { ...fake, press };
}

beforeEach(() => {
  const user = (content: string, atlasProse?: string) => ({
    role: "user",
    content,
    ...(atlasProse ? { atlasProse } : {}),
  });
  useChatStore.setState({
    sessions: {
      "tab-1": {
        messages: [
          user("first"),
          { role: "assistant", content: "reply" },
          user("second\n\n<atlas-context>…</atlas-context>", "second"),
          user("third"),
          user("third"),
        ],
      },
    } as never,
  });
});

describe("sentMessages", () => {
  it("lists the user's messages newest first, prose only, repeats folded", () => {
    expect(sentMessages("tab-1")).toEqual(["third", "second", "first"]);
  });
});

describe("useComposerHistory", () => {
  it("walks back on ↑ and stays at the oldest", () => {
    const h = setup();
    expect(h.press("ArrowUp")).toBe(true);
    expect(h.value()).toBe("third");
    h.press("ArrowUp");
    expect(h.value()).toBe("second");
    h.press("ArrowUp");
    h.press("ArrowUp");
    expect(h.value()).toBe("first");
  });

  it("walks forward on ↓ and gives back the draft past the newest", () => {
    const h = setup({ draft: "half a thought" });
    h.press("ArrowUp");
    h.press("ArrowUp");
    h.press("ArrowDown");
    expect(h.value()).toBe("third");
    h.press("ArrowDown");
    expect(h.value()).toBe("half a thought");
    // Back on the user's own text, ↓ is the editor's again.
    expect(h.press("ArrowDown")).toBe(false);
  });

  it("starts over from the newest once a recalled message is edited", () => {
    const h = setup();
    h.press("ArrowUp");
    h.press("ArrowUp");
    h.type("second, edited");
    h.press("ArrowUp");
    expect(h.value()).toBe("third");
    h.press("ArrowDown");
    expect(h.value()).toBe("second, edited");
  });

  it("ends the walk on a send, even if the same text is typed again", () => {
    const h = setup();
    h.press("ArrowUp");
    expect(h.value()).toBe("third");
    // Sent: the session gains the message and the composer is retyped.
    const session = useChatStore.getState().sessions["tab-1"];
    useChatStore.setState({
      sessions: {
        "tab-1": {
          ...session,
          messages: [...session.messages, { role: "user", content: "fourth" }],
        },
      } as never,
    });
    h.type("third");
    h.press("ArrowUp");
    expect(h.value()).toBe("fourth");
  });

  it("leaves ↑ to the editor when nothing has been sent", () => {
    useChatStore.setState({ sessions: { "tab-1": { messages: [] } } as never });
    expect(setup().press("ArrowUp")).toBe(false);
  });

  it("leaves the arrows to the editor mid-text, with a modifier, or under a picker", () => {
    const mid = setup();
    mid.setEdge(false);
    expect(mid.press("ArrowUp")).toBe(false);
    expect(setup().press("ArrowUp", { altKey: true })).toBe(false);
    const picker = setup({ pickerOpen: true });
    expect(picker.press("ArrowUp")).toBe(false);
    expect(picker.value()).toBe("");
  });
});
