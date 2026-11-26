// @vitest-environment happy-dom
//
// A file tab's change bars and blame are refreshed only while it is shown.
// Every open tab hears the git watcher; before this, each one ran a git diff
// and a git blame per event whether or not anyone could see it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useGitMarksRefresh } from "./use-git-marks-refresh";

afterEach(cleanup);

function setup(visible: boolean) {
  const refresh = vi.fn();
  const hook = renderHook(({ visible }) => useGitMarksRefresh(visible, refresh), {
    initialProps: { visible },
  });
  return { ...hook, refresh };
}

describe("useGitMarksRefresh", () => {
  it("refreshes at once while the tab is shown", () => {
    const { result, refresh } = setup(true);
    act(() => result.current());
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does nothing while hidden, then refreshes once when shown", () => {
    const { result, refresh, rerender } = setup(false);
    act(() => {
      result.current();
      result.current();
      result.current();
    });
    expect(refresh).not.toHaveBeenCalled();
    rerender({ visible: true });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on showing a tab that heard nothing while hidden", () => {
    const { refresh, rerender } = setup(false);
    rerender({ visible: true });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not refresh again on a later show once caught up", () => {
    const { result, refresh, rerender } = setup(false);
    act(() => result.current());
    rerender({ visible: true });
    rerender({ visible: false });
    rerender({ visible: true });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("stops refreshing when the tab is hidden", () => {
    const { result, refresh, rerender } = setup(true);
    rerender({ visible: false });
    act(() => result.current());
    expect(refresh).not.toHaveBeenCalled();
  });
});
