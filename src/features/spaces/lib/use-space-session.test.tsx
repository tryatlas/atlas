// @vitest-environment happy-dom
import * as Y from "yjs";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpaceSession } from "./use-space-session";
import {
  spacesApi,
  type SpaceBridgeEvent,
  type SpaceOutboxEntry,
  type SpaceOutboxScope,
  type SpaceServerMessage,
} from "./spaces-api";
import { addNode, readNodes } from "./space-doc";
import { toBase64, fromBase64 } from "@/features/comms/lib/draft-sync";
import { spaceOutbox } from "./space-outbox";
import { useSpacesStore } from "../stores/spaces-store";

const fake = vi.hoisted(() => ({
  listener: (_event: SpaceBridgeEvent) => {},
  accountId: "a",
  orgId: "o",
  readOnly: null as string | null,
}));
vi.mock("./spaces-api", async (original) => {
  const actual = await original<typeof import("./spaces-api")>();
  return {
    ...actual,
    spacesApi: {
      summary: vi.fn(),
      sendControl: vi.fn(async () => {}),
      sendBinary: vi.fn(async () => {}),
      cycle: vi.fn(async () => {}),
      outboxEnqueue: vi.fn(),
      outboxLoad: vi.fn(),
      outboxAcknowledge: vi.fn(),
      outboxSaveSnapshot: vi.fn(),
      outboxSnapshot: vi.fn(),
    },
  };
});
vi.mock("./spaces-bus", () => ({
  subscribeSpaceBus: (_conv: string, listener: (event: SpaceBridgeEvent) => void) => {
    fake.listener = listener;
    return () => {
      fake.listener = () => {};
    };
  },
}));
vi.mock("./live-spaces", () => ({
  acquireSpaceSocket: vi.fn(async () => {}),
  releaseSpaceSocket: vi.fn(),
  registerOpenPage: (_conv: string, _page: string, _doc: Y.Doc, readOnly: string | null) => {
    fake.readOnly = readOnly;
    return () => {};
  },
}));
vi.mock("@/features/auth/stores/auth-store", () => ({
  useAuthStore: (select: (state: unknown) => unknown) =>
    select({
      snapshot: { status: "signed-in", user: { id: fake.accountId }, commsOrgId: fake.orgId },
    }),
}));
vi.mock("@/features/comms/stores/comms-store", () => ({
  useCommsStore: { getState: () => ({ members: [], me: "me" }) },
}));

let serial = 0;
let conv = "";
let rowId = 0;
const rows = new Map<number, SpaceOutboxEntry>();
const snapshots = new Map<string, number[]>();
const key = (scope: SpaceOutboxScope) => JSON.stringify(scope);
const page = (id: string) => ({
  id,
  kind: "page" as const,
  name: id,
  icon: null,
  parent_id: null,
  sort: 0,
  created_at: 0,
  updated_at: 0,
});
const emit = (message: SpaceServerMessage) =>
  act(() => fake.listener({ kind: "control", frame: JSON.stringify(message) }));
const connect = (state: "open" | "backoff" | "unavailable") =>
  act(() => fake.listener({ kind: "connection", state }));
function opened(pageId: string, slot: number, doc = new Y.Doc()) {
  emit({
    t: "page.opened",
    page_id: pageId,
    slot,
    resume: false,
    snapshot: toBase64(Y.encodeStateAsUpdate(doc)),
    index: 0,
    updates: [],
    read_only: null,
  });
  doc.destroy();
}
async function mounted() {
  const hook = renderHook(() => useSpaceSession(conv));
  connect("open");
  emit({
    t: "space.hello",
    protocol: 1,
    doc_version: 1,
    space_id: "s",
    conv_id: conv,
    pages: [page("p1"), page("p2")],
    active_page_id: "p1",
    archived: false,
  });
  opened("p1", 3);
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  return hook;
}
function updatesSent() {
  return vi
    .mocked(spacesApi.sendBinary)
    .mock.calls.filter(([, bytes]) => fromBase64(bytes)?.[0] === 1);
}

