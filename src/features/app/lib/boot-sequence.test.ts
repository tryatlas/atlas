import { beforeEach, describe, expect, it, vi } from "vitest";

// The boot's one rule: a session that did not load `state.json` never writes
// it. Driven through `runBootSequence` with the app store's REAL write gate
// and save path against the Tauri fake, so what is asserted is whether
// `save_app_state` reached the backend, not which setter was called. The
// app store's sibling stores are stubbed as in `app-store.test.ts`.
vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
import { tauri } from "@/test/tauri-fake";

vi.mock("@/features/log/lib/log", () => ({ logEvent: () => {} }));
vi.mock("@/features/projects/lib/flush-registry", () => ({ registerFlush: () => {} }));
vi.mock("@/features/layout/stores/layout-store", () => ({
  useLayoutStore: { getState: () => ({ actions: {} }) },
}));
vi.mock("@/features/projects/stores/project-store", () => ({
  useProjectStore: { getState: () => ({ projects: [], activeProjectId: null, actions: {} }) },
}));
vi.mock("@/features/organisations/stores/org-store", () => ({
  useOrgStore: { getState: () => ({ organisations: [], activeOrganisationId: null }) },
}));
vi.mock("@/features/settings/stores/settings-store", () => ({
  useSettingsStore: { getState: () => ({ settings: {} }) },
}));

import type { AppStateWire } from "../stores/app-store";
import { runBootSequence, type BootSequenceDeps } from "./boot-sequence";

const { flushAppStateSave, setAppStateWritable } = await import("../stores/app-store");

const SAVED = { recentProjects: [], version: 1 } as unknown as AppStateWire;

/** Resolves once everything the boot queued has run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** The saves that reached the backend: the quit flush is the one that runs
 *  unconditionally, so it is the one asked for here. */
async function savesAfterQuitFlush(): Promise<number> {
  await flushAppStateSave();
  return tauri.calls("save_app_state").length;
}

/**
 * The boot, wired to the real load command and the real write gate. Every
 * step it takes is recorded in `steps`, in order.
 */
function boot(overrides: Partial<BootSequenceDeps> = {}) {
  const steps: string[] = [];
  const deps: BootSequenceDeps = {
    takeCliPath: async () => {
      steps.push("take-cli-path");
      return (await tauri.invoke("cli_take_initial_project_path")) as string | null;
    },
    loadState: async () => {
      steps.push("load");
      return (await tauri.invoke("bootstrap_app_state")) as AppStateWire;
    },
    wait: async (ms) => {
      steps.push(`wait:${ms}`);
    },
    transition: (apply) => apply(),
    enablePersistence: (enabled) => {
      steps.push(`persistence:${enabled ? "on" : "off"}`);
      setAppStateWritable(enabled);
    },
    applyState: (_state, opts) => {
      steps.push(opts.skipActiveSwitch ? "apply:without-switch" : "apply");
    },
    applyEmptyState: () => {
      steps.push("apply-empty");
    },
    reportLoadFailure: () => {
      steps.push("report-failure");
    },
    openCliProject: async (path) => {
      steps.push(`open-cli:${path}`);
    },
    ready: () => {
      steps.push("ready");
    },
    ...overrides,
  };
  return { steps, cancel: runBootSequence(deps) };
}

