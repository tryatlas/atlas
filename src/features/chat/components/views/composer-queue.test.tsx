// @vitest-environment happy-dom
//
// The queue strip's "Queue paused — Resume" (ACP audit finding 77): a failed
// turn halts the queue in Rust, and this is the only way the user learns why
// nothing runs, and the only way to start it again.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ComposerQueue } from "./composer-queue";
import { queuePausedByFailure } from "../../lib/queue-halt";

afterEach(cleanup);

function renderQueue(paused: boolean) {
  const onResume = vi.fn();
  render(
    <ComposerQueue
      queue={["next step"]}
      remoteDriving={false}
      paused={paused}
      onResume={onResume}
      onEdit={() => {}}
      onRemove={() => {}}
    />,
  );
  return onResume;
}

describe("ComposerQueue's paused notice", () => {
  it("offers Resume while a failed turn holds the queue, and calls it", () => {
    const onResume = renderQueue(true);
    expect(screen.getByText(/Queue paused/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("is absent while the queue runs", () => {
    renderQueue(false);
    expect(screen.queryByText(/Queue paused/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
  });
});

describe("queuePausedByFailure", () => {
  it("holds only while the halt stands and something is queued", () => {
    expect(queuePausedByFailure(true, 2)).toBe(true);
    expect(queuePausedByFailure(true, 0)).toBe(false);
    expect(queuePausedByFailure(undefined, 2)).toBe(false);
    expect(queuePausedByFailure(false, 2)).toBe(false);
  });
});
