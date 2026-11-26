// What the permission card says about a request. A request's title has no
// length limit on the wire and agents put different things in it (the
// command, the command in backticks, or a prose description), and its input
// holds the command the user is approving. The card names the action in the
// transcript's words, keeps prose out of the code and the command out of JSON,
// and never lets a long title into the headline, which does not scroll.
import { describe, expect, it } from "vitest";
import { HEADLINE_MAX, permissionSummaryOf } from "./permission-summary";

const HEREDOC = `python3 - <<'EOF'\nimport re\nprint("patched")\nEOF`;

describe("permissionSummaryOf", () => {
  it("reads Claude's Bash: description as prose, command as shell text, no JSON", () => {
    const command = 'echo "=== branches ==="\ngit branch -r --contains 8f34cf30';
    expect(
      permissionSummaryOf({
        title: "Check merge status",
        kind: "execute",
        rawInput: { command, description: "Check merge status" },
      }),
    ).toEqual({
      tool: "run",
      action: "Run a command",
      description: "Check merge status",
      source: null,
      command,
      fields: [],
    });
  });

  it("keeps a description that differs from the title as a field", () => {
    const summary = permissionSummaryOf({
      title: "Run the tests",
      kind: "execute",
      rawInput: { command: "bun test", description: "Unit tests only" },
    });
    expect(summary.description).toBe("Run the tests");
    expect(summary.fields).toEqual([{ name: "description", value: "Unit tests only" }]);
  });

  it("shows a command key that is not text as a field", () => {
    expect(
      permissionSummaryOf({ title: "Spawn", kind: "other", rawInput: { command: ["ls", "-la"] } })
        .fields,
    ).toEqual([{ name: "command", value: "ls, -la" }]);
  });

  it("does not repeat a title that is the command", () => {
    const summary = permissionSummaryOf({
      title: "rm -rf dist",
      kind: "execute",
      rawInput: { command: "rm -rf dist" },
    });
    expect(summary).toMatchObject({ action: "Run a command", description: null });
    expect(summary.command).toBe("rm -rf dist");
  });

  it("takes the command from the title when the agent sends no input", () => {
    // The native agent's shape: the command is the title, and no input.
    expect(permissionSummaryOf({ title: HEREDOC, kind: "execute" })).toMatchObject({
      action: "Run a command",
      description: null,
      command: HEREDOC,
      fields: [],
    });
  });

  it("reads the Claude adapter's backticked title as the same command", () => {
    const command = "echo `date`\necho done";
    const summary = permissionSummaryOf({
      title: "`echo \\`date\\`\necho done`",
      kind: "execute",
      rawInput: { command },
    });
    expect(summary.command).toBe(command);
    expect(summary.description).toBeNull();
  });

  it("names a command that comes down to one action as that action", () => {
    expect(
      permissionSummaryOf({ kind: "execute", rawInput: { command: "cat src/lib/main.rs" } }),
    ).toMatchObject({ tool: "read", action: "Read lib/main.rs" });
  });

  it("never cuts a command, however long", () => {
    const command = "echo " + "a".repeat(10_000);
    expect(permissionSummaryOf({ title: command, rawInput: { command } }).command).toBe(command);
  });

  it("draws the rest of the input as named fields", () => {
    expect(
      permissionSummaryOf({
        title: "Edit main.rs",
        kind: "edit",
        rawInput: { file_path: "src/main.rs", replace_all: false, edits: [{ a: 1 }] },
      }),
    ).toEqual({
      tool: "edit",
      action: "Edit main.rs",
      description: null,
      source: null,
      command: null,
      fields: [
        { name: "file_path", value: "src/main.rs" },
        { name: "replace_all", value: "false" },
        { name: "edits", value: '[\n  {\n    "a": 1\n  }\n]' },
      ],
    });
  });

  it("caps a field that is not a command", () => {
    const summary = permissionSummaryOf({
      title: "Write a.txt",
      rawInput: { content: "x".repeat(9000) },
    });
    expect(summary.fields[0].value.endsWith("…(truncated)")).toBe(true);
  });

  it("keeps a long or multi-line title out of the headline", () => {
    const long = "x".repeat(HEADLINE_MAX + 1);
    expect(permissionSummaryOf({ title: long, kind: "fetch" })).toMatchObject({
      action: "Fetch a page",
      description: long,
    });
    expect(permissionSummaryOf({ title: "a\nb", kind: "edit" }).action).toBe("Edit a file");
    expect(permissionSummaryOf({ title: "x".repeat(HEADLINE_MAX) }).action).toBe(
      "x".repeat(HEADLINE_MAX),
    );
  });

  it("names a call with no title by its tool, as the transcript does, or its kind", () => {
    expect(permissionSummaryOf({ kind: "delete" }).action).toBe("Delete a file");
    expect(permissionSummaryOf({ toolName: "mcp__atlas_code__find_symbol" })).toMatchObject({
      action: "Find symbol",
      source: null,
    });
    expect(permissionSummaryOf({}).action).toBe("Use a tool");
  });

  it("names a third-party MCP call by its tool, with its server beside it", () => {
    expect(
      permissionSummaryOf({
        title: "mcp__linear__save_issue",
        toolName: "mcp__linear__save_issue",
      }),
    ).toMatchObject({ tool: "tool", action: "Save issue", source: "linear" });
  });

  it("draws small values the way they would be written", () => {
    const { fields } = permissionSummaryOf({
      rawInput: {
        labels: ["bug", "ui"],
        estimate: 2,
        parent: { id: "ATL-978", relation: "sub-issue" },
        empty: [],
        nested: [{ a: 1 }],
        wide: { a: "x".repeat(40), b: "y".repeat(40) },
        joined: ["bug, ui"],
      },
    });
    expect(Object.fromEntries(fields.map((f) => [f.name, f.value]))).toEqual({
      labels: "bug, ui",
      estimate: "2",
      parent: "{ id: ATL-978, relation: sub-issue }",
      empty: "[]",
      nested: '[\n  {\n    "a": 1\n  }\n]',
      wide: `{\n  "a": "${"x".repeat(40)}",\n  "b": "${"y".repeat(40)}"\n}`,
      // One value that holds a comma is not two values.
      joined: '[\n  "bug, ui"\n]',
    });
  });

  it("reads a third-party tool's `command` parameter as a field, not shell", () => {
    expect(
      permissionSummaryOf({
        toolName: "mcp__deploy__run",
        rawInput: { command: "restart", service: "api" },
      }),
    ).toMatchObject({ action: "Run", source: "deploy", command: null });
  });
});
