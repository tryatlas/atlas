// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FileFindBar } from "./file-find-bar";

afterEach(cleanup);

it("finds and navigates case-insensitively after a length-changing case fold", async () => {
  const onGo = vi.fn();
  render(
    <FileFindBar
      getText={() => "İstanbul\nNEEDLE\nneedle\n[A.B]"}
      startLine={() => 1}
      onGo={onGo}
      onClose={vi.fn()}
      focusRequest={0}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Find in file" });
  fireEvent.change(input, { target: { value: "needle" } });
  await waitFor(() => expect(screen.getByText("1 of 2")).toBeDefined());
  expect(onGo).toHaveBeenLastCalledWith({ line: 2, column: 1, endColumn: 7 });

  fireEvent.click(screen.getByRole("button", { name: /^Next match/ }));
  expect(onGo).toHaveBeenLastCalledWith({ line: 3, column: 1, endColumn: 7 });

  const matchCase = screen.getByRole("button", { name: "Match case" });
  fireEvent.click(matchCase);
  await waitFor(() => expect(screen.getByText("1 of 1")).toBeDefined());
  expect(onGo).toHaveBeenLastCalledWith({ line: 3, column: 1, endColumn: 7 });

  fireEvent.click(matchCase);
  fireEvent.change(input, { target: { value: "[a.b]" } });
  await waitFor(() => expect(onGo).toHaveBeenLastCalledWith({ line: 4, column: 1, endColumn: 6 }));
  expect(screen.getByText("1 of 1")).toBeDefined();
});
