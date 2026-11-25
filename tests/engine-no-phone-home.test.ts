import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { walk } from "./support/walk";
import { expectFloor } from "./support/floor";

/**
 * The engine phones home nowhere (issue #43, spec D2 / Phase 1).
 *
 * Two paths shipped inside the closure at the fork point, and D2 is explicit that they
 * are "removed (not just configured off) before any build leaves developers'
 * machines":
 *
 *   1. **OTLP metrics to Statsig.** `atlas-engine-otel` carried a built-in exporter
 *      posting to `https://ab.chatgpt.com/otlp/v1/metrics` with a **hardcoded
 *      client key**, and `atlas-engine-core` *defaulted* the metrics exporter to it
 *      (`core/src/config/otel.rs`). The original gated it on `cfg!(debug_assertions)`
 *      — which means it was live in exactly the builds that ship.
 *   2. **Per-session analytics to the ChatGPT backend.** `atlas-engine-analytics`
 *      POSTed to `{chatgpt_base_url}/<upstream name>/analytics-events/events`, was
 *      constructed for **every** session, was on unless config said otherwise,
 *      and sent a subset of events *even under plain API-key auth*.
 *
 * Research: `docs/archive/atlas-engine-fork-seam.md (deleted; last in git at 9459428b)` §3 and its identity table.
 *
 * **Why a text test.** Neither path fails a build, a type-check, or a test when
 * it comes back. Both are reachable by an ordinary-looking edit — restoring an
 * enum variant, handing a base URL to a constructor — and the only symptom is
 * traffic leaving a user's machine. That is precisely the class cargo will
 * never announce, so it is asserted here instead.
 *
 * This is the permanent one. `engine-quarantine.test.ts` guards a condition that
 * ends when #45 rewires the seam; nothing ever makes this acceptable again.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = path.join(REPO_ROOT, "vendor", "atlas-engine");

/** Source-ish files worth scanning. Excludes lockfiles and binary fixtures. */
const SCANNED = [".rs", ".toml", ".json", ".md", ".bazel", ".sh", ".py", ".ts"];

/**
 * The engine tree is ~4k files and every assertion below scans all of it.
 * Walking it AND re-reading every file once per assertion cost ~18s for this
 * file, which put individual tests over vitest's 5s default whenever enough
 * suites ran in parallel — a timeout that looked like a phone-home regression.
 * The traversal and the file contents are immutable for the run, so both are
 * read once and shared, up front in `beforeAll` with a budget of its own (a
 * build beside the pre-commit run still pushed the first reader past 5s).
 * Nothing about what is asserted changes.
 */
let walked: string[] | null = null;
function sourceFiles(): string[] {
  walked ??= walk(VENDOR, SCANNED);
  return walked;
}

const fileText = new Map<string, string>();
function textOf(file: string): string {
  let text = fileText.get(file);
  if (text === undefined) {
    text = readFileSync(file, "utf8");
    fileText.set(file, text);
  }
  return text;
}

beforeAll(() => {
  for (const file of sourceFiles()) textOf(file);
}, 120_000);

/**
 * Test code, which is held to a different rule than shipping code.
 *
 * The engine's own suites mount **local wiremock servers** on the paths the
 * engine used to POST to, then assert what was sent. A mock bound to
 * `127.0.0.1` cannot phone home no matter what path it answers on, so a test
 * naming the old endpoint is not a leak — and rewriting eight original test
 * files would churn a tree #42 deliberately keeps byte-identical to the fork point,
 * in crates Atlas does not ship.
 *
 * Those suites now assert behaviour that no longer exists, which is real debt
 * — recorded on #43 and cleared in Phase 5, where these crates are slimmed
 * anyway. What must hold *now* is that nothing shipping knows the endpoint.
 */
function isTestCode(file: string): boolean {
  const rel = path.relative(REPO_ROOT, file);
  const base = path.basename(rel);
  return (
    rel.includes(`${path.sep}tests${path.sep}`) ||
    base === "tests.rs" ||
    base.endsWith("_tests.rs") ||
    base.endsWith(".test.ts")
  );
}

