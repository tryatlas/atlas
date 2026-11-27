#!/usr/bin/env node
/**
 * Tests and lints crates the way CI's `crates` job does, one crate at a time.
 *
 *   node scripts/ci-crates.mjs atlas-git atlas-fs   these crates
 *   CI_CRATES="atlas-git atlas-fs" node scripts/ci-crates.mjs   the same, as CI passes them
 *
 * CI runs a few grouped jobs rather than one job per crate: a crate's tests
 * take about half a minute, and its job's checkout, toolchain and cache
 * restores used to take longer than that, 32 times over. Each crate is still
 * built and checked on its own, from its own directory, so cargo never
 * unifies features across crates: a crate that forgot a feature in its own
 * manifest fails here exactly as it would for anyone depending on it alone.
 * The crates of a group share the job's target directory, so a dependency two
 * of them use is compiled once.
 *
 * What runs for a crate comes from its flags in `.github/ci-crates.json`
 * (`crateSteps` below has each rule). Every crate runs even after one fails,
 * so a run reports all of them; the exit status is non-zero if any failed.
 *
 * `scripts/ci-local.mjs` calls this once per crate. When it runs a Linux job
 * on another OS it sets CI_EXTRA_CLIPPY_TARGET to CI's Linux triple, and
 * crates flagged `cross` are linted for that target too (see its docblock).
 *
 * Plain Node, no dependencies: CI's Rust jobs run it with the runner's Node.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, readCrateMatrix } from "./ci-affected.mjs";

/** The Windows triple crates flagged `cross` are linted for. */
export const WINDOWS_TARGET = "aarch64-pc-windows-msvc";

/**
 * The commands CI runs for one crate, in order, each `{ name, args }` for
 * `cargo`, run from `crates/<crate>`.
 */
export function crateSteps(entry, { extraTarget } = {}) {
  const steps = [{ name: "test", args: ["test", "--locked"] }];
  // atlas-kb-server is never shipped as a binary: `knowledge_export` compiles
  // it on the user's machine with its own release profile (`panic = "abort"`,
  // thin LTO, strip), which nothing else here exercises.
  if (entry["release-build"]) {
    steps.push({ name: "release build", args: ["build", "--locked", "--release"] });
  }
  // Exactly one clippy pass per target, never two: every member gets the
  // workspace lint table (`[lints] workspace = true`), whose entries are
  // denies of their own, and `clippy: true` crates get `-D warnings` on top,
  // a strict superset. A second argument set would re-lint every workspace
  // member it reaches (for atlas-native-agent, the whole ported engine).
  const lint = (target) => [
    "clippy",
    "--locked",
    "--all-targets",
    ...(target ? ["--target", target] : []),
    ...(entry.clippy && !target ? ["--", "-D", "warnings"] : []),
  ];
  steps.push({ name: entry.clippy ? "clippy (-D warnings)" : "clippy", args: lint() });
  // `cross` marks the crates whose dependency tree builds no C, so they can be
  // linted for another OS with no SDK for it: clippy emits metadata only and
  // the target's standard library comes from rust-toolchain.toml. The other
  // crates' Windows arms are checked as part of the app (`app-windows`).
  if (entry.cross) {
    steps.push({ name: `clippy (${WINDOWS_TARGET})`, args: lint(WINDOWS_TARGET) });
    if (extraTarget) steps.push({ name: `clippy (${extraTarget})`, args: lint(extraTarget) });
  }
  return steps;
}

/** The entries for `names`, in matrix order; throws on an unknown name. */
export function selectCrates(names, matrix) {
  const unknown = names.filter((n) => !matrix.some((e) => e.crate === n));
  if (unknown.length) {
    throw new Error(`not in .github/ci-crates.json: ${unknown.join(", ")}`);
  }
  return matrix.filter((e) => names.includes(e.crate));
}

function main(argv) {
  const names = argv.length ? argv : (process.env.CI_CRATES ?? "").split(/\s+/).filter(Boolean);
  if (!names.length) {
    console.error("ci-crates: name the crates to check, as arguments or in CI_CRATES");
    process.exit(2);
  }
  const entries = selectCrates(names, readCrateMatrix());
  const github = Boolean(process.env.GITHUB_ACTIONS);
  const extraTarget = process.env.CI_EXTRA_CLIPPY_TARGET || undefined;
  const results = [];

  for (const entry of entries) {
    const cwd = path.join(REPO_ROOT, "crates", entry.crate);
    const started = Date.now();
    let failed = null;
    if (github) console.log(`::group::${entry.crate}`);
    for (const step of crateSteps(entry, { extraTarget })) {
      console.log(`\n── ${entry.crate} › ${step.name}\n   cargo ${step.args.join(" ")}`);
      const { status } = spawnSync("cargo", step.args, { cwd, stdio: "inherit" });
      if (status !== 0) {
        failed = step.name;
        break;
      }
    }
    if (github) console.log("::endgroup::");
    if (failed && github) {
      console.log(`::error title=${entry.crate} failed::${entry.crate}: ${failed} failed`);
    }
    results.push({ crate: entry.crate, failed, secs: Math.round((Date.now() - started) / 1000) });
  }

  const table = [
    "| crate | result | time |",
    "| --- | --- | --- |",
    ...results.map(
      (r) => `| ${r.crate} | ${r.failed ? `failed: ${r.failed}` : "ok"} | ${r.secs}s |`,
    ),
    "",
  ].join("\n");
  console.log(`\n${table}`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, table);
  process.exit(results.some((r) => r.failed) ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
