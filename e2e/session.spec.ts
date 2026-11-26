// Sessions: reopening one from the sidebar, reading what it says, and writing
// to the agent.
//
// Northwind, not the default scenario: its org has an AI grant, so the Atlas
// Agent's composer is live, and its history rows reopen with their recorded
// transcripts (the default scenario's local-only org locks that composer by
// design, and its rows resume without history).

import { composer, expect, openScenario, sidebar, test } from "./fixtures";

test("opens a session from the sidebar and reads its transcript", async ({ page }) => {
  await openScenario(page, "northwind");

  // `force`: the row's button is an empty layer under its content (see
  // `RowPressTarget`), so the title is what a pointer lands on, and its click
  // bubbles to the same handler. Playwright would wait forever for the button
  // to be the topmost element.
  await sidebar(page)
    .getByRole("button", { name: /^Move discount code validation to the server/ })
    .click({ force: true });

  await expect(
    // The switcher truncates a long title, so match its start.
    page.getByRole("button", { name: /^Session: Move discount code validation/ }),
  ).toBeVisible();
  // The prompt, then the agent's answer and what it changed.
  await expect(
    page
      .getByRole("paragraph")
      .filter({ hasText: /^Move discount code validation to the server: create/ }),
  ).toBeVisible();
  await expect(page.getByText("Discount codes are now checked on the server.")).toBeVisible();
  await expect(page.getByRole("tree", { name: "Changed files" })).toBeVisible();
});

test("types in the composer and sends to the agent", async ({ page }) => {
  await openScenario(page, "northwind");
  const send = page.getByRole("button", { name: "Send message" });

  await composer(page).click();
  await expect(send).toBeDisabled();
  await page.keyboard.type("Rename the retry helper");
  await expect(send).toBeEnabled();
  await page.keyboard.press("Enter");

  // The prompt lands in the transcript, the field clears, and the agent answers.
  await expect(
    page.getByRole("paragraph").filter({ hasText: /^Rename the retry helper$/ }),
  ).toBeVisible();
  await expect(composer(page)).toHaveText("");
  await expect(
    page.getByText(/Before I change anything for "Rename the retry helper"/),
  ).toBeVisible();
});

test("a transcript's markdown renders as structure", async ({ page }) => {
  await openScenario(page, "chat-markdown");

  // Tables, lists and fenced code reach the accessibility tree as such, not
  // as a flat run of text.
  await expect(page.getByRole("table").first()).toMatchAriaSnapshot(`
    - table:
      - rowgroup:
        - row "col value":
          - columnheader "col"
          - columnheader "value"
      - rowgroup:
        - row "a 1"
        - row "b 2"
  `);
  await expect(page.getByRole("button", { name: "Copy code" }).first()).toBeVisible();
});

test("a seeded scenario opens on its conversation and raises its scripted prompt", async ({
  page,
}) => {
  // The scenario's transcript is a stored session the mock opens in the first
  // chat tab (`boot-session.ts`), and its script then plays a live turn and a
  // permission request into that session. Neither appears when the tab has no
  // session, which is the state the app itself boots a chat in.
  await openScenario(page, "chat-tools");

  await expect(
    page
      .getByRole("paragraph")
      .filter({ hasText: /^Add a disabled state to the Button component/ }),
  ).toBeVisible();
  await expect(page.getByTestId("permission-card")).toBeVisible({ timeout: 30_000 });
});

test("a new chat starts no agent session until the user writes", async ({ page }) => {
  await openScenario(page, "northwind");
  const started = () =>
    page.evaluate(
      () =>
        (window as unknown as { __atlasMock: { calls: () => { cmd: string }[] } }).__atlasMock
          .calls()
          .filter((call) => call.cmd === "agents_new_session").length,
    );

  await page.getByRole("button", { name: /Switch session/ }).click();
  await page.getByRole("menu").getByRole("button", { name: "New session", exact: true }).click();
  await expect(composer(page)).toBeFocused();
  await expect(composer(page)).toHaveText("");
  // Shown and focused is not asked for: an agent that keeps every session it
  // opens would list one empty session per launch.
  await page.waitForTimeout(1_500);
  expect(await started()).toBe(0);

  await page.keyboard.type("h");
  await expect.poll(started).toBe(1);
});
