// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useQuitGuard } from "./use-quit-guard";

const state = vi.hoisted(() => ({
  requested: () => {},
  confirm: vi.fn(async () => true),
  flush: vi.fn(async () => {}),
  answer: vi.fn(async (_quit: boolean) => {}),
  busy: 0,
  confirmAgents: true,
  dirtyTabs: [] as { id: string }[],
  confirmFiles: vi.fn(async (_tabs: unknown[], _label: string) => true),
}));
vi.mock("@/features/editor/lib/dirty-close", () => ({
  dirtyFileTabs: () => state.dirtyTabs,
  confirmCloseFileTabs: state.confirmFiles,
}));
vi.mock("./quit-guard-api", () => ({
  onQuitRequested: async (handler: () => void) => {
    state.requested = handler;
    return () => {};
  },
  quitGuardReady: vi.fn(async () => {}),
  quitGuardAnswer: state.answer,
}));
vi.mock("@/lib/confirm", () => ({ confirm: state.confirm }));
vi.mock("@/features/projects/lib/flush-registry", () => ({ flushAll: state.flush }));
vi.mock("@/features/projects/lib/project-snapshot", () => ({ captureSnapshot: vi.fn() }));
vi.mock("@/features/projects/lib/stop-agents-confirm", () => ({
  busySessions: () => Array.from({ length: state.busy }),
}));
vi.mock("@/features/projects/stores/project-store", () => ({
  useProjectStore: { getState: () => ({ activeProjectId: "project" }) },
}));
vi.mock("@/features/app/stores/app-store", () => ({
  useAppStore: { getState: () => ({ currentProject: { path: "/project" } }) },
}));
vi.mock("@/features/settings/stores/settings-store", () => ({
  useSettingsStore: {
    getState: () => ({
      settings: {
        confirmQuitWhileRunning: state.confirmAgents,
        continueSessionsAfterRestart: true,
      },
    }),
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
beforeEach(() => {
  state.busy = 0;
  state.confirmAgents = true;
  state.answer.mockClear();
  state.flush.mockReset().mockResolvedValue(undefined);
  state.confirm.mockClear();
  state.dirtyTabs = [];
  state.confirmFiles.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);

describe("quit save barrier", () => {
  it.each([
    [0, true],
    [1, false],
  ] as const)("awaits saves with %s agents and confirmation=%s", async (busy, confirmAgents) => {
    state.busy = busy;
    state.confirmAgents = confirmAgents;
    let finish!: () => void;
    state.flush.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    renderHook(useQuitGuard);
    act(() => {
      state.requested();
      state.requested();
    });
    expect(state.flush).toHaveBeenCalledTimes(1);
    expect(state.answer).not.toHaveBeenCalled();
    expect(state.confirm).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(state.answer).toHaveBeenCalledWith(true));
  });

  it("cancels native quit on save failure and permits a successful retry", async () => {
    state.flush.mockRejectedValueOnce(new Error("disk full"));
    renderHook(useQuitGuard);
    act(() => state.requested());
    await waitFor(() => expect(state.answer).toHaveBeenCalledWith(false));
    act(() => state.requested());
    await waitFor(() => expect(state.answer).toHaveBeenLastCalledWith(true));
  });

  // D1: quitting dropped unsaved editor edits without asking.
  it("asks about unsaved files in every project, and Cancel keeps Atlas open", async () => {
    state.busy = 0;
    state.dirtyTabs = [{ id: "editor:/project/a.ts" }, { id: "editor:/other/b.ts" }];
    state.confirmFiles.mockResolvedValueOnce(false);
    renderHook(useQuitGuard);
    act(() => state.requested());
    await waitFor(() => expect(state.answer).toHaveBeenCalledWith(false));
    expect(state.confirmFiles).toHaveBeenCalledWith(state.dirtyTabs, "Quitting");
    expect(state.flush).not.toHaveBeenCalled();
  });

  it("quits after the unsaved files were saved or let go, flushing debounced saves", async () => {
    state.dirtyTabs = [{ id: "editor:/project/a.ts" }];
    renderHook(useQuitGuard);
    act(() => state.requested());
    await waitFor(() => expect(state.answer).toHaveBeenCalledWith(true));
    expect(state.confirmFiles).toHaveBeenCalledTimes(1);
    expect(state.flush).toHaveBeenCalledWith(expect.objectContaining({ reason: "quit" }));
  });
});
