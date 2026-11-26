import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Organisation } from "../types";

// A switch that goes ahead, against the launch's boot push of the active
// organisation: which `auth_set_active_org` calls reach Rust, and in what
// order. The stores the teardown walks are inert stand-ins; the two modules
// under test (`org-switch`, `active-org-change`) and the Tauri fake are real.
vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
import { tauri } from "@/test/tauri-fake";

vi.mock("sonner", () => ({ toast: Object.assign(() => {}, { error: () => {} }) }));
vi.mock("@/features/log/lib/log", () => ({ logEvent: () => {} }));
vi.mock("@/features/log/stores/log-store", () => ({
  useLogStore: { getState: () => ({ actions: { setOrg: async () => {} } }) },
}));
vi.mock("@/features/projects/lib/flush-registry", () => ({ flushAll: async () => {} }));
vi.mock("@/features/projects/stores/project-store", () => ({
  useProjectStore: {
    getState: () => ({
      projects: [],
      activeProjectId: null,
      actions: { teardownForOrgSwitch: () => {}, switchTo: async () => {} },
    }),
  },
}));
vi.mock("@/features/projects/stores/project-git-store", () => ({
  resetGitSummariesForOrgSwitch: () => {},
}));
vi.mock("@/features/comms/stores/comms-store", () => ({
  commsActions: () => ({ beginSwitch: () => {}, endSwitch: () => {} }),
}));
vi.mock("@/features/comms/lib/comms-api", () => ({ comms: { ready: async () => {} } }));
vi.mock("@/features/layout/stores/layout-store", () => ({
  useLayoutStore: { getState: () => ({ tabs: [], destination: null, actions: {} }) },
}));
vi.mock("@/features/spaces/stores/spaces-store", () => ({
  useSpacesStore: { getState: () => ({ actions: { clearAll: () => {} } }) },
}));
vi.mock("@/features/app/stores/app-store", () => ({
  useAppStore: {
    getState: () => ({ currentProject: null, actions: { setActiveProject: () => {} } }),
  },
  flushAppStateSave: async () => {},
  scheduleAppStateSave: () => {},
}));
vi.mock("@/features/auth/stores/auth-store", () => ({
  useAuthStore: { getState: () => ({ snapshot: { status: "signed-in" } }) },
}));
vi.mock("@/features/auth/lib/auth-api", () => ({ auth: {} }));

// Running agents, and the "stop agents & switch?" prompt the test answers.
const prompt = { busy: 0, answer: null as ((ok: boolean) => void) | null };
vi.mock("@/features/projects/lib/stop-agents-confirm", () => ({
  busySessions: () => Array.from({ length: prompt.busy }),
  cancelBusySessions: async () => {},
  useStopAgentsConfirmStore: {
    getState: () => ({
      actions: { ask: () => new Promise<boolean>((resolve) => (prompt.answer = resolve)) },
    }),
  },
}));

// Unsaved file tabs across the mounted projects, and the save prompt's answer.
const files = { dirty: [] as { id: string }[], answer: true, asked: [] as string[] };
vi.mock("@/features/editor/lib/dirty-close", () => ({
  dirtyFileTabs: () => files.dirty,
  confirmCloseFileTabs: async (tabs: unknown[], label: string) => {
    if (tabs.length === 0) return true;
    files.asked.push(label);
    return files.answer;
  },
}));

const state = {
  organisations: [] as Organisation[],
  activeOrganisationId: "",
  actions: {
    setSwitching: () => {},
    setActiveProjectForOrg: () => {},
    setActiveOrganisation: (id: string) => {
      state.activeOrganisationId = id;
    },
  },
};
vi.mock("../stores/org-store", () => ({ useOrgStore: { getState: () => state } }));

const { switchOrg } = await import("./org-switch");
const { pushActiveOrgAtBoot, resetActiveOrgChangeForTests } = await import("./active-org-change");

const org = (id: string, remoteId?: string): Organisation => ({
  id,
  name: id,
  slug: id,
  syncEnabled: !!remoteId,
  remoteId,
});
const A = org("local-a", "org_a");
const B = org("local-b", "org_b");

/** The organisations Rust was told to make active, in the order it was told. */
const pushed = () => tauri.calls("auth_set_active_org").map((call) => call.args.orgId);
/** What `App` does when sign-in lands: offer the boot push the org on screen. */
const signInLands = () =>
  pushActiveOrgAtBoot({
    signedIn: true,
    activeOrg: state.organisations.find((o) => o.id === state.activeOrganisationId),
  });
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  tauri.reset();
  resetActiveOrgChangeForTests();
  state.organisations = [A, B];
  state.activeOrganisationId = A.id;
  prompt.busy = 0;
  prompt.answer = null;
  files.dirty = [];
  files.answer = true;
  files.asked = [];
});
afterEach(async () => {
  // The switch lets go of its re-entrancy guard on a timer (the overlay's
  // minimum time): run it out, or the next test's switch is coalesced away.
  await vi.runAllTimersAsync();
  vi.useRealTimers();
});

describe("a switch and the boot push of the active organisation", () => {
  it("a switch pushes its own organisation, and the boot push is not made after it", async () => {
    await switchOrg(B.id);
    expect(signInLands()).toBe(false);
    expect(pushed()).toEqual(["org_b"]);
  });

  it("sign-in landing while the stop-agents prompt is open does not push the organisation being left", async () => {
    prompt.busy = 1;
    const switching = switchOrg(B.id);
    await flush();
    expect(prompt.answer, "the prompt is open").not.toBeNull();

    // Sign-in finishes behind the prompt. The switch has begun: the old
    // organisation must not be sent to Rust beside the switch's own call.
    expect(signInLands()).toBe(false);
    expect(pushed()).toEqual([]);

    prompt.answer!(true);
    await switching;
    expect(pushed()).toEqual(["org_b"]);
  });

  it("makes the boot push it held back once the prompt is declined", async () => {
    prompt.busy = 1;
    const switching = switchOrg(B.id);
    await flush();
    signInLands();
    expect(pushed()).toEqual([]);

    // "Go back": no switch happened, so the boot push is still owed, and
    // nothing will offer it again (`App` only does when its inputs change).
    prompt.answer!(false);
    await switching;
    expect(state.activeOrganisationId).toBe(A.id);
    expect(pushed()).toEqual(["org_a"]);
    // Once: it is settled now.
    expect(signInLands()).toBe(false);
    expect(pushed()).toEqual(["org_a"]);
  });

  it("holds nothing back when the prompt is declined before sign-in lands", async () => {
    prompt.busy = 1;
    const switching = switchOrg(B.id);
    await flush();
    prompt.answer!(false);
    await switching;
    expect(pushed()).toEqual([]);

    expect(signInLands()).toBe(true);
    expect(pushed()).toEqual(["org_a"]);
  });
});

// D1: the teardown unmounted every editor, dropping unsaved edits unasked.
describe("unsaved file edits on an organization switch", () => {
  it("asks first, and Cancel leaves the organization as it was", async () => {
    files.dirty = [{ id: "editor:/p/a.ts" }];
    files.answer = false;
    await switchOrg(B.id);
    expect(files.asked).toEqual(["Switching organizations"]);
    expect(state.activeOrganisationId).toBe(A.id);
    expect(pushed()).toEqual([]);
  });

  it("goes ahead once the edits were saved or let go", async () => {
    files.dirty = [{ id: "editor:/p/a.ts" }];
    await switchOrg(B.id);
    expect(files.asked).toEqual(["Switching organizations"]);
    expect(state.activeOrganisationId).toBe(B.id);
  });
});