/**
 * Strip prose, so a file may explain what was removed without re-tripping the
 * check that removed it.
 *
 * Apache-2.0 §4(b) wants modified files marked, and a reader who finds a hole
 * where a feature used to be is owed the reason — so the removals here are
 * commented, and those comments name the thing. Only the code is scanned.
 */
function codeOnly(file: string, src: string): string {
  const ext = path.extname(file);
  return src
    .split("\n")
    .filter((line) => {
      const t = line.trimStart();
      if (ext === ".rs") return !t.startsWith("//");
      if (ext === ".md") return !t.startsWith(">");
      // TOML comments start with `#`; Rust-style `#[attr]` never does here.
      if (ext === ".toml") return !t.startsWith("#");
      return true;
    })
    .join("\n");
}

/** Like `filesMatching`, but blind to comments and markdown blockquotes. */
function codeMatching(needle: RegExp): string[] {
  return sourceFiles()
    .filter((f) => !isTestCode(f))
    .filter((f) => needle.test(codeOnly(f, textOf(f))))
    .map((f) => path.relative(REPO_ROOT, f));
}

/** Every scanned production file whose text matches `needle`, repo-relative. */
function filesMatching(needle: RegExp): string[] {
  return sourceFiles()
    .filter((f) => !isTestCode(f))
    .filter((f) => needle.test(textOf(f)))
    .map((f) => path.relative(REPO_ROOT, f));
}

describe("the engine's egress surface (parser health)", () => {
  it("scans a plausible number of engine files", () => {
    // A traversal that silently stopped would make every assertion below pass
    // by finding nothing. The engine is ~4k files.
    expectFloor("source files under vendor/atlas-engine", sourceFiles().length, 3200);
  });

  it("still finds the engine's ordinary network code", () => {
    // Proves the scanner reads content, not just names: the engine legitimately
    // talks to whatever model provider the user configured, and that must
    // survive. A test that forbade all HTTP would be wrong, not strict.
    expectFloor("engine files that name reqwest", filesMatching(/reqwest/).length, 15);
  });
});

describe("the Statsig metrics exporter is gone", () => {
  it("has no hardcoded client key", () => {
    // The literal that shipped at the fork point. Split so this file is not itself a
    // hit for anyone grepping the repo for the key.
    const key = ["client-MkRuleRQBd6qakfnDYqJVR9", "JuXcY57Ljly3vi5JVUIO"].join("");
    expect(filesMatching(new RegExp(key))).toEqual([]);
  });

  it("has no Statsig ingestion endpoint", () => {
    expect(filesMatching(/ab\.chatgpt\.com/)).toEqual([]);
    expect(filesMatching(/otlp\/v1\/metrics/)).toEqual([]);
  });

  it("has no Statsig code path at all", () => {
    // The name, anywhere: the enum variants (`OtelExporter::Statsig`,
    // `OtelExporterKind::Statsig`), the settings struct that ferried the
    // resolved config to another process, the config-schema enum value, and
    // the README section documenting it. A variant left in place is a variant
    // something can select.
    expect(codeMatching(/statsig/i)).toEqual([]);
  });
});

