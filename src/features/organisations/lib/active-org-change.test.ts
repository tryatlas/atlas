// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

// The active organisation changing, through its one interface and through
// the comms store, which is where the boot reconciliation is noticed. The
// layout, spaces and comms stores are the real ones: what is asserted is the
// tabs left on screen and what would be written to disk, not a call made.

vi.mock("@tauri-apps/api/core", () => import("@/test/tauri-core"));
import { tauri } from "@/test/tauri-fake";

const snapshot = vi.fn();
vi.mock("@/features/comms/lib/comms-api", () => ({
  comms: {
    snapshot: (...args: unknown[]) => snapshot(...args),
    openConversation: vi.fn(() => new Promise(() => {})),
    conversationSnapshot: vi.fn(),
    closeConversation: vi.fn(() => Promise.resolve()),
  },
  listenComms: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: () => {} } }));

const { TEAM_CHAT_TAB, useLayoutStore } = await import("@/features/layout/stores/layout-store");
const { useSpacesStore } = await import("@/features/spaces/stores/spaces-store");
const { useCommsStore, commsActions, resetCommsSwitchStateForTests } =
  await import("@/features/comms/stores/comms-store");
const { ORG_SCOPED_TYPES } = await import("@/lib/tab-registry");
const { activeOrganisationChanged, pushActiveOrgAtBoot, resetActiveOrgChangeForTests } =
  await import("./active-org-change");

type Tab = ReturnType<typeof useLayoutStore.getState>["tabs"][number];
type Env = Parameters<ReturnType<typeof commsActions>["applyEnvelope"]>[0];

const layout = () => useLayoutStore.getState();
const tab = (id: string, type: Tab["type"], data: Record<string, unknown> = {}): Tab => ({
  id,
  type,
  title: id,
  closable: true,
  dirty: false,
  data,
  groupId: "main",
});
const draftTab = (id: string) => tab(`comms-draft-${id}`, "comms-draft", { convId: "c1" });
const spaceTab = (convId: string) => tab(`spaces-${convId}`, "spaces", { convId });

const tabIds = () => layout().tabs.map((t) => t.id);
const orgScopedOnScreen = () =>
  [...layout().tabs, ...(layout().destination ? [layout().destination!] : [])].filter((t) =>
    ORG_SCOPED_TYPES.has(t.type),
  );

/** What `save_editor_state` was last handed, parsed. */
function persistedTabs(): Array<{ id: string; type: Tab["type"] }> {
  const calls = tauri.calls("save_editor_state");
  const call = calls[calls.length - 1];
  if (!call) throw new Error("nothing was persisted");
  return (
    JSON.parse(call.args.stateJson as string) as { tabs: Array<{ id: string; type: Tab["type"] }> }
  ).tabs;
}

/** A window with one of everything the old organisation left open. */
function openOldOrgWindow(): void {
  useLayoutStore.setState({
    tabs: [
      { ...tab("chat-a", "chat"), closable: false },
      tab("editor-a", "editor", { filePath: "/p/a.ts" }),
      { ...TEAM_CHAT_TAB, groupId: "main" },
      draftTab("d1"),
      draftTab("d2"),
    ],
    groupOrder: ["main"],
    activeByGroup: { main: "chat-a" },
    focusedGroupId: "main",
    activeTabId: "chat-a",
    zen: false,
    zenPrev: null,
    destination: spaceTab("c1"),
    destinationShown: true,
    lastForm: {},
    viewsByWs: {},
  });
  useSpacesStore.getState().actions.requestPage("c1", "page-1");
}

const envelopeFrom = (org: string): Env =>
  ({ org, epoch: 2, ev: { kind: "presence", online: [] } }) as unknown as Env;

beforeEach(() => {
  tauri.reset();
  resetActiveOrgChangeForTests();
  resetCommsSwitchStateForTests();
  commsActions().reset();
  snapshot.mockReset();
  snapshot.mockImplementation(() => new Promise(() => {}));
  openOldOrgWindow();
});

describe("a switch", () => {
  it("closes every tab of the old organisation and keeps the window's", () => {
    expect(activeOrganisationChanged({ why: "switch", from: "local-a", to: "local-b" })).toBe(true);

    expect(orgScopedOnScreen()).toEqual([]);
    expect(layout().destination).toBeNull();
    // Team chat is the window's, and a file is the project's.
    expect(tabIds()).toEqual(["chat-a", "editor-a", "team-chat"]);
    expect(useSpacesStore.getState().requestedPages).toEqual({});
  });

  it("is a no-op when it is to the organisation already on screen", () => {
    const before = layout().tabs;

    expect(activeOrganisationChanged({ why: "switch", from: "local-a", to: "local-a" })).toBe(
      false,
    );

    expect(layout().tabs).toBe(before);
    expect(layout().destination?.id).toBe("spaces-c1");
    expect(useSpacesStore.getState().requestedPages).toEqual({ c1: "page-1" });
    // It settled nothing either: the boot push is still owed.
    expect(pushActiveOrgAtBoot({ signedIn: true, activeOrg: { remoteId: "org_a" } })).toBe(true);
  });

  it("leaves nothing of the old organisation in what is persisted", () => {
    activeOrganisationChanged({ why: "switch", from: "local-a", to: "local-b" });
    layout().actions.saveEditorState("/p");

    expect(persistedTabs().map((t) => t.id)).toEqual(["editor-a"]);
  });
});

