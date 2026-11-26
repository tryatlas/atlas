import * as Y from "yjs";
import { openPage } from "./live-spaces";
import { LOCAL, REMOTE } from "./space-doc";
import { spaceOutbox } from "./space-outbox";
import type { SpaceOutboxScope } from "./spaces-api";

export interface SpacePageTarget {
  scope: SpaceOutboxScope;
  snapshot: Uint8Array;
}

/** Complete delayed work on the page where it began, including after navigation. */
export async function editSpacePage(
  target: SpacePageTarget,
  change: (doc: Y.Doc) => void,
): Promise<void> {
  const journal = spaceOutbox(target.scope);
  await journal.hydrate();
  const live = openPage(target.scope.convId, target.scope.pageId);
  const belongs =
    live?.identity?.accountId === target.scope.accountId &&
    live.identity.orgId === target.scope.orgId;
  const scratch = new Y.Doc();
  try {
    Y.applyUpdate(
      scratch,
      belongs ? Y.encodeStateAsUpdate(live.doc) : (journal.savedSnapshot ?? target.snapshot),
      REMOTE,
    );
    journal.applyTo(scratch);
    const updates: Uint8Array[] = [];
    scratch.on("update", (update: Uint8Array) => updates.push(update));
    change(scratch);
    if (!updates.length) return;
    const update = Y.mergeUpdates(updates);
    const snapshot = Y.encodeStateAsUpdate(scratch);
    journal.record(update, () => snapshot);
    if (belongs && live.readOnly === null) Y.applyUpdate(live.doc, update, LOCAL);
    await journal.flush();
  } finally {
    scratch.destroy();
  }
}
