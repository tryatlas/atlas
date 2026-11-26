// @vitest-environment happy-dom
import * as Y from "yjs";
import { afterEach, describe, expect, it } from "vitest";
import { bindTextField } from "./bind-text-field";
import { LOCAL, REMOTE, localUndo, nodesMap } from "./space-doc";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  document.body.replaceChildren();
});

function clients(content: string, legacy = false) {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const node = new Y.Map<unknown>();
  node.set("body", legacy ? content : new Y.Text(content));
  nodesMap(a).set("note", node);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a), REMOTE);
  a.on("update", (update, origin) => {
    if (origin !== REMOTE) Y.applyUpdate(b, update, REMOTE);
  });
  b.on("update", (update, origin) => {
    if (origin !== REMOTE) Y.applyUpdate(a, update, REMOTE);
  });
  const input = document.createElement("textarea");
  const peer = document.createElement("textarea");
  document.body.append(input, peer);
  cleanups.push(
    () => a.destroy(),
    () => b.destroy(),
  );
  cleanups.push(bindTextField(input, a, nodesMap(a).get("note")!, "body", false));
  cleanups.push(bindTextField(peer, b, nodesMap(b).get("note")!, "body", false));
  input.focus();
  return { a, b, input, peer, text: () => nodesMap(a).get("note")!.get("body") as Y.Text };
}
function type(input: HTMLTextAreaElement, value: string, cursor: number = value.length) {
  input.value = value;
  input.setSelectionRange(cursor, cursor);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("collaborative native text fields", () => {
  it("incorporates a focused peer insertion before the next local keystroke", () => {
    const { input, peer, text } = clients("hello");
    input.setSelectionRange(5, 5);
    type(peer, "hello peer");
    expect(input.value).toBe("hello peer");
    expect(input.selectionStart).toBe(10);
    type(input, `${input.value}!`);
    expect(text().toString()).toBe("hello peer!");
    expect(peer.value).toBe("hello peer!");
  });

  it("preserves peer text while an IME candidate replaces an original selection", () => {
    const { input, peer, text } = clients("abc");
    input.setSelectionRange(1, 2);
    input.dispatchEvent(new CompositionEvent("compositionstart"));
    type(input, "a你c", 2);
    type(peer, "aPEERbc");
    expect(input.value).toBe("a你c");
    input.dispatchEvent(new CompositionEvent("compositionend"));
    expect(text().toString()).toBe("aPEER你c");
    expect(input.value).toBe("aPEER你c");
    expect(peer.value).toBe("aPEER你c");
  });

  it("handles backward deletion and local-only undo without removing peer edits", () => {
    const { a, input, peer, text } = clients("abc");
    const undo = localUndo(a);
    cleanups.push(() => undo.destroy());
    type(peer, "peer abc");
    type(input, "peer ab");
    expect(text().toString()).toBe("peer ab");
    undo.undo();
    expect(text().toString()).toBe("peer abc");
    expect(input.value).toBe("peer abc");
  });

  it("does not mutate on focus/blur and promotes legacy strings only on edit", () => {
    const { a, input, peer } = clients("legacy", true);
    input.blur();
    expect(nodesMap(a).get("note")!.get("body")).toBe("legacy");
    type(input, "legacy updated");
    expect(nodesMap(a).get("note")!.get("body")).toBeInstanceOf(Y.Text);
    expect(peer.value).toBe("legacy updated");
  });

  it("maps a selection when the peer deletes before it", () => {
    const { input, b } = clients("prefix value");
    input.setSelectionRange(7, 12, "backward");
    b.transact(() => (nodesMap(b).get("note")!.get("body") as Y.Text).delete(0, 7), LOCAL);
    expect(input.value).toBe("value");
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5);
    expect(input.selectionDirection).toBe("backward");
  });
});
