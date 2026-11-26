// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A restart, from the frontend's side: what Rust hands over at boot is what
// the app sends back on its next save. Nothing dropped, nothing renamed.
//
// The payloads are the ones Rust wrote (`@/bindings/app-state/fixtures`,
// serialized by `src-tauri/src/state/app_state_bindings.rs` from the states
// its own restart tests save and load). They go in through the production
// boot (`startAppBoot`) into the REAL app, project and organisation stores,
// and come out through the real save path, `flushAppStateSave`, against the
// Tauri fake. What Rust then does with that save is pinned on its side
// (`the_frontends_own_save_reproduces_the_state`).
//
// Only the stores' leaves are stubbed: the panels a project switch loads, and
// the settings store, whose state is `config.toml`'s and not `state.json`'s.
vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
import { tauri } from "@/test/tauri-fake";

vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, { error: () => {}, success: () => {} }),
}));
vi.mock("@/features/log/lib/log", () => ({ logEvent: () => {} }));
vi.mock("@/lib/markdown", () => ({ primeMarkdown: () => {} }));
vi.mock("@/lib/markdown-cache", () => ({ primeMarkdownRenderer: () => {} }));
vi.mock("@/features/projects/lib/flush-registry", () => ({
  flushAll: async () => {},
  registerFlush: () => {},
}));
vi.mock("@/features/projects/lib/project-snapshot", () => ({
  captureSnapshot: () => {},
  restoreSnapshot: () => {},
  evictSnapshot: () => {},
  clearPanelStores: () => {},
}));
vi.mock("@/features/projects/lib/project-revalidate", () => ({ revalidateProject: () => {} }));
vi.mock("@/features/projects/lib/agent-activity", () => ({ isProjectRunning: () => false }));
vi.mock("@/features/projects/lib/stop-agents-confirm", () => ({
  busySessions: () => [],
  cancelBusySessions: async () => {},
  useStopAgentsConfirmStore: { getState: () => ({ actions: { ask: async () => true } }) },
}));
vi.mock("@/features/projects/lib/instruction-sync-api", () => ({
  instructionSync: { stop: async () => {} },
}));
vi.mock("@/features/file-picker/lib/file-picker-api", () => ({
  markFileIndexClosedFor: () => {},
}));
vi.mock("@/features/layout/stores/layout-store", () => ({
  useLayoutStore: {
    getState: () => ({
      viewsByWs: {},
      actions: {
        commitProjectView: () => {},
        removeProjectView: () => {},
        loadProjectView: () => {},
        loadEditorState: async () => {},
        flushEditorState: async () => {},
      },
    }),
  },
}));
vi.mock("@/features/chat/stores/chat-store", () => ({
  useChatStore: { getState: () => ({ actions: { removeSessions: () => {} } }) },
}));
vi.mock("@/features/terminal/stores/terminal-store", () => ({
  useTerminalStore: { getState: () => ({ owners: {}, actions: { removeTabs: () => {} } }) },
}));
vi.mock("@/features/terminal/stores/session-drawer-store", () => ({
  drawerTabsOwnedBy: () => [],
}));
vi.mock("@/features/git/stores/git-store", () => ({
  useGitStore: { getState: () => ({ actions: { loadStatus: async () => {} } }) },
}));
vi.mock("@/features/app/stores/session-store", () => ({
  useSessionStore: { getState: () => ({ actions: { loadSession: async () => {} } }) },
}));
vi.mock("@/features/knowledge/stores/knowledge-meta-store", () => ({
  useKnowledgeMetaStore: { getState: () => ({ actions: { bind: async () => {} } }) },
}));
vi.mock("@/features/knowledge/stores/knowledge-store", () => ({
  useKnowledgeStore: { getState: () => ({ actions: { loadEntries: async () => {} } }) },
}));
vi.mock("@/features/organisations/lib/org-telemetry", () => ({ syncOrgTelemetry: () => {} }));
vi.mock("@/features/auth/lib/auth-api", () => ({ auth: {} }));
vi.mock("@/features/auth/stores/auth-store", () => ({
  useAuthStore: { getState: () => ({ snapshot: { status: "signed-out" }, actions: {} }) },
}));
const settingsHydrate = vi.fn();
vi.mock("@/features/settings/stores/settings-store", () => ({
  useSettingsStore: {
    getState: () => ({
      settings: { autoAddAtlasGitignore: false },
      actions: { hydrate: settingsHydrate },
    }),
  },
}));

import type { AppStatePatch } from "@/bindings/app-state/AppStatePatch";
import {
  bootstrapFull,
  bootstrapMinimal,
  patchFull,
  patchMinimal,
} from "@/bindings/app-state/fixtures";
import { DEFAULT_SETTINGS } from "@/features/settings/lib/app-settings";
import type { AppStateWire } from "../stores/app-store";

