import { Buffer } from "node:buffer";
import { writeFile } from "node:fs/promises";
import { expect, openScenario, test } from "./fixtures";

// A mocked canvas cannot catch WebKit refusing to rasterise foreignObject.
// Exercise the renderer and exporter in both browser engines; only file I/O
// and the native save dialog use the existing browser backend's fixtures.
test("exports a flowchart with its labels as a PNG", async ({ page }, testInfo) => {
  await openScenario(page, "chat-mermaid");
  // The development mock badge overlaps this footer button. Keyboard activation
  // exercises the same action without making the badge part of this journey.
  const askButton = page.getByRole("button", { name: "Ask about this session" });
  await askButton.focus();
  await askButton.press("Enter");
  const diagram = page.locator('svg[id^="atlas-mermaid-"]').first();
  await expect(diagram).toBeVisible();
  await expect(diagram).toContainText("artifacts_board");
  await expect(diagram.locator("foreignObject")).toHaveCount(0);
  await page.getByRole("button", { name: "Export as PNG" }).first().click();

  const written = await page.waitForFunction(() => {
    const call = window.__atlasMock
      ?.calls()
      .slice()
      .reverse()
      .find((entry) => entry.cmd === "write_file_base64");
    return call && typeof call.args?.contents === "string" ? call.args.contents : null;
  });
  const base64 = await written.jsonValue();
  if (typeof base64 !== "string") throw new Error("Export did not write PNG bytes");
  const png = Buffer.from(base64, "base64");
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(png.readUInt32BE(16)).toBeGreaterThan(100);
  expect(png.readUInt32BE(20)).toBeGreaterThan(20);
  const exportPath = testInfo.outputPath("exported-diagram.png");
  await writeFile(exportPath, png);
  await testInfo.attach("exported-diagram.png", { path: exportPath, contentType: "image/png" });
});
