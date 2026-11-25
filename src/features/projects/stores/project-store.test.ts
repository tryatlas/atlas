import { beforeEach, describe, expect, it, vi } from "vitest";

// `closeProject` reaches most of the app's stores through `teardownHot` and
// the fallback switch. Only the org store, the app store's `setActiveProject`
// and `clearPanelStores` are observed; the rest is inert.
vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
vi.mock("sonner", () => ({ toast: Object.assign(() => {}, { error: () => {} }) }));
vi.mock("@/features/log/lib/log", () => ({ logEvent: () => {} }));
vi.mock("../lib/flush-registry", () => ({ flushAll: async () => {} }));
const clearPanelStores = vi.fn();
vi.mock("../lib/project-snapshot", () => ({
  captureSnapshot: () => {},
  restoreSnapshot: () => {},
  evictSnapshot: () => {},
  clearPanelStores: () => clearPanelStores(),
}));
vi.mock("../lib/project-revalidate", () => ({ revalidateProject: () => {} }));
const setActiveProject = vi.fn();
vi.mock("@/features/app/stores/app-store", () => ({
  useAppStore: { getState: () => ({ actions: { setActiveProject } }) },
  scheduleAppStateSave: () => {},
  loadProjectStores: async () => {},
}));
vi.mock("@/features/layout/stores/layout-store", () => ({
  useLayoutStore: {
    getState: () => ({
      viewsByWs: {},
      actions: { commitProjectView: () => {}, removeProjectView: () => {} },
    }),
  },
}));
vi.mock("@/features/chat/stores/chat-store", () => ({
  useChatStore: { getState: () => ({ actions: { removeSessions: () => {} } }) },
}));
vi.mock("@/features/terminal/stores/terminal-store", () => ({
  useTerminalStore: { getState: () => ({ owners: {}, actions: { removeTabs: () => {} } }) },
}));
const org = { activeOrganisationId: "personal", organisations: [{ id: "personal" }] };
vi.mock("@/features/organisations/stores/org-store", () => ({
  useOrgStore: { getState: () => org },
}));
vi.mock("../lib/agent-activity", () => ({ isProjectRunning: () => false }));
vi.mock("../lib/stop-agents-confirm", () => ({
  busySessions: () => [],
  cancelBusySessions: async () => {},
  useStopAgentsConfirmStore: { getState: () => ({ actions: { ask: async () => true } }) },
}));
vi.mock("@/features/file-picker/lib/file-picker-api", () => ({
  markFileIndexClosedFor: () => {},
}));
vi.mock("../lib/instruction-sync-api", () => ({
  instructionSync: { stop: async () => {} },
}));

// Unsaved file tabs per project, and the user's answer to the save prompt.
const unsaved = vi.hoisted(() => ({
  byProject: {} as Record<string, { id: string; title: string; data: object; dirty: boolean }[]>,
  answer: true,
  confirm: vi.fn(),
  released: vi.fn(),
}));
vi.mock("@/features/editor/lib/dirty-close", () => ({
  dirtyFileTabs: (id: string) => unsaved.byProject[id] ?? [],
  confirmCloseFileTabs: async (tabs: unknown[], label: string) => {
    unsaved.confirm(tabs, label);
    return tabs.length === 0 || unsaved.answer;
  },
  filePathOf: () => undefined,
  releaseOrphanedFileBuffers: (paths: string[]) => unsaved.released(paths),
}));

const { useProjectStore } = await import("./project-store");
type Project = ReturnType<typeof useProjectStore.getState>["projects"][number];

const project = (id: string, orgId: string, lastActiveAt: string): Project => ({
  id,
  name: id,
  path: `/p/${id}`,
  orgId,
  lastActiveAt,
});

const switchTo = vi.fn(async (_id: string) => {});

beforeEach(() => {
  vi.clearAllMocks();
  unsaved.byProject = {};
  unsaved.answer = true;
  useProjectStore.setState((s) => ({
    activeProjectId: null,
    mountedProjectIds: [],
    projects: [],
    actions: { ...s.actions, switchTo },
  }));
});

describe("closeProject", () => {
  it("falls back to the most recent project in the same org", async () => {
    useProjectStore.setState({
      activeProjectId: "mlbb",
      projects: [
        project("mlbb", "personal", "2026-10-21T10:00:00Z"),
        project("old", "personal", "2026-10-01T10:00:00Z"),
        project("atlas", "team", "2026-10-20T10:00:00Z"),
      ],
    });

    await useProjectStore.getState().actions.closeProject("mlbb");

    expect(switchTo).toHaveBeenCalledWith("old");
  });

  // The bug: the fallback sorted every org's projects, so closing the last
  // project in Personal opened another org's project, invisible in
  // Personal's switcher and impossible to close from there.
  it("never opens another org's project when the org has none left", async () => {
    useProjectStore.setState({
      activeProjectId: "mlbb",
      projects: [
        project("mlbb", "personal", "2026-10-21T10:00:00Z"),
        project("atlas", "team", "2026-10-20T10:00:00Z"),
      ],
    });

    await useProjectStore.getState().actions.closeProject("mlbb");

    expect(switchTo).not.toHaveBeenCalled();
    expect(useProjectStore.getState().activeProjectId).toBeNull();
    expect(setActiveProject).toHaveBeenCalledWith(null);
    expect(clearPanelStores).toHaveBeenCalled();
    // The other org's project stays registered — it is only not opened.
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(["atlas"]);
  });
});

// D1: unsaved editor edits were dropped without a word when a project closed
// or was discarded past the hot-set cap.
describe("unsaved file edits", () => {
  const dirtyTab = { id: "editor:/p/a/x.ts", title: "x.ts", data: {}, dirty: true };

  it("asks before closing a project with unsaved files, and Cancel keeps it", async () => {
    unsaved.byProject.a = [dirtyTab];
    unsaved.answer = false;
    useProjectStore.setState({
      activeProjectId: "a",
      mountedProjectIds: ["a"],
      projects: [project("a", "personal", "2026-10-21T10:00:00Z")],
    });

    await useProjectStore.getState().actions.closeProject("a");

    expect(unsaved.confirm).toHaveBeenCalledWith([dirtyTab], "Closing this project");
    expect(useProjectStore.getState().projects.map((p) => p.id)).toEqual(["a"]);
    expect(useProjectStore.getState().activeProjectId).toBe("a");
  });

  it("closes once the user has saved or let the edits go", async () => {
    unsaved.byProject.a = [dirtyTab];
    useProjectStore.setState({
      activeProjectId: "a",
      mountedProjectIds: ["a"],
      projects: [project("a", "personal", "2026-10-21T10:00:00Z")],
    });

    await useProjectStore.getState().actions.closeProject("a");

    expect(unsaved.confirm).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().projects).toEqual([]);
  });

  it("never discards a background project with unsaved files past the cap", () => {
    const ids = ["a", "b", "c"];
    unsaved.byProject.a = [dirtyTab];
    useProjectStore.setState({
      maxMounted: 2,
      activeProjectId: "c",
      mountedProjectIds: ["a", "b"],
      projects: ids.map((id, i) => project(id, "personal", `2026-10-2${i}T10:00:00Z`)),
    });

    useProjectStore.getState().actions.ensureMounted("c");

    // `a` is the least recently active, but holds unsaved edits: `b` goes.
    expect(useProjectStore.getState().mountedProjectIds).toEqual(["a", "c"]);
  });
});
