import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCrateMatrix } from "../scripts/ci-affected.mjs";
import { WINDOWS_TARGET, crateSteps } from "../scripts/ci-crates.mjs";

/**
 * Keeps `.github/workflows/ci.yml` bound to what is actually in the repo.
 *
 * Each crate is a standalone package, so CI names them one by one
 * (`.github/ci-crates.json`, which the `changes` job filters and groups into
 * the `crates` job's matrix, and scripts/ci-crates.mjs checks each). That list is hand-maintained, which means a PR
 * adding a crate gets a green check while its tests never run — the exact
 * failure that left 393 of this repo's tests (48%) unexecuted before this
 * suite existed. Nothing else notices, because a job that was never
 * scheduled cannot go red.
 *
 * The workflow is parsed with a line regex rather than a YAML dependency: the file is small,
 * it is ours, and the count assertions below make a silently-unmatching regex
 * fail loudly instead of passing vacuously.
 *
 * The second half pins two shapes in the Rust jobs that fail slowly or
 * silently rather than loudly: the per-crate clippy pass, which
 * scripts/ci-crates.mjs builds (one, never two —
 * a second pass with different arguments re-lints the whole ported engine
 * for nothing) and the sccache wiring (a `RUSTC_WRAPPER` with no sccache on
 * PATH fails every cargo call; incremental compilation on makes every sccache
 * lookup a miss without an error) and the cache budget (an entry saved from a
 * ref nothing restores from only evicts entries that something does). The
 * last describe holds release-linux.yml to the same sccache wiring.
 *
 * Between them sit the cross-OS checks: the Windows clippy step for crates
 * flagged `cross`, and the `--target`s it and `ci:local` name, each of which
 * must be in rust-toolchain.toml's `targets` or it fails on "can't find crate
 * for `core`" on a machine that installed the toolchain without it. And the
 * `ci-ok` gate must wait on every job: one missing from its `needs` can go
 * red while the required check stays green.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CRATES_DIR = path.join(REPO_ROOT, "crates");
const WORKFLOW = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");
const RELEASE_LINUX = path.join(REPO_ROOT, ".github", "workflows", "release-linux.yml");

/** Crate directories that are real Cargo packages. */
function cratesOnDisk(): string[] {
  return readdirSync(CRATES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(CRATES_DIR, e.name, "Cargo.toml")))
    .map((e) => e.name)
    .sort();
}

/** The workflow's jobs, keyed by job id, each as its raw text block. */
function jobBlocks(workflow = WORKFLOW): Map<string, string> {
  const src = readFileSync(workflow, "utf8");
  const body = src.slice(src.search(/^jobs:\s*$/m));
  const blocks = new Map<string, string>();
  const heads = [...body.matchAll(/^ {2}([a-z][a-z0-9_-]*):\s*$/gm)];
  heads.forEach((m, i) => {
    const end = i + 1 < heads.length ? heads[i + 1].index : body.length;
    blocks.set(m[1], body.slice(m.index, end));
  });
  return blocks;
}

interface Step {
  uses?: string;
  if?: string;
  run?: string;
}

/** A job's steps, as their `uses:` / `if:` / `run:` values. */
function stepsOf(job: string): Step[] {
  const steps = job.slice(job.search(/^ {4}steps:\s*$/m));
  return steps
    .split(/^ {6}- /m)
    .slice(1)
    .map((chunk) => {
      // A step's first key sits on its `- ` line, the rest at 8 spaces.
      const text = " ".repeat(8) + chunk;
      const key = (k: string) => text.match(new RegExp(`^ {8}${k}:[ \\t]*(.*)$`, "m"))?.[1].trim();
      const run = key("run");
      return {
        uses: key("uses"),
        if: key("if"),
        // A block scalar (`|`, `>-`) puts the command on the lines below.
        run: run && /^[|>]/.test(run) ? text.slice(text.search(/^ {8}run:/m)) : run,
      };
    });
}

/** Crate names listed in the CI matrix. */
function cratesInWorkflow(): string[] {
  return readCrateMatrix(REPO_ROOT)
    .map((c) => c.crate)
    .sort();
}

