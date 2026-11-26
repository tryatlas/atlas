// Plan and question prompts are recognised by the ACP tool kind the agent
// declared and the structure of the input, never by a tool name (ADR-0002,
// ACP audit finding 34): a call that acts and merely carries a `plan` or `questions`
// field is that act, and must be shown as one.
import { describe, expect, it } from "vitest";
import { extractPlanMarkdown } from "./plans";
import { extractQuestions } from "./questions";

const QUESTIONS = { questions: [{ question: "Which?", options: [{ label: "A" }] }] };

describe("extractQuestions", () => {
  it("reads a question call that declares no acting kind", () => {
    expect(extractQuestions({ kind: "other", rawInput: QUESTIONS })).toHaveLength(1);
    expect(extractQuestions({ rawInput: QUESTIONS })).toHaveLength(1);
  });

  it("leaves a call that acts to its own card", () => {
    for (const kind of ["execute", "edit", "fetch", "delete", "switch_mode"]) {
      expect(extractQuestions({ kind, rawInput: QUESTIONS })).toBeNull();
    }
  });
});

describe("extractPlanMarkdown", () => {
  it("reads a mode switch that carries a plan", () => {
    expect(extractPlanMarkdown({ kind: "switch_mode", rawInput: { plan: "1. go" } })).toBe("1. go");
  });

  it("ignores a `plan` field on a call of any other kind", () => {
    for (const kind of ["execute", "edit", "other", "think"]) {
      expect(extractPlanMarkdown({ kind, rawInput: { plan: "1. go" } })).toBeNull();
    }
  });
});
