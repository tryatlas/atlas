import * as Y from "yjs";
import { toBase64, fromBase64 } from "@/features/comms/lib/draft-sync";
import { registerFlush } from "@/features/projects/lib/flush-registry";
import { spacesApi, type SpaceOutboxEntry, type SpaceOutboxScope } from "./spaces-api";
import { SPACE_UPDATE_MAX_BYTES, SPACE_FRAME_HEADER_BYTES } from "./space-wire";
import { REMOTE } from "./space-doc";

export interface OutboxTransport {
  outboxSaveSnapshot(scope: SpaceOutboxScope, data: string): Promise<void>;
  outboxSnapshot(scope: SpaceOutboxScope): Promise<number[] | null>;
  outboxEnqueue(scope: SpaceOutboxScope, data: string): Promise<number>;
  outboxLoad(scope: SpaceOutboxScope): Promise<SpaceOutboxEntry[]>;
  outboxAcknowledge(scope: SpaceOutboxScope, ids: number[]): Promise<void>;
}
interface Update {
  id: number | null;
  data: Uint8Array;
}

/** Read a full authoritative reply strictly; malformed bytes cannot prove receipt. */
export function authoritativePage(opened: {
  snapshot: string | null;
  updates: readonly string[];
}): Y.Doc {
  const doc = new Y.Doc({ gc: false });
  try {
    for (const part of opened.snapshot === null
      ? opened.updates
      : [opened.snapshot, ...opened.updates]) {
      const update = fromBase64(part);
      if (!update?.length) throw new Error("The Space sent an unreadable page update.");
      Y.applyUpdate(doc, update, REMOTE);
    }
    return doc;
  } catch (error) {
    doc.destroy();
    throw error;
  }
}

/** A state vector misses delete-only updates; compare the complete encoded state. */
export function containsUpdate(authoritative: Y.Doc, update: Uint8Array): boolean {
  const before = Y.encodeStateAsUpdate(authoritative);
  const copy = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(copy, before, REMOTE);
    Y.applyUpdate(copy, update, REMOTE);
    const after = Y.encodeStateAsUpdate(copy);
    return before.length === after.length && before.every((byte, index) => after[index] === byte);
  } finally {
    copy.destroy();
  }
}

/** Merge only while the resulting wire frame remains within the server limit. */
export function updateBatches(updates: readonly Uint8Array[]): Uint8Array[] {
  const limit = SPACE_UPDATE_MAX_BYTES - SPACE_FRAME_HEADER_BYTES;
  const batches: Uint8Array[] = [];
  let current: Uint8Array | null = null;
  for (const update of updates) {
    if (update.length > limit)
      throw new Error("An edit exceeds the Space's update limit. It remains saved on this device.");
    const merged: Uint8Array = current ? Y.mergeUpdates([current, update]) : update;
    if (merged.length > limit) {
      batches.push(current!);
      current = update;
    } else current = merged;
  }
  if (current) batches.push(current);
  return batches;
}

/**
 * Lifetime is the account/org/page, never a React mount. Updates are retained
 * before IPC starts, committed locally before sending, and removed only after
 * a full server page proves the insertion AND deletion effects are durable.
 */
export class SpaceOutbox {
  private updates: Update[] = [];
  private writing: Promise<void> | null = null;
  private loading: Promise<void> | null = null;
  private loaded = false;
  private snapshot: Uint8Array | null = null;
  private snapshotSource: (() => Uint8Array) | null = null;
  private snapshotPending = false;
  private snapshotNeedsCapture = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  error: string | null = null;