describe("the boot reconciliation", () => {
  /** The comms store, showing the organisation Rust had stored. */
  function showingStaleOrg(): void {
    useCommsStore.setState({
      connection: { state: "open", reason: null, epoch: 1, orgId: "org_stale" },
    });
  }

  it("closes the stale organisation's tabs when the socket comes back on the right one", () => {
    showingStaleOrg();

    commsActions().applyEnvelope(envelopeFrom("org_a"));

    expect(orgScopedOnScreen()).toEqual([]);
    expect(tabIds()).toEqual(["chat-a", "editor-a", "team-chat"]);
    expect(useSpacesStore.getState().requestedPages).toEqual({});
    expect(useCommsStore.getState().connection.orgId).toBe("org_a");
  });

  it("does it exactly once: later envelopes close nothing opened since", () => {
    showingStaleOrg();
    commsActions().applyEnvelope(envelopeFrom("org_a"));
    // Opened in the organisation now on screen.
    layout().actions.addTab(draftTab("d3"));

    commsActions().applyEnvelope(envelopeFrom("org_a"));
    commsActions().applyEnvelope(envelopeFrom("org_a"));

    expect(tabIds()).toContain("comms-draft-d3");
  });

  it("closes nothing while the socket stays on the organisation on screen", () => {
    showingStaleOrg();
    const before = layout().tabs;

    commsActions().applyEnvelope(envelopeFrom("org_stale"));

    expect(layout().tabs).toBe(before);
  });

  it("leaves nothing of the stale organisation in what is persisted", async () => {
    showingStaleOrg();
    commsActions().applyEnvelope(envelopeFrom("org_a"));
    // Its own path: the layout store skips a write whose JSON matches the last
    // one that landed for that path, and an earlier test already saved "/p".
    await layout().actions.flushEditorState("/p-reconciled");

    expect(persistedTabs().some((t) => ORG_SCOPED_TYPES.has(t.type))).toBe(false);
  });
});

describe("the boot push of the active organisation", () => {
  const pushes = () => tauri.calls("auth_set_active_org");

  it("waits for sign-in and for the active organisation to be known", () => {
    expect(pushActiveOrgAtBoot({ signedIn: false, activeOrg: { remoteId: "org_a" } })).toBe(false);
    expect(pushActiveOrgAtBoot({ signedIn: true, activeOrg: undefined })).toBe(false);
    expect(pushes()).toEqual([]);

    expect(pushActiveOrgAtBoot({ signedIn: true, activeOrg: { remoteId: "org_a" } })).toBe(true);
    expect(pushes()).toEqual([{ cmd: "auth_set_active_org", args: { orgId: "org_a" } }]);
  });

  it("is made once, however often it is asked for (an effect run twice)", () => {
    const input = { signedIn: true, activeOrg: { remoteId: "org_a" } };

    pushActiveOrgAtBoot(input);
    pushActiveOrgAtBoot(input);
    pushActiveOrgAtBoot({ signedIn: true, activeOrg: { remoteId: "org_b" } });

    expect(pushes()).toHaveLength(1);
  });

  it("pins no organisation for a local-only one", () => {
    pushActiveOrgAtBoot({ signedIn: true, activeOrg: {} });

    expect(pushes()).toEqual([{ cmd: "auth_set_active_org", args: { orgId: null } }]);
  });

  it("is not made after a switch: the switch pushes its own choice", () => {
    activeOrganisationChanged({ why: "switch", from: "local-a", to: "local-b" });

    expect(pushActiveOrgAtBoot({ signedIn: true, activeOrg: { remoteId: "org_a" } })).toBe(false);
    expect(pushes()).toEqual([]);
  });

  it("a failed push is logged, not thrown", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    tauri.handleRaw({
      auth_set_active_org: () => {
        throw new Error("offline");
      },
    });

    pushActiveOrgAtBoot({ signedIn: true, activeOrg: { remoteId: "org_a" } });
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith("boot org reconciliation failed:", expect.any(Error));
    warn.mockRestore();
  });
});
