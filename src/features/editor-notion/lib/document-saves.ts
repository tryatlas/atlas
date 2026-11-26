import { registerFlush } from "@/features/projects/lib/flush-registry";

interface PendingDocument {
  projectPath: string;
  serialize: () => string;
  persist: (markdown: string) => Promise<void>;
  markdown?: string;
}

// A snapshot owns its project and writer even after its editor unmounts.
// Serialization closes over an immutable ProseMirror document, never a ref.
const pending = new Map<string, PendingDocument>();
const writes = new Map<string, Promise<void>>();

export function captureDocumentEdit(id: string, draft: PendingDocument): void {
  pending.set(id, draft);
}

export function isDocumentDirty(id: string): boolean {
  return pending.has(id);
}

export function saveDocument(id: string): Promise<void> {
  // Materialize at the boundary, while its editor still owns the schema.
  // Keep those bytes on failure so Retry never needs a destroyed editor.
  const current = pending.get(id);
  try {
    if (current && current.markdown === undefined) current.markdown = current.serialize();
  } catch (error) {
    return Promise.reject(error);
  }
  const running = writes.get(id);
  if (running) return running;
  const write = Promise.resolve().then(async () => {
    let draft = pending.get(id);
    while (draft) {
      const markdown = draft.markdown ?? (draft.markdown = draft.serialize());
      await draft.persist(markdown);
      if (pending.get(id) === draft) pending.delete(id);
      draft = pending.get(id);
    }
  });
  writes.set(id, write);
  void write
    .finally(() => {
      if (writes.get(id) === write) writes.delete(id);
    })
    .catch(() => {});
  return write;
}

/** Delete only after older writes settle; a failed deletion retains the draft. */
export function deleteDocument(id: string, remove: () => Promise<void>): Promise<void> {
  const running = writes.get(id);
  const deletion = Promise.resolve().then(async () => {
    await running?.catch(() => {});
    await remove();
    pending.delete(id);
  });
  writes.set(id, deletion);
  void deletion
    .finally(() => {
      if (writes.get(id) === deletion) writes.delete(id);
    })
    .catch(() => {});
  return deletion;
}

export function documentKey(projectPath: string, ...parts: string[]): string {
  return JSON.stringify([projectPath, ...parts]);
}

export async function saveProjectDocuments(path: string | null): Promise<void> {
  const results = await Promise.allSettled(
    [...pending]
      .filter(([, draft]) => path === null || draft.projectPath === path)
      .map(([id]) => saveDocument(id)),
  );
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Edits could not be saved.",
    );
}

registerFlush(
  "user-documents",
  ({ path, reason }) => saveProjectDocuments(reason === "switch" ? path : null),
  { required: true },
);