describe("CI covers the repository", () => {
  const onDisk = cratesOnDisk();
  const inWorkflow = cratesInWorkflow();

  it("finds crates on disk", () => {
    // Floor guard: if this returns nothing, the comparison below would pass
    // against an empty set and guard nothing.
    expect(onDisk.length).toBeGreaterThan(10);
  });

  it("parses crate entries out of the workflow", () => {
    expect(inWorkflow.length).toBeGreaterThan(10);
  });

  it("runs the tests of every crate in the repository", () => {
    const uncovered = onDisk.filter((c) => !inWorkflow.includes(c));
    // Add the crate to .github/ci-crates.json.
    expect(uncovered).toEqual([]);
  });

  it("does not name a crate that no longer exists", () => {
    // A stale entry fails the job with a confusing "no such directory" rather
    // than pointing at the rename that caused it.
    const phantom = inWorkflow.filter((c) => !onDisk.includes(c));
    expect(phantom).toEqual([]);
  });

  it("lists each crate exactly once", () => {
    const duplicates = inWorkflow.filter((c, i) => inWorkflow.indexOf(c) !== i);
    expect([...new Set(duplicates)]).toEqual([]);
  });
});

describe("CI's Rust jobs", () => {
  const jobs = jobBlocks();
  const src = readFileSync(WORKFLOW, "utf8");

  it("finds the jobs", () => {
    expect([...jobs.keys()]).toEqual(
      expect.arrayContaining(["frontend", "app", "app-linux", "app-windows", "crates"]),
    );
  });

  it("hands each planned group's crates to scripts/ci-crates.mjs", () => {
    const steps = stepsOf(jobs.get("crates")!);
    // The cargo commands live in the script, never in the job: a second
    // copy here would drift from what ci:local runs.
    expect(steps.filter((s) => s.run?.includes("cargo ")).map((s) => s.run)).toEqual([]);
    const block = jobs.get("crates")!;
    expect(block).toMatch(/^ {10}CI_CRATES: \$\{\{ join\(matrix\.crates, ' '\) \}\}$/m);
    expect(steps.map((s) => s.run)).toContain("node scripts/ci-crates.mjs");
  });

  it("runs exactly one clippy pass per crate for the host", () => {
    // For the host OS; the cross-OS pass below is a different target. Two
    // complementary argument sets: `-D warnings` for the crates flagged
    // `clippy: true`, the plain workspace-lint-table pass for the rest. A
    // second pass for a flagged crate re-lints every workspace member.
    for (const entry of readCrateMatrix(REPO_ROOT)) {
      const host = crateSteps(entry).filter(
        (s) => s.args[0] === "clippy" && !s.args.includes("--target"),
      );
      expect({ crate: entry.crate, passes: host.length }).toEqual({
        crate: entry.crate,
        passes: 1,
      });
      expect({ crate: entry.crate, strict: host[0].args.includes("warnings") }).toEqual({
        crate: entry.crate,
        strict: Boolean(entry.clippy),
      });
    }
  });

  it("clippies the crates flagged `cross` for Windows, once, and no others", () => {
    for (const entry of readCrateMatrix(REPO_ROOT)) {
      const windows = crateSteps(entry).filter((s) => s.args.includes(WINDOWS_TARGET));
      expect({ crate: entry.crate, passes: windows.length }).toEqual({
        crate: entry.crate,
        passes: entry.cross ? 1 : 0,
      });
    }
    // The flag means "no C in the tree", which only the probe that set it
    // could establish; this guards the flag's existence, not its accuracy.
    expect(readCrateMatrix(REPO_ROOT).some((c) => c.cross)).toBe(true);
  });

  it("tests every crate, and builds the release profile only where flagged", () => {
    for (const entry of readCrateMatrix(REPO_ROOT)) {
      const args = crateSteps(entry).map((s) => s.args.slice(0, 2).join(" "));
      expect(args[0]).toBe("test --locked");
      expect(args.includes("build --locked")).toBe(Boolean(entry["release-build"]));
    }
  });

  it("adds ci:local's Linux-target pass only for `cross` crates", () => {
    const extraTarget = "aarch64-unknown-linux-gnu";
    for (const entry of readCrateMatrix(REPO_ROOT)) {
      const linux = crateSteps(entry, { extraTarget }).filter((s) => s.args.includes(extraTarget));
      expect(linux.length).toBe(entry.cross ? 1 : 0);
    }
  });

  it("declares in rust-toolchain.toml every target CI and ci:local compile for", () => {
    const toolchain = readFileSync(path.join(REPO_ROOT, "rust-toolchain.toml"), "utf8");
    const declared = [
      ...(/^targets\s*=\s*\[([^\]]*)\]/m.exec(toolchain)?.[1] ?? "").matchAll(/"([^"]+)"/g),
    ].map((m) => m[1]);
    const ciLocal = readFileSync(path.join(REPO_ROOT, "scripts", "ci-local.mjs"), "utf8");
    const used = new Set([
      ...[
        ...src.matchAll(/--target ([a-z0-9_-]+)/g),
        ...ciLocal.matchAll(/"(aarch64-unknown-linux-gnu)"/g),
      ].map((m) => m[1]),
      WINDOWS_TARGET,
    ]);
    expect(used.size).toBeGreaterThan(1);
    expect([...used].filter((t) => !declared.includes(t))).toEqual([]);
  });

  it("makes the required `ci-ok` check wait on every other job", () => {
    const needs = /^ {4}needs: \[([^\]]*)\]/m.exec(jobs.get("ci-ok")!)?.[1].split(/,\s*/) ?? [];
    expect(needs.sort()).toEqual([...jobs.keys()].filter((j) => j !== "ci-ok").sort());
  });

  it("installs sccache in every job that routes rustc through it, before any cargo runs", () => {
    const wrapped = [...jobs].filter(([, block]) => /^\s*RUSTC_WRAPPER:\s*sccache\b/m.test(block));
    // Floor guard: the app, engine dialect and per-crate jobs.
    expect(wrapped.map(([id]) => id)).toEqual(
      expect.arrayContaining(["app", "app-linux", "engine-dialect", "crates"]),
    );
    for (const [id, block] of wrapped) {
      const steps = stepsOf(block);
      const sccache = steps.findIndex((s) => s.uses?.startsWith("mozilla-actions/sccache-action@"));
      const firstCargo = steps.findIndex(
        (s) => s.uses?.startsWith("Swatinem/rust-cache@") || s.run?.includes("cargo "),
      );
      expect({ id, sccache: sccache >= 0 }).toEqual({ id, sccache: true });
      expect({ id, beforeCargo: sccache < firstCargo }).toEqual({ id, beforeCargo: true });
    }
  });

  it("never sets RUSTC_WRAPPER workflow-wide", () => {
    // The frontend job has no sccache; a global wrapper would break any cargo
    // call added there.
    const header = src.slice(0, src.search(/^jobs:\s*$/m));
    expect(header).not.toMatch(/^\s*RUSTC_WRAPPER:/m);
  });

  it("keeps scripts/test-rust.sh testing the same engine crates as the engine dialect job", () => {
    // `bun run test:rust` is the local subset of CI; its engine `-p` list is
    // a copy of the job's, and a copy drifts unless something compares them.
    const packages = (text: string) =>
      [...text.matchAll(/-p (atlas-engine-[a-z0-9-]+)/g)].map((m) => m[1]).sort();
    const job = stepsOf(jobs.get("engine-dialect")!)
      .map((s) => s.run ?? "")
      .join("\n");
    const script = readFileSync(path.join(REPO_ROOT, "scripts", "test-rust.sh"), "utf8");
    expect(packages(job)).toContain("atlas-engine-api");
    expect(packages(job)).toEqual(
      expect.arrayContaining([
        "atlas-engine-app-server",
        "atlas-engine-backend-client",
        "atlas-engine-core",
        "atlas-engine-exec-server",
        "atlas-engine-hooks",
        "atlas-engine-linux-sandbox",
        "atlas-engine-rmcp-client",
        "atlas-engine-skills-extension",
      ]),
    );
    expect(packages(script)).toEqual(packages(job));
  });

  it("keeps incremental compilation off, which sccache requires", () => {
    expect(src).toMatch(/^ {2}CARGO_INCREMENTAL:\s*0\s*$/m);
  });

  it("writes caches only where the `changes` job's cache-write allows", () => {
    // A manual run can be on any branch, and what it saves is scoped to that
    // branch: no pull request restores it, yet it evicts what they do.
    const header = src.slice(0, src.search(/^jobs:\s*$/m));
    expect(header).not.toMatch(/^\s*SCCACHE_GHA_RW_MODE:/m);
    expect(jobs.get("changes")).toMatch(
      /^ {6}cache-write: \$\{\{ steps\.cache\.outputs\.write \}\}$/m,
    );
    const rustJobs = [...jobs].filter(([, block]) => /Swatinem\/rust-cache@/.test(block));
    expect(rustJobs.length).toBeGreaterThanOrEqual(4);
    for (const [id, block] of rustJobs) {
      const saveIf = block.match(/^\s*save-if:\s*(.*)$/m)?.[1];
      expect({ id, saveIf }).toEqual({
        id,
        saveIf: "${{ needs.changes.outputs.cache-write == 'true' }}",
      });
      const rwMode = block.match(/^\s*SCCACHE_GHA_RW_MODE:\s*(.*)$/m)?.[1];
      expect({ id, rwMode }).toEqual({
        id,
        rwMode: "${{ needs.changes.outputs.cache-write == 'true' && 'READ_WRITE' || 'READ_ONLY' }}",
      });
    }
  });
});

