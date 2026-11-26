import { describe, expect, it } from "vitest";
import { compactAge } from "./session-row-status";

const NOW = Date.parse("2026-06-15T12:00:00.000Z");

describe("compactAge", () => {
  it("counts an ordinary age", () => {
    expect(compactAge("2026-06-15T09:00:00.000Z", NOW)).toBe("3h");
  });

  it("shows nothing for the epoch, which an import stamps on a row of unknown age", () => {
    expect(compactAge("1970-01-01T00:00:00.000Z", NOW)).toBeNull();
  });
});
