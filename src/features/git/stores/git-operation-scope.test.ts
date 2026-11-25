// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import { applyGitOpEvent, useGitStore } from "./git-store";
import { tauri } from "@/test/tauri-fake";
vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

beforeEach(() => {
  tauri.reset();
  useGitStore.setState({ repoPath: "/a", activeOp: null, opsByRepo: {}, log: [], files: [] });
});

it("does not show another repository's operation or lose its terminal state", async () => {
  applyGitOpEvent({ repo: "/a", opId: "a", kind: "commit", phase: "started" });
  await useGitStore.getState().actions.loadStatus("/b");
  expect(useGitStore.getState().activeOp).toBeNull();
  applyGitOpEvent({
    repo: "/a",
    opId: "a",
    kind: "commit",
    phase: "output",
    lines: [{ stream: "stderr", line: "hook rejected" }],
  });
  applyGitOpEvent({ repo: "/a", opId: "a", kind: "commit", phase: "done", ok: false });
  expect(useGitStore.getState().activeOp).toBeNull();
  await useGitStore.getState().actions.loadStatus("/a");
  expect(useGitStore.getState().activeOp).toMatchObject({
    running: false,
    lines: [{ text: "hook rejected" }],
  });
});

it("does not let a background operation refresh retarget the displayed repository", async () => {
  await useGitStore.getState().actions.loadStatus("/b");
  await useGitStore.getState().actions.refresh("/a");
  expect(useGitStore.getState().repoPath).toBe("/b");
});

const snapshot = (branch: string, file: string) => ({
  isRepo: true,
  branch,
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [{ path: file, status: "M", staged: false, conflicted: false }],
  branches: [],
  stashes: [],
  inProgress: null,
});

it("drops the previous repository's status when switching, even if the new snapshot fails", async () => {
  tauri.handleRaw({ git_snapshot: () => snapshot("a-branch", "a.txt") });
  await useGitStore.getState().actions.loadStatus("/a");
  expect(useGitStore.getState().files.map((f) => f.path)).toEqual(["a.txt"]);
  tauri.handleRaw({
    git_snapshot: () => {
      throw new Error("not a repo");
    },
  });
  await useGitStore.getState().actions.loadStatus("/b");
  expect(useGitStore.getState().repoPath).toBe("/b");
  expect(useGitStore.getState().files).toEqual([]);
  expect(useGitStore.getState().branch).toBe("");
});

it("ignores a snapshot that resolves after the repository changed", async () => {
  let release!: () => void;
  tauri.handleRaw({
    git_snapshot: (args) =>
      (args as { path: string }).path === "/a"
        ? new Promise((done) => {
            release = () => done(snapshot("a-branch", "a.txt"));
          })
        : snapshot("b-branch", "b.txt"),
  });
  const slow = useGitStore.getState().actions.loadStatus("/a");
  await useGitStore.getState().actions.loadStatus("/b");
  release();
  await slow;
  expect(useGitStore.getState().repoPath).toBe("/b");
  expect(useGitStore.getState().branch).toBe("b-branch");
  expect(useGitStore.getState().files.map((f) => f.path)).toEqual(["b.txt"]);
});

it("keeps the newest snapshot when an older one for the same repository lands late", async () => {
  const pending: (() => void)[] = [];
  let n = 0;
  tauri.handleRaw({
    git_snapshot: () => {
      const label = `v${++n}`;
      return new Promise((done) => pending.push(() => done(snapshot(label, `${label}.txt`))));
    },
  });
  const first = useGitStore.getState().actions.refresh("/a");
  const second = useGitStore.getState().actions.refresh("/a");
  pending[1]();
  await second;
  pending[0]();
  await first;
  expect(useGitStore.getState().branch).toBe("v2");
});

it("ignores a log that resolves after the repository changed", async () => {
  let release!: () => void;
  tauri.handleRaw({
    git_snapshot: () => snapshot("b-branch", "b.txt"),
    git_log: () =>
      new Promise((done) => {
        release = () => done([{ sha: "a1", summary: "from a" }]);
      }),
  });
  const slow = useGitStore.getState().actions.loadLog("/a");
  await useGitStore.getState().actions.loadStatus("/b");
  release();
  await slow;
  expect(useGitStore.getState().log).toEqual([]);
});
