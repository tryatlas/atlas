// @vitest-environment happy-dom
//
// Editing a queued message hands back the images it was queued with, so the
// composer stages them again: Edit used to restore the text and drop them.
import { beforeEach, describe, expect, it } from "vitest";
import type { MentionFile } from "../lib/mentions";
import { useChatStore } from "../stores/chat-store";
import { queuedImages } from "./use-composer-text";

const TAB = "tab-q";
const shot = { mimeType: "image/png", dataBase64: "aGk=" };
const chip = (path: string): MentionFile => ({
  kind: "file",
  id: path,
  displayName: path.split("/").pop()!,
  absPath: path,
});

beforeEach(() => {
  useChatStore.setState({ queues: {}, queueIds: {}, queueContent: {} });
});

describe("a queued message's images, for Edit", () => {
  it("come back paired with their chips, so deleting a chip still drops its image", () => {
    useChatStore
      .getState()
      .actions.enqueueMessage(TAB, "look", [chip("/tmp/a.png"), chip("/src/x.ts")], null, [shot]);
    expect(queuedImages(TAB, 0)).toEqual([{ ...shot, path: "/tmp/a.png" }]);
  });

  it("come back without a path when they do not pair with chips one for one", () => {
    useChatStore.getState().actions.enqueueMessage(TAB, "look", [], null, [shot, shot]);
    expect(queuedImages(TAB, 0)).toEqual([
      { ...shot, path: "" },
      { ...shot, path: "" },
    ]);
  });

  it("are none for a text-only message", () => {
    useChatStore.getState().actions.enqueueMessage(TAB, "plain", []);
    expect(queuedImages(TAB, 0)).toEqual([]);
  });
});
