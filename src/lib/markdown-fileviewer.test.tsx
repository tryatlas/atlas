// @vitest-environment happy-dom
//
// The trusted preview loads its images through Rust: the CSP refuses remote
// ones and relative ones resolve against the app, not the document. These
// pin which images take that path and what an unloadable one leaves behind.

import { afterEach, describe, expect, it, vi } from "vitest";

const invoke = vi.hoisted(() =>
  vi.fn(async (_cmd: string, args: { src: string }) => {
    if (args.src.includes("missing")) throw new Error("404");
    return `data:image/png;base64,${btoa(args.src)}`;
  }),
);
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { cleanup, render, waitFor } from "@testing-library/react";
import { MarkdownFile } from "./markdown-fileviewer";

afterEach(() => {
  cleanup();
  invoke.mockClear();
});

const DOC = "/repo/docs/README.md";
const srcs = (root: HTMLElement) =>
  [...root.querySelectorAll("img")].map((i) => i.getAttribute("src"));

describe("markdown preview images", () => {
  it("loads remote and relative images, raw HTML included, through Rust", async () => {
    const md = [
      "![badge](https://img.shields.io/badge/a-b-blue)",
      "",
      '<img src="shot.png" alt="Shot" width="900" />',
    ].join("\n");
    const { container } = render(
      <MarkdownFile trusted docPath={DOC}>
        {md}
      </MarkdownFile>,
    );

    await waitFor(() =>
      expect(srcs(container)).toEqual([
        `data:image/png;base64,${btoa("https://img.shields.io/badge/a-b-blue")}`,
        `data:image/png;base64,${btoa("shot.png")}`,
      ]),
    );
    expect(invoke).toHaveBeenCalledWith("markdown_preview_image", {
      docPath: DOC,
      src: "shot.png",
    });
    // The raw-HTML size survives, so the layout holds while it loads.
    expect(container.querySelectorAll("img")[1].getAttribute("width")).toBe("900");
  });

  it("leaves an untrusted document's images to the webview", () => {
    const { container } = render(<MarkdownFile>{"![r](https://example.com/x.png)"}</MarkdownFile>);

    expect(srcs(container)).toEqual(["https://example.com/x.png"]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("shows the alt text for an image it cannot load", async () => {
    const { container, findByText } = render(
      <MarkdownFile trusted docPath={DOC}>
        {"![Architecture diagram](missing.png)"}
      </MarkdownFile>,
    );

    await findByText("Architecture diagram");
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("markdown preview raw HTML", () => {
  it("drops the tags and attributes a hostile README could take over the window with", () => {
    const md = [
      '<meta http-equiv="refresh" content="0;url=https://evil.example">',
      "",
      "<style>body { display: none }</style>",
      "",
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      "",
      '<div style="position:fixed;inset:0;z-index:99999">overlay</div>',
      "",
      '<link rel="stylesheet" href="https://evil.example/x.css"><base href="https://evil.example/">',
      "",
      '<form action="https://evil.example"><input name="q"></form>',
      "",
      '<object data="x.swf"></object><embed src="x.swf">',
      "",
      "<details><summary>More</summary>kept</details>",
    ].join("\n");
    const { container } = render(
      <MarkdownFile trusted docPath={DOC}>
        {md}
      </MarkdownFile>,
    );

    for (const tag of ["meta", "style", "iframe", "link", "base", "form", "object", "embed"]) {
      expect(container.querySelector(tag), tag).toBeNull();
    }
    // React 19 hoists <meta>/<link>/<style> into <head>; none may get there.
    expect(document.head.querySelector("meta[http-equiv]")).toBeNull();
    expect(document.head.querySelector('link[href*="evil"], base, style')).toBeNull();
    expect(container.querySelector("[style]")).toBeNull();
    // The overlay's text survives as an ordinary, unstyled block.
    expect(container.textContent).toContain("overlay");
    // GitHub's harmless raw HTML still renders.
    expect(container.querySelector("details summary")?.textContent).toBe("More");
  });
});

describe("markdown preview tables", () => {
  const TABLE = [
    "| # | Setting | What it does |",
    "| -: | :-: | --- |",
    "| 1 | `wordWrap` | Wraps long lines in the editor and the diff viewer instead of scrolling them sideways. |",
  ].join("\n");

  for (const trusted of [true, false]) {
    it(`keeps prose columns readable and lets them wrap (${trusted ? "trusted" : "untrusted"})`, () => {
      const { container } = render(
        <MarkdownFile trusted={trusted} docPath={DOC}>
          {TABLE}
        </MarkdownFile>,
      );
      const cells = [...container.querySelectorAll("th, td")];
      const floored = cells.map((c) => c.classList.contains("min-w-[24ch]"));

      // Only the prose cell holds its column to a readable measure.
      expect(floored).toEqual([false, false, false, false, false, true]);
      // Nothing is held to one line, and the table is not sized to its
      // max-content width: a long cell wraps.
      for (const el of [container.querySelector("table")!, ...cells]) {
        expect(el.className).not.toMatch(/whitespace-nowrap|min-w-max|w-max/);
      }
      // A table wider than the document scrolls in its own box.
      expect(container.querySelector("table")!.parentElement!.className).toContain(
        "overflow-x-auto",
      );
      // GFM column alignment survives.
      expect((cells[3] as HTMLElement).style.textAlign).toBe("right");
      expect((cells[1] as HTMLElement).style.textAlign).toBe("center");
    });
  }

  it("puts the host's class on the document's root", () => {
    const { container } = render(<MarkdownFile className="mx-auto max-w-4xl">{"Hi"}</MarkdownFile>);

    expect(container.firstElementChild!.className).toContain("max-w-4xl");
  });
});
