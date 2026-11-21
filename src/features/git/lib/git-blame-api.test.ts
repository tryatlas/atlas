import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The `git_blame_file` seam: the payload Rust destructures (`path`, `file`),
 * and one blame process per file however many callers ask at once.
 * Pattern: `git-avatars-api.test.ts`.
 */
vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
import { tauri } from "@/test/tauri-fake";

const invoke = tauri.invoke;

const { gitBlameFile } = await import("./git-blame-api");

beforeEach(() => {
  invoke.mockReset();
});

describe("gitBlameFile", () => {
  it("calls git_blame_file with the repository and the file", async () => {
    invoke.mockResolvedValue([]);
    await gitBlameFile("/repo", "src/a.ts");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("git_blame_file", {
      path: "/repo",
      file: "src/a.ts",
    });
  });

  it("runs one blame per file for a burst of callers, plus one fresh run", async () => {
    invoke.mockResolvedValue([]);
    await Promise.all([
      gitBlameFile("/repo", "src/a.ts"),
      gitBlameFile("/repo", "src/a.ts"),
      gitBlameFile("/repo", "src/a.ts"),
      gitBlameFile("/repo", "src/b.ts"),
    ]);
    const files = invoke.mock.calls.map(([, args]) => (args as { file: string }).file);
    expect(files.sort()).toEqual(["src/a.ts", "src/a.ts", "src/b.ts"]);
  });

  it("does not share a blame across repositories", async () => {
    invoke.mockResolvedValue([]);
    await Promise.all([gitBlameFile("/one", "a.ts"), gitBlameFile("/two", "a.ts")]);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});