  constructor(
    readonly scope: SpaceOutboxScope,
    private readonly transport: OutboxTransport = spacesApi,
  ) {}
  get savedSnapshot(): Uint8Array | null {
    return this.snapshot;
  }
  get pending(): boolean {
    return this.updates.length > 0;
  }
  get records(): ReadonlyArray<{ id: number; data: Uint8Array }> {
    return this.updates.filter((update): update is Update & { id: number } => update.id !== null);
  }
  get data(): readonly Uint8Array[] {
    return this.updates.map((update) => update.data);
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed() {
    for (const listener of this.listeners) listener();
  }

  record(data: Uint8Array, snapshot?: () => Uint8Array): void {
    if (
      !this.updates.some(
        (update) =>
          update.data.length === data.length &&
          update.data.every((byte, index) => byte === data[index]),
      )
    ) {
      this.updates.push({ id: null, data: data.slice() });
    }
    if (snapshot) this.captureSnapshot(snapshot);
    this.changed();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => {});
    }, 33);
  }

  captureSnapshot(source: () => Uint8Array): void {
    this.snapshotSource = source;
    this.snapshotNeedsCapture = true;
    if (this.timer === null)
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush().catch(() => {});
      }, 400);
  }

  hydrate(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (this.loading) return this.loading;
    const loading = Promise.all([
      this.transport.outboxLoad(this.scope),
      this.transport.outboxSnapshot(this.scope),
    ])
      .then(([rows, snapshot]) => {
        if (!this.snapshotPending && !this.snapshotNeedsCapture && snapshot)
          this.snapshot = Uint8Array.from(snapshot);
        for (const row of rows) {
          if (
            row.accountId !== this.scope.accountId ||
            row.orgId !== this.scope.orgId ||
            row.conversationId !== this.scope.convId ||
            row.pageId !== this.scope.pageId
          )
            throw new Error("The saved Space edits belong to another page or account.");
          if (!this.updates.some((update) => update.id === row.id))
            this.updates.push({ id: row.id, data: Uint8Array.from(row.data) });
        }
        this.updates.sort((a, b) => (a.id ?? Infinity) - (b.id ?? Infinity));
        this.loaded = true;
        this.error = null;
        this.changed();
      })
      .catch((error) => {
        this.error = `Saved Space edits could not be recovered: ${String(error)}`;
        this.changed();
        throw error;
      })
      .finally(() => {
        this.loading = null;
      });
    this.loading = loading;
    return loading;
  }

  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Capture before a caller destroys the live Y.Doc, including while an older
    // flush is still in flight. Full snapshots make revoked/deleted pages recoverable.
    if (this.snapshotNeedsCapture && this.snapshotSource) {
      try {
        this.snapshot = this.snapshotSource();
        this.snapshotPending = true;
        this.snapshotNeedsCapture = false;
        this.snapshotSource = null;
      } catch (error) {
        this.error = String(error);
        this.changed();
        return Promise.reject(error);
      }
    }
    if (this.writing) return this.writing;
    if (!this.snapshotPending && !this.updates.some((update) => update.id === null))
      return Promise.resolve();
    const writing = Promise.resolve()
      .then(async () => {
        for (;;) {
          let update = this.updates.find((item) => item.id === null);
          if (update) {
            // A pointer drag is many Yjs transactions but one bridge/disk batch.
            // Keep individual oversized edits locally too; sending reports their limit.
            const combined = new Set<Update>([update]);
            let bytes = update.data;
            for (const candidate of this.updates) {
              if (candidate === update || candidate.id !== null) continue;
              const merged = Y.mergeUpdates([bytes, candidate.data]);
              if (merged.length + SPACE_FRAME_HEADER_BYTES > SPACE_UPDATE_MAX_BYTES) break;
              bytes = merged;
              combined.add(candidate);
            }
            if (combined.size > 1) {
              update = { id: null, data: bytes };
              this.updates = [...this.updates.filter((item) => !combined.has(item)), update];
            }
            const id = await this.transport.outboxEnqueue(this.scope, toBase64(update.data));
            this.updates = this.updates.filter((item) => item === update || item.id !== id);
            update.id = id;
            continue;
          }
          if (this.snapshotNeedsCapture && this.snapshotSource) {
            this.snapshot = this.snapshotSource();
            this.snapshotPending = true;
            this.snapshotNeedsCapture = false;
            this.snapshotSource = null;
          }
          if (this.snapshotPending && this.snapshot) {
            const snapshot = this.snapshot;
            await this.transport.outboxSaveSnapshot(this.scope, toBase64(snapshot));
            if (snapshot === this.snapshot) this.snapshotPending = false;
            continue;
          }
          break;
        }
        this.error = null;
      })
      .catch((error) => {
        this.error = `Space edits are waiting to be saved on this device: ${String(error)}`;
        throw error;
      })
      .finally(() => {
        this.writing = null;
        this.changed();
      });
    this.writing = writing;
    return writing;
  }

  applyTo(doc: Y.Doc): void {
    for (const update of this.updates) Y.applyUpdate(doc, update.data, REMOTE);
  }

  async acknowledge(authoritative: Y.Doc): Promise<void> {
    const confirmed = this.updates.filter(
      (update) => update.id !== null && containsUpdate(authoritative, update.data),
    );
    if (!confirmed.length) return;
    await this.transport.outboxAcknowledge(
      this.scope,
      confirmed.map((update) => update.id!),
    );
    const ids = new Set(confirmed.map((update) => update.id));
    this.updates = this.updates.filter((update) => update.id === null || !ids.has(update.id));
    this.changed();
  }
}

const outboxes = new Map<string, SpaceOutbox>();
export function spaceOutbox(scope: SpaceOutboxScope): SpaceOutbox {
  const key = JSON.stringify([scope.accountId, scope.orgId, scope.convId, scope.pageId]);
  let outbox = outboxes.get(key);
  if (!outbox) {
    outbox = new SpaceOutbox(scope);
    outboxes.set(key, outbox);
  }
  return outbox;
}

registerFlush(
  "spaces-outbox",
  async () => {
    const results = await Promise.allSettled(
      [...outboxes.values()].map((outbox) => outbox.flush()),
    );
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length)
      throw new AggregateError(errors, "Space edits could not be saved on this device.");
  },
  { required: true },
);

export interface SavedSpacePage extends SpaceOutboxScope {
  name: string;
}
const INDEX_KEY = "atlas:spaces:recovery-pages";
export function savedSpacePages(accountId: string, convId: string): SavedSpacePage[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter(
      (page): page is SavedSpacePage =>
        page !== null &&
        typeof page === "object" &&
        page.accountId === accountId &&
        page.convId === convId &&
        typeof page.orgId === "string" &&
        typeof page.pageId === "string" &&
        typeof page.name === "string",
    );
  } catch {
    return [];
  }
}
export function rememberSpacePage(page: SavedSpacePage): void {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]");
    const pages = Array.isArray(raw) ? raw : [];
    const next = pages.filter(
      (entry) =>
        entry?.accountId !== page.accountId ||
        entry?.orgId !== page.orgId ||
        entry?.convId !== page.convId ||
        entry?.pageId !== page.pageId,
    );
    next.push(page);
    localStorage.setItem(INDEX_KEY, JSON.stringify(next));
  } catch {
    /* The document is durable in Rust even when view metadata cannot be cached. */
  }
}