beforeEach(() => {
  tauri.reset();
  // A fresh launch: the gate starts closed (`app-store.test.ts` holds the
  // module's own default to that).
  setAppStateWritable(false);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("a load that succeeds", () => {
  it("enables saving", async () => {
    tauri.handleRaw({ bootstrap_app_state: () => SAVED });

    boot();
    await settle();

    expect(await savesAfterQuitFlush()).toBe(1);
  });

  it("takes the CLI path, loads, enables persistence, applies, then signals ready", async () => {
    tauri.handleRaw({ bootstrap_app_state: () => SAVED });

    const { steps } = boot();
    await settle();

    expect(steps).toEqual(["take-cli-path", "load", "persistence:on", "apply", "ready"]);
  });

  it("with a CLI folder: applies without its own switch, then opens the folder", async () => {
    tauri.handleRaw({
      cli_take_initial_project_path: () => "/work/repo",
      bootstrap_app_state: () => SAVED,
    });

    const { steps } = boot();
    await settle();

    expect(steps).toEqual([
      "take-cli-path",
      "load",
      "persistence:on",
      "apply:without-switch",
      "open-cli:/work/repo",
      "ready",
    ]);
  });

  it("retries a transient failure, pausing longer each time", async () => {
    let attempt = 0;
    tauri.handleRaw({
      bootstrap_app_state: () => {
        attempt += 1;
        if (attempt < 3) throw new Error("ipc hiccup");
        return SAVED;
      },
    });

    const { steps } = boot();
    await settle();

    expect(steps).toEqual([
      "take-cli-path",
      "load",
      "wait:150",
      "load",
      "wait:300",
      "load",
      "persistence:on",
      "apply",
      "ready",
    ]);
    expect(await savesAfterQuitFlush()).toBe(1);
  });

  it("carries on without a CLI folder when asking for it fails", async () => {
    tauri.handleRaw({
      cli_take_initial_project_path: () => {
        throw new Error("no such command");
      },
      bootstrap_app_state: () => SAVED,
    });

    const { steps } = boot();
    await settle();

    expect(steps).toEqual(["take-cli-path", "load", "persistence:on", "apply", "ready"]);
  });
});

describe("a load that fails", () => {
  const failing = { bootstrap_app_state: () => Promise.reject(new Error("state.json unreadable")) };

  it("never saves, however often a flush is asked for", async () => {
    tauri.handleRaw(failing);

    boot();
    await settle();

    expect(await savesAfterQuitFlush()).toBe(0);
    expect(await savesAfterQuitFlush()).toBe(0);
  });

  it("denies saving even in a session where it had been allowed", async () => {
    tauri.handleRaw(failing);
    setAppStateWritable(true);

    boot();
    await settle();

    expect(await savesAfterQuitFlush()).toBe(0);
  });

  it("gives up after three attempts, says so, and still comes up", async () => {
    tauri.handleRaw(failing);

    const { steps } = boot();
    await settle();

    expect(steps).toEqual([
      "take-cli-path",
      "load",
      "wait:150",
      "load",
      "wait:300",
      "load",
      "persistence:off",
      "report-failure",
      "apply-empty",
      "ready",
    ]);
  });

  it("does not open the CLI folder: there is no organisation to own it", async () => {
    tauri.handleRaw({ ...failing, cli_take_initial_project_path: () => "/work/repo" });

    const { steps } = boot();
    await settle();

    expect(steps.some((s) => s.startsWith("open-cli"))).toBe(false);
    expect(steps[steps.length - 1]).toBe("ready");
  });
});

describe("a load that never delivers", () => {
  it("a slow load followed by unmount applies nothing and does not save", async () => {
    let deliver: (state: AppStateWire) => void = () => {};
    tauri.handleRaw({
      bootstrap_app_state: () => new Promise<AppStateWire>((resolve) => (deliver = resolve)),
    });

    const { steps, cancel } = boot();
    await settle();
    cancel();
    deliver(SAVED);
    await settle();

    expect(steps).toEqual(["take-cli-path", "load"]);
    expect(await savesAfterQuitFlush()).toBe(0);
  });

  it("a load that hangs does not save", async () => {
    tauri.handleRaw({ bootstrap_app_state: () => new Promise(() => {}) });

    const { steps } = boot();
    await settle();

    expect(steps).toEqual(["take-cli-path", "load"]);
    expect(await savesAfterQuitFlush()).toBe(0);
  });
});

describe("a load that only partly applies", () => {
  // The state loaded, but handing it to the stores threw halfway: some hold
  // the user's lists, the rest still hold their empty defaults. Saving that
  // replaces the persisted lists with the empty ones.
  const halfApplied: Partial<BootSequenceDeps> = {
    applyState: () => {
      throw new Error("organisations hydrated, projects did not");
    },
    // React's `startTransition` reports what its callback throws and carries
    // on; the sequence must not depend on the throw reaching it.
    transition: (apply) => {
      try {
        apply();
      } catch {
        /* reported, as React does */
      }
    },
  };

  it("never saves", async () => {
    tauri.handleRaw({ bootstrap_app_state: () => SAVED });

    boot(halfApplied);
    await settle();

    expect(await savesAfterQuitFlush()).toBe(0);
  });

  it("says so, skips the CLI folder, and still comes up", async () => {
    tauri.handleRaw({
      cli_take_initial_project_path: () => "/work/repo",
      bootstrap_app_state: () => SAVED,
    });

    const { steps } = boot(halfApplied);
    await settle();

    expect(steps).toEqual([
      "take-cli-path",
      "load",
      "persistence:on",
      "persistence:off",
      "report-failure",
      "ready",
    ]);
  });
});
