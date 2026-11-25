import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  captureDocumentEdit,
  deleteDocument,
  documentKey,
  isDocumentDirty,
  saveDocument,
  saveProjectDocuments,
} from "./document-saves";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
let serial = 0;
let id = "";
beforeEach(() => {
  id = `document-${++serial}`;
});

describe("document save ownership", () => {
  it("retains a failed revision and retries it after its editor has gone", async () => {
    let disk = "before";
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementation(async (markdown: string) => {
        disk = markdown;
      });
    captureDocumentEdit(id, { projectPath: "/project", serialize: () => "after", persist });
    await expect(saveDocument(id)).rejects.toThrow("disk full");
    expect(isDocumentDirty(id)).toBe(true);
    expect(disk).toBe("before");
    await saveDocument(id);
    expect(disk).toBe("after");
    expect(isDocumentDirty(id)).toBe(false);
  });

  it("serializes a second edit made while the first revision is writing", async () => {
    const first = deferred();
    const writes: string[] = [];
    const persist = async (markdown: string) => {
      writes.push(markdown);
      if (markdown === "first") await first.promise;
    };
    captureDocumentEdit(id, { projectPath: "/project", serialize: () => "first", persist });
    const saving = saveDocument(id);
    await Promise.resolve();
    captureDocumentEdit(id, { projectPath: "/project", serialize: () => "second", persist });
    expect(writes).toEqual(["first"]);
    first.resolve();
    await saving;
    expect(writes).toEqual(["first", "second"]);
    expect(isDocumentDirty(id)).toBe(false);
  });

  it("keeps equal note IDs in separate projects and flushes the requested owner", async () => {
    const a = documentKey("/a", "note", id);
    const b = documentKey("/b", "note", id);
    const disk = new Map<string, string>();
    for (const [key, projectPath, content] of [
      [a, "/a", "alpha"],
      [b, "/b", "beta"],
    ]) {
      captureDocumentEdit(key, {
        projectPath,
        serialize: () => content,
        persist: async (md) => {
          disk.set(projectPath, md);
        },
      });
    }
    await saveProjectDocuments("/a");
    expect(disk.get("/a")).toBe("alpha");
    expect(disk.has("/b")).toBe(false);
    expect(isDocumentDirty(b)).toBe(true);
    await saveProjectDocuments("/b");
    expect(disk.get("/b")).toBe("beta");
  });

  it("waits for an older write before delete and retains edits if delete fails", async () => {
    const first = deferred();
    const events: string[] = [];
    captureDocumentEdit(id, {
      projectPath: "/project",
      serialize: () => "old",
      persist: async () => {
        await first.promise;
        events.push("write");
      },
    });
    const saving = saveDocument(id);
    await Promise.resolve();
    const deletion = deleteDocument(id, async () => {
      events.push("delete");
    });
    first.resolve();
    await Promise.all([saving, deletion]);
    expect(events).toEqual(["write", "delete"]);
    captureDocumentEdit(id, {
      projectPath: "/project",
      serialize: () => "still here",
      persist: async () => {},
    });
    await expect(
      deleteDocument(id, async () => {
        throw new Error("denied");
      }),
    ).rejects.toThrow("denied");
    expect(isDocumentDirty(id)).toBe(true);
    await saveDocument(id);
  });
});
