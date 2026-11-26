// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { tauri } from "@/test/tauri-fake";
import { GIT_REFRESH_DEBOUNCE_MS, useGitChangedRefresh } from "./use-git-changed-refresh";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));

beforeEach(() => {
  tauri.reset();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

function mount(visible: boolean, refresh: () => void) {
  const hook = renderHook(
    ({ visible: v }: { visible: boolean }) => useGitChangedRefresh("/proj", v, refresh),
    { initialProps: { visible } },
  );
  // The fake's `listen` subscribes synchronously, inside the mount's effect.
  return hook;
}

it("coalesces a burst of events for this project into one refresh", async () => {
  const refresh = vi.fn();
  mount(true, refresh);
  for (let i = 0; i < 5; i++) await tauri.emit("atlas:git-changed", { project: "/proj" });
  expect(refresh).not.toHaveBeenCalled();
  vi.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("ignores another project's repository", async () => {
  const refresh = vi.fn();
  mount(true, refresh);
  await tauri.emit("atlas:git-changed", { project: "/other" });
  vi.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS * 2);
  expect(refresh).not.toHaveBeenCalled();
});

it("only marks a hidden tab stale, and refreshes it once when shown", async () => {
  const refresh = vi.fn();
  const { rerender } = mount(false, refresh);
  await tauri.emit("atlas:git-changed", { project: "/proj/" });
  vi.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS);
  await tauri.emit("atlas:git-changed", { project: "/proj" });
  vi.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS);
  expect(refresh).not.toHaveBeenCalled();
  rerender({ visible: true });
  expect(refresh).toHaveBeenCalledTimes(1);
  rerender({ visible: false });
  rerender({ visible: true });
  expect(refresh).toHaveBeenCalledTimes(1);
});
