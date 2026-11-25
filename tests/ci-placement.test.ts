import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { linuxMode, placement, type PlacedJob } from "../scripts/ci-placement.mjs";

/**
 * Guards `scripts/ci-placement.mjs`, which decides where `bun run ci:local`
 * runs each job: this machine, the Linux container, or nowhere.
 *
 * It used to decide from whether `docker info` answered. The same command on
 * the same branch then ran the sandbox crate in a container on one day and on
 * the Mac the next, depending on whether an unrelated app was open, and the
 * container's images and volumes piled up (19 GB on one machine) on machines
 * whose owners never chose it. Nothing failed; the cost showed up only as
 * disk space and as runs that tested different things.
 *
 * So this suite pins the contract: placement is a function of the job, the
 * host OS and the Linux mode alone; the mode comes from a flag, then
 * ATLAS_CI_LINUX, then the default `native`; and ci-local never consults a
 * runtime before placing jobs.
 */

const sandboxCrate: PlacedJob = {
  id: "crates",
  os: "linux",
  flags: { sandbox: true },
};
const plainCrate: PlacedJob = { id: "crates", os: "linux", flags: {} };
const appLinux: PlacedJob = { id: "app-linux", os: "linux" };
const appWindows: PlacedJob = { id: "app-windows", os: "windows" };
const appMac: PlacedJob = { id: "app", os: "macos" };
const engine: PlacedJob = { id: "engine-dialect", os: "linux" };

describe("linuxMode", () => {
  it("defaults to native", () => {
    expect(linuxMode([], {})).toEqual({ mode: "native", source: "the default" });
  });

  it("reads ATLAS_CI_LINUX when no flag is given", () => {
    expect(linuxMode([], { ATLAS_CI_LINUX: "needed" }).mode).toBe("needed");
    expect(linuxMode([], { ATLAS_CI_LINUX: "all" }).mode).toBe("all");
  });

  it("lets a flag override ATLAS_CI_LINUX", () => {
    expect(linuxMode(["--native"], { ATLAS_CI_LINUX: "all" }).mode).toBe("native");
    expect(linuxMode(["--linux"], { ATLAS_CI_LINUX: "native" }).mode).toBe("all");
  });

  it("treats an empty ATLAS_CI_LINUX as unset", () => {
    expect(linuxMode([], { ATLAS_CI_LINUX: "" }).mode).toBe("native");
  });

  it("refuses an unknown value and contradictory flags", () => {
    expect(() => linuxMode([], { ATLAS_CI_LINUX: "auto" })).toThrow(/not one of/);
    expect(() => linuxMode(["--linux", "--native"], {})).toThrow(/contradict/);
  });
});

describe("placement on a Mac", () => {
  it("native: every Linux job runs here, the OS-bound ones are skipped", () => {
    expect(placement(sandboxCrate, "macos", "native")).toBe("native");
    expect(placement(engine, "macos", "native")).toBe("native");
    expect(placement(plainCrate, "macos", "native")).toBe("native");
    expect(placement(appLinux, "macos", "native")).toBe("skip");
    expect(placement(appWindows, "macos", "native")).toBe("skip");
    expect(placement(appMac, "macos", "native")).toBe("native");
  });

  it("needed: only the jobs Linux alone can judge go to the container", () => {
    expect(placement(sandboxCrate, "macos", "needed")).toBe("container");
    expect(placement(engine, "macos", "needed")).toBe("container");
    expect(placement(appLinux, "macos", "needed")).toBe("container");
    expect(placement(plainCrate, "macos", "needed")).toBe("native");
    expect(placement(appMac, "macos", "needed")).toBe("native");
  });

  it("all: every Linux job goes to the container", () => {
    expect(placement(plainCrate, "macos", "all")).toBe("container");
    expect(placement(sandboxCrate, "macos", "all")).toBe("container");
    expect(placement(appWindows, "macos", "all")).toBe("skip");
  });
});

describe("placement on Linux", () => {
  it("runs Linux jobs here unless every one is asked for in the container", () => {
    expect(placement(sandboxCrate, "linux", "needed")).toBe("native");
    expect(placement(engine, "linux", "needed")).toBe("native");
    expect(placement(appLinux, "linux", "native")).toBe("native");
    expect(placement(plainCrate, "linux", "all")).toBe("container");
    expect(placement(appMac, "linux", "native")).toBe("skip");
  });
});

describe("ci-local.mjs", () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "ci-local.mjs"),
    "utf8",
  );
  const main = source.slice(source.indexOf("async function main("));
  const placed = main.indexOf("placement(j, HOST_OS, mode)");

  it("places jobs with ci-placement's function, before any runtime is asked", () => {
    expect(placed).toBeGreaterThan(0);
    const beforePlacement = main.slice(0, placed);
    expect(beforePlacement).not.toMatch(/runtimeInfo\(|containerContext\(`/);
  });
});