beforeEach(() => {
  conv = `conv-${++serial}`;
  rows.clear();
  snapshots.clear();
  localStorage.clear();
  fake.accountId = "account";
  fake.orgId = "org";
  fake.readOnly = null;
  useSpacesStore.getState().actions.clearAll();
  vi.mocked(spacesApi.sendBinary).mockClear().mockResolvedValue(undefined);
  vi.mocked(spacesApi.sendControl).mockClear().mockResolvedValue(undefined);
  vi.mocked(spacesApi.summary).mockResolvedValue({
    protocol: 1,
    doc_version: 1,
    space_id: "s",
    conv_id: conv,
    pages: [page("p1"), page("p2")],
    active_page_id: "p1",
    archived: false,
  });
  vi.mocked(spacesApi.outboxLoad).mockImplementation(async (scope) =>
    [...rows.values()].filter(
      (row) =>
        row.accountId === scope.accountId &&
        row.orgId === scope.orgId &&
        row.conversationId === scope.convId &&
        row.pageId === scope.pageId,
    ),
  );
  vi.mocked(spacesApi.outboxEnqueue).mockImplementation(async (scope, data) => {
    const id = ++rowId;
    rows.set(id, {
      id,
      accountId: scope.accountId,
      orgId: scope.orgId,
      conversationId: scope.convId,
      pageId: scope.pageId,
      data: [...fromBase64(data)!],
    });
    return id;
  });
  vi.mocked(spacesApi.outboxAcknowledge).mockImplementation(async (_scope, ids) => {
    for (const id of ids) rows.delete(id);
  });
  vi.mocked(spacesApi.outboxSaveSnapshot).mockImplementation(async (scope, data) => {
    snapshots.set(key(scope), [...fromBase64(data)!]);
  });
  vi.mocked(spacesApi.outboxSnapshot).mockImplementation(
    async (scope) => snapshots.get(key(scope)) ?? null,
  );
});
afterEach(async () => {
  cleanup();
  for (const pageId of ["p1", "p2"])
    await spaceOutbox({ accountId: "account", orgId: "org", convId: conv, pageId }).flush();
});

describe("Space session lifecycle", () => {
  it("keeps offline edits on their page across a switch and unmount", async () => {
    const hook = await mounted();
    connect("backoff");
    act(() =>
      addNode(hook.result.current.doc.current!, {
        id: "offline",
        kind: "note",
        x: 1,
        y: 2,
        body: "Saved from p1",
      }),
    );
    act(() => hook.result.current.openPage("p2"));
    hook.unmount();
    const journal = spaceOutbox({ accountId: "account", orgId: "org", convId: conv, pageId: "p1" });
    await journal.flush();
    expect([...rows.values()].every((row) => row.pageId === "p1")).toBe(true);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, journal.savedSnapshot!);
    journal.applyTo(copy);
    expect(readNodes(copy)[0].body).toBe("Saved from p1");
    expect(updatesSent()).toHaveLength(0);
    copy.destroy();
  });

  it("does not reuse the old slot between reconnect and the new page.opened", async () => {
    const hook = await mounted();
    connect("backoff");
    connect("open");
    act(() =>
      addNode(hook.result.current.doc.current!, { kind: "note", x: 0, y: 0, body: "queued" }),
    );
    await spaceOutbox({ accountId: "account", orgId: "org", convId: conv, pageId: "p1" }).flush();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(updatesSent()).toHaveLength(0);
    opened("p1", 9);
    await waitFor(() => expect(updatesSent()).toHaveLength(1));
    expect(fromBase64(updatesSent()[0][1])?.[1]).toBe(9);
    expect(updatesSent()[0][2]).toEqual({ accountId: "account", orgId: "org" });
    expect(rows.size).toBe(1); // Enqueue success is not server persistence evidence.
  });

  it("updates renderer and agent editability immediately on archive", async () => {
    const hook = await mounted();
    emit({ t: "space.access", archived: true });
    expect(hook.result.current.readOnly).toBe("archived");
    expect(fake.readOnly).toBe("archived");
    // Even an already queued model update is held until access is confirmed again.
    act(() =>
      addNode(hook.result.current.doc.current!, { kind: "note", x: 0, y: 0, body: "held" }),
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(updatesSent()).toHaveLength(0);
    emit({ t: "space.access", archived: false });
    expect(hook.result.current.readOnly).toBe("recovering");
    opened("p1", 4);
    await waitFor(() => expect(updatesSent()).toHaveLength(1));
    expect(hook.result.current.readOnly).toBeNull();
  });
});
