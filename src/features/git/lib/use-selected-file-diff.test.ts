// @vitest-environment happy-dom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { tauri } from "@/test/tauri-fake";
import { useSelectedFileDiff } from "./use-selected-file-diff";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));

type Props = { file: string | null; files: unknown; epoch: number };

beforeEach(() => tauri.reset());

it("never shows the previous file's diff under the newly selected file", async () => {
  const pending = new Map<string, (diff: string) => void>();
  tauri.handleRaw({
    git_diff_file: (args) =>
      new Promise((done) => pending.set((args as { file: string }).file, done)),
  });
  const files: unknown[] = [];
  const { result, rerender } = renderHook(
    ({ file, files: list, epoch }: Props) => useSelectedFileDiff("/repo", file, false, list, epoch),
    { initialProps: { file: "a.ts", files, epoch: 0 } as Props },
  );
  expect(result.current).toEqual({ state: "loading" });
  await act(async () => pending.get("a.ts")!("diff of a"));
  expect(result.current).toEqual({ state: "ready", diff: "diff of a" });

  rerender({ file: "b.ts", files, epoch: 0 });
  expect(result.current).toEqual({ state: "loading" });
  await act(async () => pending.get("b.ts")!("diff of b"));
  expect(result.current).toEqual({ state: "ready", diff: "diff of b" });
});

it("shows the failure instead of keeping the previous file's diff", async () => {
  tauri.handleRaw({
    git_diff_file: (args) => {
      if ((args as { file: string }).file === "b.ts") throw new Error("boom");
      return "diff of a";
    },
  });
  const files: unknown[] = [];
  const { result, rerender } = renderHook(
    ({ file, files: list, epoch }: Props) => useSelectedFileDiff("/repo", file, false, list, epoch),
    { initialProps: { file: "a.ts", files, epoch: 0 } as Props },
  );
  await waitFor(() => expect(result.current).toEqual({ state: "ready", diff: "diff of a" }));
  rerender({ file: "b.ts", files, epoch: 0 });
  await waitFor(() => expect(result.current.state).toBe("error"));
  expect(result.current).toMatchObject({ message: expect.stringContaining("boom") });
});

it("keeps the current diff while the same file reloads", async () => {
  let n = 0;
  const pending: ((diff: string) => void)[] = [];
  tauri.handleRaw({
    git_diff_file: () => (n++ === 0 ? "first" : new Promise<string>((done) => pending.push(done))),
  });
  const { result, rerender } = renderHook(
    ({ file, files: list, epoch }: Props) => useSelectedFileDiff("/repo", file, false, list, epoch),
    { initialProps: { file: "a.ts", files: [], epoch: 0 } as Props },
  );
  await waitFor(() => expect(result.current).toEqual({ state: "ready", diff: "first" }));
  rerender({ file: "a.ts", files: [], epoch: 1 });
  expect(result.current).toEqual({ state: "ready", diff: "first" });
  await act(async () => pending[0]("second"));
  expect(result.current).toEqual({ state: "ready", diff: "second" });
});