describe("the ChatGPT analytics client is gone", () => {
  it("has no analytics ingestion endpoint", () => {
    expect(filesMatching(/analytics-events\/events/)).toEqual([]);
  });

  it("builds no analytics URL from a base URL", () => {
    // The original shape was `format!("{base_url}/<upstream name>/analytics-events/events")`.
    // Catches a rebuild of the path from pieces.
    expect(filesMatching(/\/analytics-events\//)).toEqual([]);
  });

  it("sends no HTTP request from the analytics crate", () => {
    // The crate keeps its public surface — core calls ~35 `track_*` methods —
    // but nothing behind them may reach the network. No client, no POST.
    // `walk`, not `sourceFiles`: this assertion is scoped to one crate, and
    // the memoized `sourceFiles()` is the whole engine tree.
    const analytics = walk(path.join(VENDOR, "analytics"), SCANNED);
    expectFloor("source files in the engine's analytics crate", analytics.length, 5);

    const offenders = analytics
      .filter((f) => /reqwest|\.post\(|\.send\(\)\s*$/m.test(textOf(f)))
      .map((f) => path.relative(REPO_ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("declares no HTTP client dependency", () => {
    const manifest = readFileSync(path.join(VENDOR, "analytics", "Cargo.toml"), "utf8");
    expect(manifest).not.toMatch(/^\s*reqwest/m);
  });
});

describe("the Sentry feedback uploader is gone", () => {
  it("has no Sentry DSN", () => {
    // The fourth phone-home path (#63): `atlas-engine-feedback` shipped a hardcoded
    // ingest DSN and built a client around it inside `upload_feedback` — a
    // path the in-process app-server would honour on a `feedback/upload`
    // request. The key is split so this file is not itself a hit.
    const dsn = ["ae32ed50620d7a", "7792c1ce5df38b3e3e"].join("");
    expect(filesMatching(new RegExp(dsn))).toEqual([]);
    expect(filesMatching(/o33249\.ingest/)).toEqual([]);
  });

  it("parses no DSN and builds no Sentry client", () => {
    expect(codeMatching(/Dsn::from_str|sentry::init/)).toEqual([]);
  });
});

describe("no telemetry ingest marker anywhere in engine code", () => {
  // The removals above are point checks against sites already known. The
  // fourth path (#63) shipped precisely because only known sites were
  // asserted: the guard could not fail on one it had never heard of. This is
  // the structural half — any ingest-service marker in engine CODE fails
  // here (comments explaining a removal don't count), so a fifth site fails
  // rather than passes.
  it("matches no known telemetry vendor", () => {
    const markers =
      /sentry\.io|statsig|posthog\.com|segment\.io|datadoghq|bugsnag|honeycomb\.io|o33249/i;
    expect(codeMatching(markers)).toEqual([]);
  });
});

/**
 * The fifth path (whole-app review, 2026-11-24): the plugin manager warmed a
 * "featured plugins" cache on every engine start with
 * `GET {chatgpt_base_url}/plugins/featured`, and the engine's built-in
 * `chatgpt_base_url` is chatgpt.com. Nothing about it was analytics, so the
 * vendor-marker scan above could not see it. Two fences, either one enough:
 * Atlas pins the engine's plugin system off, and the fetch itself refuses a
 * ChatGPT host. Both are code an ordinary edit can undo.
 */
describe("the ChatGPT featured-plugins fetch is fenced", () => {
  it("Atlas's engine config pins the plugin system off", () => {
    const config = readFileSync(
      path.join(REPO_ROOT, "crates", "atlas-native-agent", "src", "engine", "config.rs"),
      "utf8",
    );
    expect(codeOnly("config.rs", config)).toMatch(
      /\(\s*"features\.plugins"\.to_string\(\),\s*TomlValue::Boolean\(false\)\s*\)/,
    );
  });

  it("the featured fetch refuses a ChatGPT host before building its URL", () => {
    const file = path.join(VENDOR, "core-plugins", "src", "remote_legacy.rs");
    const code = codeOnly(file, textOf(file));
    const start = code.indexOf("pub async fn fetch_remote_featured_plugin_ids");
    expect(start).toBeGreaterThanOrEqual(0);
    const body = code.slice(start, code.indexOf("\n}\n", start));
    const guard = body.indexOf("is_allowed_chatgpt_host");
    const request = body.indexOf("/plugins/featured");
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(request);
  });

  it("is the only shipping site that builds the featured URL", () => {
    expect(codeMatching(/\/plugins\/featured/)).toEqual([
      path.join("vendor", "atlas-engine", "core-plugins", "src", "remote_legacy.rs"),
    ]);
  });
});
