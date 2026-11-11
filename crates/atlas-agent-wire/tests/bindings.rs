//! The frontend's TypeScript for this wire is generated from the Rust types,
//! and committed under `src/bindings/agent-wire/`. `src/types/agents.ts`
//! re-exports it, so a field added, renamed or retyped here reaches every
//! consumer as a `tsc` error instead of an `undefined` at runtime.
//!
//! [`committed_bindings_match_the_rust_types`] regenerates the whole tree and
//! compares it with the committed one, file for file: a stale file, a missing
//! one, or one left behind by a deleted type all fail. `bun run bindings:gen`
//! (`ATLAS_BLESS=1 cargo test -p atlas-agent-wire --test bindings`) rewrites
//! the tree; review the diff, then fix whatever the frontend no longer
//! type-checks against.
//!
//! The export starts from the envelope and the delta and follows their
//! dependencies, so a type reachable from the wire is exported without being
//! listed here. Large integers are `number`, not ts-rs's default `bigint`:
//! they cross Tauri's IPC as JSON, which has no bigint.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use atlas_agent_wire::{SessionDelta, SessionDeltaEnvelope};
use ts_rs::{Config, TS};

const REGENERATE: &str =
    "`bun run bindings:gen` (ATLAS_BLESS=1 cargo test -p atlas-agent-wire --test bindings)";

fn committed_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/bindings/agent-wire")
}

/// Every `.{ext}` file under `root`, keyed by its `/`-separated path relative
/// to it. Only that extension: Finder drops a `.DS_Store` into any directory
/// it has shown, and that is neither a binding nor UTF-8.
fn read_tree(root: &Path, ext: &str) -> BTreeMap<String, String> {
    fn walk(root: &Path, dir: &Path, ext: &str, out: &mut BTreeMap<String, String>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries {
            let path = entry.expect("reads a directory entry").path();
            if path.is_dir() {
                walk(root, &path, ext, out);
            } else if path.extension().is_some_and(|e| e == ext) {
                let rel = path.strip_prefix(root).expect("is under the root");
                let key = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                out.insert(key, fs::read_to_string(&path).expect("reads a binding"));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, ext, &mut out);
    out
}

fn generate() -> BTreeMap<String, String> {
    // Per process: worktrees can share one target directory.
    let out = Path::new(env!("CARGO_TARGET_TMPDIR"))
        .join(format!("agent-wire-bindings-{}", std::process::id()));
    let _ = fs::remove_dir_all(&out);
    let cfg = Config::new().with_large_int("number").with_out_dir(&out);
    SessionDeltaEnvelope::export_all(&cfg).expect("exports the envelope");
    SessionDelta::export_all(&cfg).expect("exports the delta");
    let tree = read_tree(&out, "ts");
    let _ = fs::remove_dir_all(&out);
    tree
}

#[test]
fn committed_bindings_match_the_rust_types() {
    let fresh = generate();
    assert!(
        fresh.contains_key("SessionDelta.ts") && fresh.contains_key("Message.ts"),
        "the export found nothing to write: {:?}",
        fresh.keys().collect::<Vec<_>>()
    );
    let dir = committed_dir();

    if std::env::var_os("ATLAS_BLESS").is_some() {
        let _ = fs::remove_dir_all(&dir);
        for (rel, text) in &fresh {
            let path = dir.join(rel);
            fs::create_dir_all(path.parent().expect("has a parent")).expect("creates the dir");
            fs::write(&path, text).expect("writes a binding");
        }
        return;
    }

    let committed = read_tree(&dir, "ts");
    let missing: Vec<_> = fresh
        .keys()
        .filter(|k| !committed.contains_key(*k))
        .collect();
    let stale: Vec<_> = committed
        .keys()
        .filter(|k| !fresh.contains_key(*k))
        .collect();
    let changed: Vec<_> = fresh
        .iter()
        .filter(|(k, v)| committed.get(*k).is_some_and(|c| c != *v))
        .map(|(k, _)| k)
        .collect();
    assert!(
        missing.is_empty() && stale.is_empty() && changed.is_empty(),
        "src/bindings/agent-wire/ is out of date with the Rust types: run {REGENERATE} \
         and review the diff.\n  missing: {missing:?}\n  no longer generated: {stale:?}\n  \
         changed: {changed:?}"
    );
}

/// ts-rs only makes a field optional (`key?:`) when it sees the key can be
/// absent, and it reads that from the attributes, not from serde's
/// behaviour: `skip_serializing_if` alone still generates a required key, and
/// on an `Option` a required `T | null`. The frontend would then test for
/// `null` while `undefined` arrives. So every skippable field says so to
/// ts-rs: `#[ts(optional)]` on an `Option` (the key is absent, never `null`),
/// and serde's `default` on anything else.
#[test]
fn every_skippable_field_is_optional_in_typescript() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut bad = Vec::new();
    for (file, text) in read_tree(&src, "rs") {
        let lines: Vec<&str> = text.lines().collect();
        for (i, line) in lines.iter().enumerate() {
            if !line.contains("skip_serializing_if") {
                continue;
            }
            let mut attrs = line.to_string();
            let mut field = "";
            for next in &lines[i + 1..] {
                let t = next.trim();
                if t.starts_with("#[") {
                    attrs.push_str(t);
                } else if !t.starts_with("//") {
                    field = t;
                    break;
                }
            }
            let ok = if field.contains("Option<") {
                attrs.contains("#[ts(optional")
            } else {
                attrs.contains("default")
            };
            if !ok {
                bad.push(format!("src/{file}:{}: {field}", i + 1));
            }
        }
    }
    assert!(
        bad.is_empty(),
        "skippable fields TypeScript would read as always present (add `#[ts(optional)]` \
         to an Option, `#[serde(default, …)]` to anything else): {bad:#?}"
    );
}
