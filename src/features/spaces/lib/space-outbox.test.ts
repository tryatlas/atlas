import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpaceOutbox, containsUpdate, updateBatches, type OutboxTransport } from "./space-outbox";
import { fromBase64 } from "@/features/comms/lib/draft-sync";
import { SPACE_FRAME_HEADER_BYTES, SPACE_UPDATE_MAX_BYTES } from "./space-wire";
import { type SpaceOutboxEntry, type SpaceOutboxScope } from "./spaces-api";

const scope: SpaceOutboxScope = {
  accountId: "account",
  orgId: "org",
  convId: "conv",
  pageId: "page",
};
const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
function document() {
  const doc = new Y.Doc({ gc: false });
  disposals.push(() => doc.destroy());
  return doc;
}
function disk() {
  const rows = new Map<number, SpaceOutboxEntry>();
  let snapshot: number[] | null = null;
  let id = 0;
  const api: OutboxTransport = {
    outboxEnqueue: vi.fn(async (scope, data) => {
      const next = ++id;
      rows.set(next, {
        id: next,
        accountId: scope.accountId,
        orgId: scope.orgId,
        conversationId: scope.convId,
        pageId: scope.pageId,
        data: [...fromBase64(data)!],
      });
      return next;
    }),
    outboxLoad: async () => [...rows.values()],
    outboxAcknowledge: vi.fn(async (_scope, ids) => {
      for (const id of ids) rows.delete(id);
    }),
    outboxSaveSnapshot: async (_scope, data) => {
      snapshot = [...fromBase64(data)!];
    },
    outboxSnapshot: async () => snapshot,
  };
  return { api, rows };
}
function update(doc: Y.Doc, change: () => void) {
  let result!: Uint8Array;
  const capture = (bytes: Uint8Array) => {
    result = bytes;
  };
  doc.on("update", capture);
  change();
  doc.off("update", capture);
  return result;
}

describe("durable Space outbox", () => {
  it("restores an offline page from its snapshot and operations after recreation", async () => {
    const { api, rows } = disk();
    const doc = document();
    doc.getText("body").insert(0, "Known baseline");
    const outbox = new SpaceOutbox(scope, api);
    const bytes = update(doc, () => doc.getText("body").insert(14, " + offline edit"));
    outbox.record(bytes, () => Y.encodeStateAsUpdate(doc));
    await outbox.flush();
    expect(rows.size).toBe(1);
    const reopened = new SpaceOutbox(scope, api);
    await reopened.hydrate();
    const recovered = document();
    Y.applyUpdate(recovered, reopened.savedSnapshot!);
    reopened.applyTo(recovered);
    reopened.applyTo(recovered);
    expect(recovered.getText("body").toString()).toBe("Known baseline + offline edit");
    expect(reopened.pending).toBe(true);
  });

  it("keeps an update when journaling fails and retries without a mounted view", async () => {
    const { api, rows } = disk();
    vi.mocked(api.outboxEnqueue).mockRejectedValueOnce(new Error("disk full"));
    const doc = document();
    const outbox = new SpaceOutbox(scope, api);
    outbox.record(update(doc, () => doc.getText("body").insert(0, "retry me")));
    await expect(outbox.flush()).rejects.toThrow("disk full");
    expect(outbox.pending).toBe(true);
    expect(outbox.error).toContain("disk full");
    await outbox.flush();
    expect(rows.size).toBe(1);
    expect(outbox.error).toBeNull();
  });

  it("does not acknowledge send success or a state-vector match for a deletion", async () => {
    const { api, rows } = disk();
    const local = document();
    local.getText("body").insert(0, "keep remove");
    const server = document();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(local));
    const deletion = update(local, () => local.getText("body").delete(5, 6));
    expect(Y.encodeStateVector(local)).toEqual(Y.encodeStateVector(server));
    expect(containsUpdate(server, deletion)).toBe(false);
    const outbox = new SpaceOutbox(scope, api);
    outbox.record(deletion);
    await outbox.flush();
    await outbox.acknowledge(server);
    expect(rows.size).toBe(1);
    Y.applyUpdate(server, deletion);
    // The proof still holds after encoding a fresh compacted snapshot.
    const compacted = document();
    Y.applyUpdate(compacted, Y.encodeStateAsUpdate(server));
    await outbox.acknowledge(compacted);
    expect(rows.size).toBe(0);
    expect(outbox.pending).toBe(false);
  });

  it("preserves new operations added while a snapshot is being persisted", async () => {
    const { api, rows } = disk();
    let release!: () => void;
    const save = api.outboxSaveSnapshot;
    api.outboxSaveSnapshot = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            release = done;
          }),
      )
      .mockImplementation(save);
    const doc = document();
    const outbox = new SpaceOutbox(scope, api);
    outbox.record(
      update(doc, () => doc.getText("body").insert(0, "one")),
      () => Y.encodeStateAsUpdate(doc),
    );
    const flushing = outbox.flush();
    await vi.waitFor(() => expect(release).toBeDefined());
    outbox.record(
      update(doc, () => doc.getText("body").insert(3, "two")),
      () => Y.encodeStateAsUpdate(doc),
    );
    const joining = outbox.flush();
    release();
    await Promise.all([flushing, joining]);
    expect(rows.size).toBe(2);
    const reopened = new SpaceOutbox(scope, api);
    await reopened.hydrate();
    const recovered = document();
    Y.applyUpdate(recovered, reopened.savedSnapshot!);
    expect(recovered.getText("body").toString()).toBe("onetwo");
  });

  it("bounds merged frames without dropping any original operations", () => {
    const docs = [document(), document(), document()];
    const updates = docs.map((doc, i) =>
      update(doc, () => doc.getText(String(i)).insert(0, "x".repeat(70_000))),
    );
    const batches = updateBatches(updates);
    expect(batches.length).toBe(3);
    const copy = document();
    for (const batch of batches) {
      expect(batch.length + SPACE_FRAME_HEADER_BYTES).toBeLessThanOrEqual(SPACE_UPDATE_MAX_BYTES);
      Y.applyUpdate(copy, batch);
    }
    for (let i = 0; i < 3; i++) expect(copy.getText(String(i)).length).toBe(70_000);
  });
});
