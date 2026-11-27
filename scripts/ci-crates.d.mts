/**
 * Types for `ci-crates.mjs`, which is plain Node ESM so CI's Rust jobs can run
 * it with no install step. Only the surface the tests import is declared.
 */

import type { CrateEntry } from "./ci-affected.mjs";

export interface CrateStep {
  name: string;
  /** Arguments to `cargo`, run from `crates/<crate>`. */
  args: string[];
}

export const WINDOWS_TARGET: string;
export function crateSteps(entry: CrateEntry, opts?: { extraTarget?: string }): CrateStep[];
export function selectCrates(names: string[], matrix: CrateEntry[]): CrateEntry[];
