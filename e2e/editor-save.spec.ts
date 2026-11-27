import { expect, mod, openScenario, test } from "./fixtures";

test("keeps edits made during a save through external changes and a follow-up save", async ({
  page,
}) => {
  await openScenario(page, "ask-files");
  await page.getByRole("button", { name: /^Edit file/ }).click();
  const editor = page.locator("[data-file-view] .cm-content");
  const save = `${await mod(page)}+s`;
  await editor.fill("first edit");
  await page.evaluate(() => window.__atlasMock?.actions.holdNextSave());
  await editor.press(save);
  await expect
    .poll(() => page.evaluate(() => window.__atlasMock?.actions.saveState()))
    .toBe("pending");

  await editor.fill("newer unsaved edit");
  await page.evaluate(() => window.__atlasMock?.actions.releaseSave());
  await expect
    .poll(() => page.evaluate(() => window.__atlasMock?.actions.savedText()))
    .toBe("first edit");
  await page.evaluate(() => window.__atlasMock?.actions.externalEdit());

  const changed = page.getByRole("button", { name: "Disk changed · Reload" });
  await expect(changed).toBeVisible();
  await expect(editor).toContainText("newer unsaved edit");
  await expect(editor).not.toContainText("external edit");

  await editor.press(save);
  await expect
    .poll(() => page.evaluate(() => window.__atlasMock?.actions.savedText()))
    .toBe("newer unsaved edit");
  await expect(changed).not.toBeVisible();
  // Nothing changed during this save: a later disk edit can reload normally.
  await page.evaluate(() => window.__atlasMock?.actions.externalEdit());
  await expect(editor).toContainText("external edit");
  await expect(changed).not.toBeVisible();
});

test("keeps the document unsaved when saving fails", async ({ page }) => {
  await openScenario(page, "ask-files");
  await page.getByRole("button", { name: /^Edit file/ }).click();
  const editor = page.locator("[data-file-view] .cm-content");
  await editor.fill("unsaved after a failed write");
  await page.evaluate(() => window.__atlasMock?.actions.failSaves());
  await editor.press(`${await mod(page)}+s`);
  await expect(page.getByText("Couldn't save api.ts", { exact: true })).toBeVisible();
  await page.evaluate(() => window.__atlasMock?.actions.externalEdit());
  await expect(page.getByRole("button", { name: "Disk changed · Reload" })).toBeVisible();
  await expect(editor).toContainText("unsaved after a failed write");
  await expect(editor).not.toContainText("external edit");
});
