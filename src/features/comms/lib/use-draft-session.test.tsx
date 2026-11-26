// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { create } from "zustand";
import * as Y from "yjs";
import { useDraftSession } from "./use-draft-session";
import { publishDraftEvent } from "./draft-bus";
import { fromBase64, toBase64 } from "./draft-sync";
import { spaceOutbox } from "@/features/spaces/lib/space-outbox";
import {
  spacesApi,
  type SpaceOutboxEntry,
  type SpaceOutboxScope,
} from "@/features/spaces/lib/spaces-api";
import { comms } from "./comms-api";
import type { PromptDraft } from "../types";

const fake = vi.hoisted(() => ({ accountId: "account", orgId: "org" }));
const connection = create(() => ({
  me: "me",
  connection: { state: "open", epoch: 1, orgId: "org" },
}));
vi.mock("../stores/comms-store", () => ({
  useCommsStore: {
    getState: () => connection.getState(),
    subscribe: (fn: () => void) => connection.subscribe(fn),
  },
}));
vi.mock("@/features/auth/stores/auth-store", () => {
  const getState = () => ({
    snapshot: { status: "signed-in", user: { id: fake.accountId }, commsOrgId: fake.orgId },
  });
  return {
    useAuthStore: Object.assign(
      (select: (s: ReturnType<typeof getState>) => unknown) => select(getState()),
      { getState },
    ),
  };
});
vi.mock("./comms-api", () => ({
  comms: {
    draftOpen: vi.fn(async () => {}),
    draftUpdate: vi.fn(async () => {}),
    draftAwareness: vi.fn(async () => {}),
  },
}));
vi.mock("@/features/spaces/lib/spaces-api", () => ({
  spacesApi: {
    outboxLoad: vi.fn(),
    outboxEnqueue: vi.fn(),
    outboxAcknowledge: vi.fn(),
    outboxSnapshot: vi.fn(),
    outboxSaveSnapshot: vi.fn(),
  },
}));

let serial = 0;
let draft: PromptDraft;
let rows: SpaceOutboxEntry[];
const snapshots = new Map<string, number[]>();
const scope = (): SpaceOutboxScope => ({
  accountId: "account",
  orgId: "org",
  convId: draft.conv_id,
  pageId: `draft:${draft.id}`,
});
const opened = (doc = new Y.Doc()) =>
  act(() =>
    publishDraftEvent({
      kind: "opened",
      draft_id: draft.id,
      draft,
      snapshot: toBase64(Y.encodeStateAsUpdate(doc)),
      updates: [],
    }),
  );

beforeEach(() => {
  draft = {
    id: `draft-${++serial}`,
    conv_id: "conv",
    title: "Plan",
    created_by: "me",
    created_at: 1,
    updated_at: 1,
    sent_at: null,
    sent_by: null,
    sent_message_id: null,
  };
  rows = [];
  snapshots.clear();
  fake.accountId = "account";
  fake.orgId = "org";
  connection.setState({ connection: { state: "open", epoch: 1, orgId: "org" } });
  vi.mocked(comms.draftUpdate).mockReset().mockResolvedValue(undefined);
  vi.mocked(comms.draftOpen).mockClear();
  vi.mocked(spacesApi.outboxLoad).mockImplementation(async () => rows);
  vi.mocked(spacesApi.outboxSnapshot).mockImplementation(
    async (s) => snapshots.get(JSON.stringify(s)) ?? null,
  );
  vi.mocked(spacesApi.outboxEnqueue).mockImplementation(async (s, data) => {
    const id = rows.length + 1;
    rows.push({
      id,
      accountId: s.accountId,
      orgId: s.orgId,
      conversationId: s.convId,
      pageId: s.pageId,
      data: [...fromBase64(data)!],
    });
    return id;
  });
  vi.mocked(spacesApi.outboxSaveSnapshot).mockImplementation(async (s, data) => {
    snapshots.set(JSON.stringify(s), [...fromBase64(data)!]);
  });
  vi.mocked(spacesApi.outboxAcknowledge).mockImplementation(async (_s, ids) => {
    rows = rows.filter((r) => !ids.includes(r.id));
  });
});
afterEach(cleanup);

it("recovers offline edits after closing and replays only after a fresh subscribed snapshot", async () => {
  let hook = renderHook(() => useDraftSession(draft));
  opened();
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  act(() => connection.setState({ connection: { state: "backoff", epoch: 1, orgId: "org" } }));
  act(() => hook.result.current.ytext.insert(0, "keep my draft"));
  hook.unmount();
  await spaceOutbox(scope()).flush();
  hook = renderHook(() => useDraftSession(draft));
  await waitFor(() => expect(hook.result.current.ytext.toString()).toBe("keep my draft"));
  expect(comms.draftUpdate).not.toHaveBeenCalled();
  act(() => connection.setState({ connection: { state: "open", epoch: 2, orgId: "org" } }));
  await waitFor(() =>
    expect(comms.draftOpen).toHaveBeenCalledWith(draft.id, { accountId: "account", orgId: "org" }),
  );
  expect(comms.draftUpdate).not.toHaveBeenCalled();
  opened();
  await waitFor(() => expect(comms.draftUpdate).toHaveBeenCalledOnce());
  expect(rows.length).toBeGreaterThan(0);
  const server = new Y.Doc();
  Y.applyUpdate(server, fromBase64(vi.mocked(comms.draftUpdate).mock.calls[0][1])!);
  opened(server);
  await waitFor(() => expect(rows).toHaveLength(0));
  expect(hook.result.current.ytext.toString()).toBe("keep my draft");
  server.destroy();
});

it("retains a refused socket write and never transmits it as a different account", async () => {
  vi.mocked(comms.draftUpdate).mockRejectedValue(new Error("socket closed"));
  const hook = renderHook(() => useDraftSession(draft));
  opened();
  await waitFor(() => expect(hook.result.current.ready).toBe(true));
  act(() => hook.result.current.ytext.insert(0, "not acknowledged"));
  await waitFor(() => expect(hook.result.current.syncError).toContain("socket closed"));
  expect(spaceOutbox(scope()).pending).toBe(true);
  const calls = vi.mocked(comms.draftUpdate).mock.calls.length;
  fake.accountId = "other";
  act(() => hook.result.current.retrySync());
  await act(() => spaceOutbox(scope()).flush());
  expect(comms.draftUpdate).toHaveBeenCalledTimes(calls);
  hook.unmount();
  await spaceOutbox(scope()).flush();
  const recovered = new Y.Doc();
  Y.applyUpdate(recovered, Uint8Array.from(snapshots.get(JSON.stringify(scope()))!));
  expect(recovered.getText("prompt").toString()).toBe("not acknowledged");
  recovered.destroy();
});
