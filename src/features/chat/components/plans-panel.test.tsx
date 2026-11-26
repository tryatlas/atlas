// @vitest-environment happy-dom
//
// The Plans panel: loads the project's plans, reloads when one is saved,
// expands a plan's markdown, closes on Esc, and with no project open makes
// no call at all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
const loadPlans = vi.fn();
vi.mock("../lib/plans-api", () => ({ loadPlans: (p: string) => loadPlans(p) }));

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useAppStore } from "@/features/app/stores/app-store";
import type { PlanRecord } from "../lib/plans";
import { PlansPanel } from "./plans-panel";
import { emitWindowEvent } from "@/lib/window-events";

const PLAN = (id: string, userMessage: string): PlanRecord =>
  ({
    id,
    userMessage,
    plan: `# Plan ${id}\n\nStep one`,
    timestamp: "2026-11-04T10:00:00Z",
    sessionTitle: "Login race",
  }) as PlanRecord;

function setProject(path: string | null) {
  useAppStore.setState({
    currentProject: path ? ({ path, name: "p" } as never) : null,
  } as never);
}

beforeEach(() => {
  loadPlans.mockReset();
  setProject("/repo");
});
afterEach(cleanup);

describe("PlansPanel", () => {
  it("shows the empty state when the project has no plans", async () => {
    loadPlans.mockResolvedValue([]);
    render(<PlansPanel onClose={() => {}} />);
    await waitFor(() => expect(loadPlans).toHaveBeenCalledWith("/repo"));
    expect(screen.getByText(/No plans yet/)).toBeTruthy();
  });

  it("renders the plans, expands one, and reloads when a plan is saved", async () => {
    loadPlans.mockResolvedValue([PLAN("a", "Fix the race"), PLAN("b", "Bump the schema")]);
    render(<PlansPanel onClose={() => {}} />);
    await screen.findByText("Fix the race");
    expect(screen.getByText("Bump the schema")).toBeTruthy();
    expect(screen.queryByText("Plan a")).toBeNull();

    await userEvent.click(screen.getByText("Fix the race"));
    // The markdown renderer is lazy-loaded; its first import can outlast the 1s default.
    expect(await screen.findByText("Plan a", undefined, { timeout: 5000 })).toBeTruthy();

    act(() => {
      emitWindowEvent("atlas:plan-saved");
    });
    await waitFor(() => expect(loadPlans).toHaveBeenCalledTimes(2));
  });

  it("closes on Esc", async () => {
    loadPlans.mockResolvedValue([]);
    const onClose = vi.fn();
    render(<PlansPanel onClose={onClose} />);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("with no project open, shows the empty state and never loads", () => {
    setProject(null);
    render(<PlansPanel onClose={() => {}} />);
    expect(screen.getByText(/No plans yet/)).toBeTruthy();
    expect(loadPlans).not.toHaveBeenCalled();
  });

  it("never lists the previous project's plans after a switch", async () => {
    let releaseOld!: (plans: PlanRecord[]) => void;
    loadPlans.mockImplementation((path: string) =>
      path === "/repo"
        ? new Promise((done) => {
            releaseOld = done;
          })
        : new Promise(() => {}),
    );
    render(<PlansPanel onClose={() => {}} />);
    act(() => setProject("/other"));
    await waitFor(() => expect(loadPlans).toHaveBeenCalledWith("/other"));
    await act(async () => releaseOld([PLAN("a", "Old project plan")]));
    expect(screen.queryByText("Old project plan")).toBeNull();
  });

  it("hides the previous project's plans while the new project's load is pending", async () => {
    loadPlans.mockImplementation((path: string) =>
      path === "/repo" ? Promise.resolve([PLAN("a", "Old project plan")]) : new Promise(() => {}),
    );
    render(<PlansPanel onClose={() => {}} />);
    await screen.findByText("Old project plan");
    act(() => setProject("/other"));
    expect(screen.queryByText("Old project plan")).toBeNull();
  });
});
