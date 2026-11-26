import { expect, it } from "vitest";
import type { IBufferLine } from "@xterm/xterm";
import { textOffsetToColumn } from "./path-link-provider";
import { splitLinks } from "./linkify-paths";
import { formatDuration } from "./format-duration";
it("maps UTF-16 offsets to cells after a wide CJK character and a combining glyph", () => {
  const cells: [string, number][] = [
    ["界", 2],
    ["", 0],
    ["e\u0301", 1],
    [" ", 1],
    ["/", 1],
    ["a", 1],
  ];
  const line = {
    length: cells.length,
    getCell: (i: number) => ({ getChars: () => cells[i][0], getWidth: () => cells[i][1] }),
  } as IBufferLine;
  expect(textOffsetToColumn(line, 4)).toBe(4);
  expect(textOffsetToColumn(line, 6)).toBe(6);
});
it("recognizes Windows absolute and relative terminal paths without cutting the drive", () => {
  expect(
    splitLinks("at C:\\repo\\main.rs:12:3 and src\\main.rs")
      .filter((run) => run.kind === "path")
      .map((run) => run.text),
  ).toEqual(["C:\\repo\\main.rs:12:3", "src\\main.rs"]);
});
it("carries rounded seconds into minutes", () => {
  expect(formatDuration(59_900)).toBe("1m 0s");
  expect(formatDuration(119_900)).toBe("2m 0s");
});