describe("release-linux's Rust build", () => {
  const src = readFileSync(RELEASE_LINUX, "utf8");
  const header = src.slice(0, src.search(/^jobs:\s*$/m));
  const jobs = [...jobBlocks(RELEASE_LINUX)];

  it("runs cargo in one job only, which makes a workflow-wide RUSTC_WRAPPER safe", () => {
    // ci.yml forbids it workflow-wide; here it is fine only while the one job
    // that runs cargo installs sccache first (below). The publish job, which
    // assembles both architectures' packages, must never run cargo: it has no
    // sccache, and RUSTC_WRAPPER would fail its first cargo call.
    expect(header).toMatch(/^ {2}RUSTC_WRAPPER:\s*sccache\s*$/m);
    expect(jobs.map(([id]) => id)).toEqual(["build-linux", "publish"]);
    const runsCargo = (s: Step) =>
      Boolean(s.uses?.startsWith("Swatinem/rust-cache@")) || /\bcargo |build:app/.test(s.run ?? "");
    expect(stepsOf(jobs[1][1]).some(runsCargo)).toBe(false);
  });

  it("installs sccache before anything runs cargo", () => {
    const steps = stepsOf(jobs[0][1]);
    const sccache = steps.findIndex((s) => s.uses?.startsWith("mozilla-actions/sccache-action@"));
    const firstCargo = steps.findIndex(
      (s) => s.uses?.startsWith("Swatinem/rust-cache@") || /\bcargo |build:app/.test(s.run ?? ""),
    );
    expect(sccache).toBeGreaterThanOrEqual(0);
    expect(firstCargo).toBeGreaterThan(sccache);
  });

  it("keeps incremental compilation off, which sccache requires", () => {
    expect(header).toMatch(/^ {2}CARGO_INCREMENTAL:\s*0\s*$/m);
  });

  it("writes caches only from a manual run on the default branch", () => {
    // A release is a tag push, and no later release can restore a tag's
    // entries; the default branch's are what a tag run reads.
    const rwMode = header.match(/^ {2}SCCACHE_GHA_RW_MODE:\s*(.*)$/m)?.[1] ?? "";
    expect(rwMode).toContain("github.event_name == 'workflow_dispatch'");
    expect(rwMode).toContain("github.event.repository.default_branch");
    expect(jobs[0][1]).toMatch(
      /^\s*save-if: \$\{\{ env\.SCCACHE_GHA_RW_MODE == 'READ_WRITE' \}\}$/m,
    );
  });
});
