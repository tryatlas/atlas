import * as Y from "yjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editSpacePage } from "./space-page-edit";
import { fromBase64 } from "@/features/comms/lib/draft-sync";
import { addNode, readNodes } from "./space-doc";
import { spacesApi } from "./spaces-api";

vi.mock("./spaces-api", () => ({
  spacesApi: {
    outboxLoad: vi.fn(async () => []),
    outboxSnapshot: vi.fn(async () => null),
    outboxEnqueue: vi.fn(async () => 1),
    outboxSaveSnapshot: vi.fn(async () => {}),
  },
}));
vi.mock("./live-spaces", () => ({ openPage: vi.fn(() => undefined) }));
afterEach(() => vi.clearAllMocks());

describe("delayed Space page edits", () => {
  it("persists the original page after navigation closes its live document", async () => {
    const doc = new Y.Doc();
    addNode(doc, {
      id: "existing",
      kind: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 30,
      text: "page A",
    });
    const scope = {
      accountId: "original-account",
      orgId: "original-org",
      convId: "upload-conv",
      pageId: "page-a",
    };
    const target = { scope, snapshot: Y.encodeStateAsUpdate(doc) };
    doc.destroy();
    await editSpacePage(target, (page) =>
      addNode(page, {
        id: "uploaded",
        kind: "media",
        mediaKind: "image",
        contentHash: "hash",
        mime: "image/png",
        x: 20,
        y: 30,
        width: 50,
        height: 50,
      }),
    );
    expect(spacesApi.outboxEnqueue).toHaveBeenCalledWith(scope, expect.any(String));
    const [savedScope, bytes] = vi.mocked(spacesApi.outboxSaveSnapshot).mock.calls[0];
    expect(savedScope).toEqual(scope);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, fromBase64(bytes)!);
    expect(
      readNodes(restored)
        .map((node) => node.id)
        .sort(),
    ).toEqual(["existing", "uploaded"]);
    restored.destroy();
  });
});
