// @vitest-environment happy-dom
//
// The keys the composer forwards to an open `@` picker.

import { act, renderHook } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { MentionPickerHandle } from "@/features/mentions/components/mention-picker";
import type { ChatInputHandle } from "../components/chat-input";
import { useComposerPickers } from "./use-composer-pickers";

function setup(commitResult: boolean) {
  const { result } = renderHook(() =>
    useComposerPickers({
      tabId: "tab-1",
      agentType: "claude-code",
      disabled: false,
      inputRef: createRef<ChatInputHandle>(),
      attachPicked: vi.fn(),
    }),
  );
  const picker = {
    moveUp: vi.fn(),
    moveDown: vi.fn(),
    commit: vi.fn(() => commitResult),
    goBack: vi.fn(() => false),
  };
  result.current.pickerRef.current = picker as unknown as MentionPickerHandle;
  act(() => {
    result.current.setTrigger({
      from: 1,
      to: 9,
      query: "next-env",
      anchor: { x: 0, y: 0 },
      scope: null,
    });
  });
  return { result, picker };
}

describe("useComposerPickers — mention picker keys", () => {
  it("Tab completes the highlighted row and keeps the key", () => {
    const { result, picker } = setup(true);
    expect(result.current.keyInterceptor("Tab")).toBe(true);
    expect(picker.commit).toHaveBeenCalledOnce();
  });

  it("Tab with no row to complete still stays in the composer", () => {
    const { result } = setup(false);
    expect(result.current.keyInterceptor("Tab")).toBe(true);
  });

  it("Tab passes through when no picker is open", () => {
    const { result } = renderHook(() =>
      useComposerPickers({
        tabId: "tab-1",
        agentType: "claude-code",
        disabled: false,
        inputRef: createRef<ChatInputHandle>(),
        attachPicked: vi.fn(),
      }),
    );
    expect(result.current.keyInterceptor("Tab")).toBe(false);
  });
});
