// @vitest-environment happy-dom
import { createRef } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TiptapEditor, type TiptapEditorHandle } from "./tiptap-editor";
import { clearDocCache } from "../lib/blocks-cache";
import { documentKey, saveDocument } from "../lib/document-saves";

vi.mock("@tauri-apps/api/event", () => import("@/test/tauri-event"));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

async function mounted(id: string, onSave: (markdown: string) => Promise<void>) {
  const ref = createRef<TiptapEditorHandle>();
  const view = render(
    <TiptapEditor
      ref={ref}
      documentId={id}
      projectPath="/notes"
      initialMarkdown="# Original\n\n"
      onSave={onSave}
    />,
  );
  await waitFor(() => expect(ref.current?.getEditor()).toBeTruthy());
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
  return { ref, view };
}

describe("rich text teardown saves", () => {
  it("writes an edited document after React clears the parent's imperative ref", async () => {
    const id = documentKey("/notes", "note", "teardown");
    let disk = "# Original\n\n";
    const persist = vi.fn(async (markdown: string) => {
      disk = markdown;
    });
    const { ref, view } = await mounted(id, persist);
    expect(persist).not.toHaveBeenCalled();
    await act(async () => {
      ref.current!.getEditor()!.commands.setContent("# Saved on teardown");
    });
    view.unmount();
    expect(ref.current).toBeNull();
    await waitFor(() => expect(disk).toContain("Saved on teardown"));
    clearDocCache();
    expect(disk).toBe("# Saved on teardown");
  });

  it("keeps a failed teardown save dirty when the document is reopened", async () => {
    const id = documentKey("/notes", "note", "retry");
    let disk = "# Original\n\n";
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockImplementation(async (markdown: string) => {
        disk = markdown;
      });
    const first = await mounted(id, persist);
    await act(async () => {
      first.ref.current!.getEditor()!.commands.setContent("# Recover me");
    });
    first.view.unmount();
    await waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    const second = await mounted(id, persist);
    expect(second.ref.current!.getEditor()!.getText()).toContain("Recover me");
    expect(second.ref.current!.isDirty()).toBe(true);
    await act(async () => {
      await second.ref.current!.save();
    });
    expect(second.ref.current!.isDirty()).toBe(false);
    second.view.unmount();
    await saveDocument(id);
    clearDocCache();
    expect(disk).toBe("# Recover me");
  });
});
