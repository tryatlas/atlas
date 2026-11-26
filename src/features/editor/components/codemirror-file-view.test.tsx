// @vitest-environment happy-dom
import { createRef } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { CodeMirrorFileView, type CodeMirrorFileViewHandle } from "./codemirror-file-view";

vi.mock("../themes/build-cm-theme", () => ({ editorThemeExtensions: () => [] }));
vi.mock("../lib/languages", () => ({
  PLAINTEXT: "text",
  detectLanguage: () => "text",
  loadLanguageExtension: async () => [],
}));
afterEach(cleanup);

it("keeps CRLF on opening, editing, and replacing the document", async () => {
  const handle = createRef<CodeMirrorFileViewHandle>();
  const change = vi.fn();
  const props = {
    name: "file.txt",
    contents: "first\r\nsecond\r\n",
    version: 0,
    wordWrap: false,
    blame: false,
    handleRef: handle,
    onChange: change,
  };
  const mounted = render(<CodeMirrorFileView {...props} />);
  await waitFor(() => expect(handle.current?.getText()).toBe(props.contents));
  expect(change).not.toHaveBeenCalled();
  const view = EditorView.findFromDOM(mounted.container.querySelector(".cm-content")!)!;
  act(() => view.dispatch({ changes: { from: 0, to: 5, insert: "updated" } }));
  expect(change).toHaveBeenLastCalledWith("updated\r\nsecond\r\n");
  expect(handle.current?.getText()).toBe("updated\r\nsecond\r\n");
  mounted.rerender(
    <CodeMirrorFileView {...props} contents={"replacement\r\nbody\r\n"} version={1} />,
  );
  expect(handle.current?.getText()).toBe("replacement\r\nbody\r\n");
});
