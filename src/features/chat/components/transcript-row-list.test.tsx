// @vitest-environment happy-dom
//
// The transcript's row list is built per TURN, and a turn's element is kept
// for as long as its projection segment is (`transcript.tsx`, "The rows, one
// memoized element per turn"). Two things can go wrong with that and neither
// shows up as an error: rows land in the wrong order or go missing at the
// window's top edge, or the list quietly goes back to rebuilding every row on
// every streaming frame, which is the cost this arrangement exists to remove.
//
// The row and transcript views are stand-ins here. The stand-in row is NOT
// memo'd, on purpose: it renders exactly when the list hands React a new
// element for it, so its render count is the list's own behaviour and not the
// real row's memo hiding it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode, RefObject } from "react";
import type { ChatMessage } from "@/types/agent";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}));
vi.mock("@/features/layout/lib/use-tab-visible", () => ({ useIsTabVisible: () => true }));

const renders = new Map<string, number>();
vi.mock("@tryatlas/design/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tryatlas/design/session")>()),
  TranscriptRowItem: ({ row, priority }: { row: { id: string }; priority: number }) => {
    renders.set(row.id, (renders.get(row.id) ?? 0) + 1);
    return (
      <div data-row-id={row.id}>
        <span data-priority={priority} />
      </div>
    );
  },
  TranscriptView: (props: {
    scrollRef: RefObject<HTMLDivElement | null>;
    contentRef: RefObject<HTMLDivElement | null>;
    rowViews: ReactNode;
  }) => (
    <div ref={props.scrollRef}>
      <div ref={props.contentRef} data-testid="content">
        {props.rowViews}
      </div>
    </div>
  ),
}));

import { projectRows } from "../lib/turn-rows";
import { Transcript } from "./transcript";

function message(id: string, role: "user" | "assistant", content: string): ChatMessage {
  return {
    id,
    role,
    content,
    thinking: "",
    toolCalls: [],
    fileChanges: [],
    plan: null,
    timestamp: "2026-09-18T10:00:00Z",
    mode: "text",
  } as ChatMessage;
}

/** `turns` exchanges: a prompt, then a reply in three messages. */
function thread(turns: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let t = 0; t < turns; t++) {
    out.push(message(`u${t}`, "user", `question ${t}`));
    for (let k = 0; k < 3; k++) out.push(message(`a${t}-${k}`, "assistant", `answer ${t}.${k}`));
  }
  return out;
}

function projection(messages: ChatMessage[]) {
  return projectRows(messages, {
    expanded: new Set(),
    expandedTurns: new Set(),
    streaming: false,
    turnInProgress: false,
    subagents: undefined,
  });
}
const projected = (messages: ChatMessage[]) => projection(messages).rows;

function mounted(container: HTMLElement) {
  const content = container.querySelector('[data-testid="content"]')!;
  // Direct children: the window's anchor search walks `content.children`.
  return Array.from(content.children) as HTMLElement[];
}

const view = (messages: ChatMessage[], isStreaming = false) => (
  <Transcript tabId="tab-1" acpSessionId="acp-1" messages={messages} isStreaming={isStreaming} />
);

beforeEach(() => {
  vi.useFakeTimers();
  renders.clear();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("Transcript row list", () => {
  it("mounts every row of a short thread, in projection order", () => {
    const messages = thread(3);
    const { container } = render(view(messages));
    expect(mounted(container).map((el) => el.dataset.rowId)).toEqual(
      projected(messages).map((row) => row.id),
    );
  });

  it("mounts the tail of a long thread, cutting through a turn at the window's edge", () => {
    // Trailing prompts are one row each, so adding them slides the window's
    // top edge through the turns until it lands inside one.
    let messages = thread(40);
    const cutsATurn = () => {
      const { rows, segments } = projection(messages);
      const start = rows.length - 80;
      return segments.some((s) => s.offset < start && start < s.offset + s.rows.length);
    };
    for (let extra = 0; extra < 8 && !cutsATurn(); extra++) {
      messages = [...messages, message(`extra${extra}`, "user", "one more thing")];
    }
    expect(cutsATurn()).toBe(true);
    const { rows } = projection(messages);
    const start = rows.length - 80;
    const { container } = render(view(messages));
    const els = mounted(container);
    // The initial window is the last 80 rows, whatever turn that lands in.
    const expected = rows.slice(-80);
    expect(els.map((el) => el.dataset.rowId)).toEqual(expected.map((row) => row.id));
    // Parse priority is the row's absolute place in the thread.
    expect(els.map((el) => Number(el.querySelector("span")!.dataset.priority))).toEqual(
      expected.map((_, i) => start + i),
    );
  });

  it("builds only the live turn on a streaming frame", () => {
    const settled = thread(3);
    const live = [...settled, message("u-live", "user", "and then?")];
    const frame = (text: string) => [...live, message("a-live", "assistant", text)];

    const { container, rerender } = render(view(frame("one"), true));
    const before = new Map(renders);
    rerender(view(frame("one two"), true));

    const settledIds = projected(live).map((row) => row.id);
    expect(settledIds.length).toBeGreaterThan(0);
    for (const id of settledIds) expect(renders.get(id)).toBe(before.get(id));
    // And the live turn did move.
    const liveIds = mounted(container)
      .map((el) => el.dataset.rowId!)
      .filter((id) => !settledIds.includes(id));
    expect(liveIds.length).toBeGreaterThan(0);
    for (const id of liveIds) expect(renders.get(id)).toBeGreaterThan(before.get(id) ?? 0);
  });
});
