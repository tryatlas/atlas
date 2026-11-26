// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileTreeConfirmDelete } from "./file-tree-confirm-delete";

afterEach(cleanup);

it("Enter activates Cancel without confirming deletion", async () => {
  const onConfirm = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <FileTreeConfirmDelete
      open
      name="notes"
      isDir
      onConfirm={onConfirm}
      onOpenChange={onOpenChange}
    />,
  );
  screen.getByRole("button", { name: "Cancel" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(onConfirm).not.toHaveBeenCalled();
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("confirms once when the destructive button is deliberately activated", async () => {
  const onConfirm = vi.fn();
  render(
    <FileTreeConfirmDelete open name="notes" isDir onConfirm={onConfirm} onOpenChange={vi.fn()} />,
  );
  screen.getByRole("button", { name: "Delete" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

it("composition confirmation never deletes", () => {
  const onConfirm = vi.fn();
  render(
    <FileTreeConfirmDelete open name="notes" isDir onConfirm={onConfirm} onOpenChange={vi.fn()} />,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Delete" }), {
    key: "Enter",
    isComposing: true,
  });
  expect(onConfirm).not.toHaveBeenCalled();
});
