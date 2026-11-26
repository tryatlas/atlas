// @vitest-environment happy-dom
//
// The question card's keys: digits pick, ↑/↓ walk the options by focus, ←/→
// move between questions (→ only once the question is answered), Enter
// advances or presses the focused option, and the text field keeps the
// horizontal arrows for its caret until it is at an edge.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { QuestionSpec } from "../../lib/questions";
import { ApprovalCardView } from "./approval-card-view";

const QUESTIONS: QuestionSpec[] = [
  {
    header: "Scope",
    question: "Where should comments exist?",
    options: [{ label: "Every session" }, { label: "Shared only" }],
  },
  {
    header: "Click",
    question: "What should a click do?",
    options: [{ label: "Open a box" }, { label: "Show a marker" }, { label: "Nothing" }],
  },
];

function key(k: string, target: Element | Window = window) {
  fireEvent.keyDown(target, { key: k });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("question card keys", () => {
  it("walks the options with ↑/↓ and presses one with Enter", () => {
    const onSubmit = vi.fn();
    render(<ApprovalCardView questions={QUESTIONS} onSubmit={onSubmit} />);
    key("ArrowDown");
    expect(document.activeElement?.textContent).toContain("Every session");
    key("ArrowDown");
    expect(document.activeElement?.textContent).toContain("Shared only");
    key("ArrowDown");
    expect(document.activeElement?.textContent).toContain("Every session");
    key("ArrowUp");
    expect(document.activeElement?.textContent).toContain("Shared only");
    // Enter on a focused option is the button's own press, not "next".
    fireEvent.click(document.activeElement!);
    expect(screen.getByRole("button", { name: /Shared only/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("moves between questions with ←/→, → only once answered", () => {
    vi.useFakeTimers();
    const onSubmit = vi.fn();
    render(<ApprovalCardView questions={QUESTIONS} onSubmit={onSubmit} />);
    key("ArrowRight");
    expect(screen.getByText("Where should comments exist?")).toBeTruthy();
    key("1");
    // The single-select pick auto-advances after a beat; → goes at once.
    key("ArrowRight");
    expect(screen.getByText("What should a click do?")).toBeTruthy();
    act(() => {
      vi.runAllTimers();
    });
    expect(screen.getByText("What should a click do?")).toBeTruthy();
    key("ArrowLeft");
    expect(screen.getByText("Where should comments exist?")).toBeTruthy();
    key("ArrowLeft");
    expect(screen.getByText("Where should comments exist?")).toBeTruthy();
  });

  it("leaves the text field's caret alone until it is at an edge", () => {
    const onSubmit = vi.fn();
    render(<ApprovalCardView questions={QUESTIONS} onSubmit={onSubmit} />);
    const field = screen.getByPlaceholderText("Answer in your own words…") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "ab" } });
    field.focus();
    field.setSelectionRange(1, 1);
    key("ArrowRight", field);
    expect(screen.getByText("Where should comments exist?")).toBeTruthy();
    field.setSelectionRange(2, 2);
    key("ArrowRight", field);
    expect(screen.getByText("What should a click do?")).toBeTruthy();
  });

  it("submits on the last question with Enter and ignores chords", () => {
    const onSubmit = vi.fn();
    render(<ApprovalCardView questions={[QUESTIONS[1]]} onSubmit={onSubmit} />);
    fireEvent.keyDown(window, { key: "1", metaKey: true });
    expect(onSubmit).not.toHaveBeenCalled();
    key("3");
    key("Enter");
    expect(onSubmit).toHaveBeenCalledWith([{ selected: ["Nothing"], custom: "" }]);
  });
});

it("does not submit an unanswered text field or an IME confirmation", () => {
  const onSubmit = vi.fn();
  render(<ApprovalCardView questions={[QUESTIONS[0]]} onSubmit={onSubmit} />);
  const field = screen.getByRole("textbox");
  field.focus();
  key("Enter", field);
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.change(field, { target: { value: "candidate" } });
  fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
  expect(onSubmit).not.toHaveBeenCalled();
  key("Enter", field);
  expect(onSubmit).toHaveBeenCalledTimes(1);
});
it("ignores keys in another editor and in an inert card", () => {
  const onSubmit = vi.fn();
  const view = render(
    <>
      <input aria-label="other search" />
      <div inert>
        <ApprovalCardView questions={[QUESTIONS[0]]} onSubmit={onSubmit} />
      </div>
    </>,
  );
  const search = screen.getByLabelText("other search");
  search.focus();
  key("1", search);
  key("Enter", search);
  expect(onSubmit).not.toHaveBeenCalled();
  view.rerender(
    <>
      <input aria-label="other search" />
      <ApprovalCardView questions={[QUESTIONS[0]]} onSubmit={onSubmit} />
    </>,
  );
  search.focus();
  key("1", search);
  key("Enter", search);
  expect(onSubmit).not.toHaveBeenCalled();
});
