/**
 * Types for `ci-affected.mjs`, which is plain Node ESM so CI's `changes` job
 * can run it with no install step. Only the surface
 * `tests/ci-affected.test.ts` and `tests/ci-coverage.test.ts` import is
 * declared.
 */

export interface CrateEntry {
  crate: string;
  clippy?: boolean;
  sandbox?: boolean;
  "release-build"?: boolean;
  cross?: boolean;
}

export interface Package {
  name: string;
  /** Repo-relative, `/`-separated. */
  dir: string;
  /** Names of the packages this one depends on by path (any kind). */
  deps: string[];
  /** A `crates/*` package the root workspace excludes (own lockfile and target dir). */
  excluded?: boolean;
}

export interface CrateGroup {
  /** The job's name. */
  group: string;
  /** Crate names, checked by scripts/ci-crates.mjs in this order. */
  crates: string[];
  /** Whether the job installs bubblewrap. */
  sandbox: boolean;
  /** The directory rust-cache keys off: `.` or the excluded crate's own. */
  workspace: string;
}

export interface Workspace {
  packages: Package[];
}

export interface ExtraInput {
  path: string;
  packages: string[];
  /** Read only by the package's own tests; its dependents are not marked. */
  testOnly?: boolean;
  why: string;
}

export interface Plan {
  reason: string;
  /** Affected package names, or `null` when everything runs. */
  affected: string[] | null;
  app: boolean;
  engineDialect: boolean;
  crates: CrateEntry[];
  /** Whether the `e2e` job runs: everything planned, or an E2E_INPUTS path changed. */
  e2e: boolean;
}

export type Range = { all: string } | { base: string; head: string };

export const REPO_ROOT: string;
export const GLOBAL_INPUTS: string[];
export const EXTRA_INPUTS: ExtraInput[];
export const NON_RUST: string[];
export const E2E_INPUTS: string[];
export function matches(pattern: string, file: string): boolean;
export function loadWorkspace(root?: string): Workspace;
export function affectedPackages(
  files: string[],
  workspace: Workspace,
): { all: string | null; packages: Set<string> };
export function dialectPackages(ciYml: string): string[];
export function plan(
  files: string[] | null,
  ctx: { workspace: Workspace; crates: CrateEntry[]; dialect: string[] },
  allReason?: string,
): Plan;
export const CRATES_PER_GROUP: number;
export function crateGroups(crates: CrateEntry[], workspace: Workspace): CrateGroup[];
export function forDraft(p: Plan): Plan;
export function readCrateMatrix(root?: string): CrateEntry[];
export function resolveRange(
  env: Record<string, string | undefined>,
  commitExists: (sha: string) => boolean,
): Range;