const { flushAppStateSave, setAppStateWritable, useAppStore } = await import("../stores/app-store");
const { useProjectStore } = await import("@/features/projects/stores/project-store");
const { useOrgStore } = await import("@/features/organisations/stores/org-store");
const { startAppBoot } = await import("./start-app-boot");

/** The moment the restart happens. A boot that reopens a project stamps it. */
const NOW = "2026-11-16T08:00:00.000Z";

/** `value` as it crosses IPC, less its `null`s: Rust writes an empty
 *  `Option` as `null` and reads an absent key as the same thing, so the two
 *  spellings are one value. Everything else must match exactly. */
function onTheWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (_key, v: unknown) => (v === null ? undefined : v));
}

/** Wait for `done`, a turn of the event loop at a time. Not `vi.waitFor`:
 *  with the clock faked it advances the clock, and the time is asserted. */
async function until(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !done(); turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(done()).toBe(true);
}

/** Boot from `saved`, then quit: the save that reaches Rust. */
async function restart(saved: Omit<AppStateWire, "settings">): Promise<AppStatePatch> {
  const payload: AppStateWire = { ...saved, settings: DEFAULT_SETTINGS };
  tauri.handleRaw({ bootstrap_app_state: () => payload });

  startAppBoot();
  // The load, the hydrate, and the switch to the saved project it starts.
  await until(() => useAppStore.getState().hydrated);
  await until(() => !useProjectStore.getState().switching);

  tauri.invoke.mockClear();
  await flushAppStateSave();
  const saves = tauri.calls("save_app_state");
  expect(saves).toHaveLength(1);
  return (saves[0].args as { payload: AppStatePatch }).payload;
}

beforeEach(() => {
  tauri.reset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  settingsHydrate.mockClear();
  setAppStateWritable(false);
  delete (window as unknown as { __atlasAppReady?: boolean }).__atlasAppReady;
  useAppStore.setState({ currentProject: null, recentProjects: [], hydrated: false });
  useProjectStore.setState({ projects: [], activeProjectId: null, mountedProjectIds: [] });
  useOrgStore.setState({ organisations: [], activeOrganisationId: null });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a restart", () => {
  it("sends back a state with every optional field empty exactly as it arrived", async () => {
    const sent = await restart(bootstrapMinimal);

    expect(onTheWire(sent)).toEqual(onTheWire(patchMinimal));
  });

  it("sends back a fully populated state, changed only by reopening its project", async () => {
    const sent = await restart(bootstrapFull);

    // The boot switches to the saved active project, and a switch is the
    // user opening it: it is stamped as the last active, and moves to the
    // head of the recents with a fresh time. Nothing else may differ.
    const expected = structuredClone(patchFull) as AppStatePatch;
    const active = expected.workspaces.find((w) => w.id === expected.activeWorkspaceId);
    expect(active).toBeDefined();
    active!.lastActiveAt = NOW;
    expect(expected.recentProjects[0].path).toBe(active!.path);
    expected.recentProjects[0].lastOpened = NOW;

    expect(onTheWire(sent)).toEqual(onTheWire(expected));
  });

  it("holds every field of an organisation and a project in the stores", async () => {
    await restart(bootstrapFull);

    // The stores' own vocabulary: the frozen `activeWorkspaceId` is
    // `activeProjectId` in the app, at both levels.
    const [personal, northwind] = useOrgStore.getState().organisations;
    expect(personal.activeProjectId).toBe("ws-1");
    expect(personal).not.toHaveProperty("activeWorkspaceId");
    expect(northwind).toMatchObject({ syncEnabled: true, remoteId: "srv-org-2" });
    expect(useOrgStore.getState().activeOrganisationId).toBe(bootstrapFull.activeOrganisationId);
    expect(useProjectStore.getState().activeProjectId).toBe(bootstrapFull.activeWorkspaceId);
    expect(useAppStore.getState().currentProject).toEqual({
      name: "atlas",
      path: "/Users/dev/atlas",
    });
  });

  it("holds an empty value as an absent key, never as null", async () => {
    await restart(bootstrapMinimal);

    const [org] = useOrgStore.getState().organisations;
    const [project] = useProjectStore.getState().projects;
    expect(Object.values(org)).not.toContain(null);
    expect(Object.values(project)).not.toContain(null);
  });

  it("hands the settings slice to the settings store, and never saves it", async () => {
    const sent = await restart(bootstrapFull);

    expect(settingsHydrate).toHaveBeenCalledWith({
      settings: DEFAULT_SETTINGS,
      configGeneration: bootstrapFull.configGeneration,
      configStatus: bootstrapFull.configStatus,
    });
    // Rust's own, and the legacy field: neither is the frontend's to send.
    expect(Object.keys(sent).sort()).toEqual(Object.keys(patchFull).sort());
    expect(sent).not.toHaveProperty("telemetryAnonId");
    expect(sent).not.toHaveProperty("currentProject");
  });
});
