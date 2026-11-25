//! Source-level audit: the only place a `git` process is built is
//! `crates/atlas-git/src/exec.rs`.
//!
//! [`atlas_git::GitCommand`] gives every run one environment (no terminal
//! prompt, English messages for the error table), no console window on
//! Windows, the read-only lock rule and one failure taxonomy. A site that
//! spawns git itself gets none of that, and nothing fails: it type-checks,
//! passes its own tests on an English machine with credentials cached, and
//! hangs on a hidden prompt on someone else's. The compiler cannot see it, so
//! this test walks the source.
//!
//! What counts as a site, in production code (test modules, `tests/`,
//! `benches/`, `examples/` and `build.rs` are skipped: a test may set up its
//! fixture repository however it likes):
//!
//! - a process built for git by name: `Command::new("git")`,
//!   `atlas_process::command("git")`, `async_command("git")`;
//! - the string literal `"git"` or `"git.exe"` anywhere else, which is how a
//!   spawn built from a variable (`let program = "git"`) starts.
//!
//! `ALLOWED` lists the files where that literal is not a spawn. The test
//! fails on a new site, and on an entry that no longer matches anything.
//!
//! Out of scope: `vendor/atlas-engine`, whose git runs are the agent's own
//! tooling inside its sandbox, through `atlas-engine-git-utils`; and a shell
//! command line that happens to say `git`, which no source scan can tell
//! from prose.

use std::fs;
use std::path::{Path, PathBuf};

/// The one file allowed to build a git process.
const CHOKEPOINT: &str = "crates/atlas-git/src/exec.rs";

/// Files where the literal `"git"` is not a spawn: path, and why (20+
/// characters, checked).
const ALLOWED: &[(&str, &str)] = &[
    (
        "crates/atlas-agent-servers/src/test_support/scenarios.rs",
        "a scripted fake agent's tool-call input JSON names git as argv data; nothing is spawned",
    ),
    (
        "src-tauri/src/commands/pull_requests/checkout.rs",
        "names the default program it hands to GitCommand::program, whose other value is a test's script",
    ),
    (
        "crates/atlas-security/src/deps/lockfiles.rs",
        "a lockfile version prefix (`git+…`) in a list of non-registry sources, never a program",
    ),
];

/// The fewest Rust files a real walk of `src-tauri/src` and `crates` finds.
/// Far below today's count: it is a floor against scanning nothing.
const MIN_FILES: usize = 200;

fn skipped(path: &str) -> bool {
    const FRAGMENTS: &[&str] = &[
        "/tests/",
        "/testing/",
        "_tests.rs",
        "/tests.rs",
        "/benches/",
        "/examples/",
        "/build.rs",
    ];
    FRAGMENTS.iter().any(|f| path.contains(f))
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if path.is_dir() {
            if name == "target" || name == "node_modules" || name.starts_with('.') {
                continue;
            }
            walk(&path, out);
        } else if name.ends_with(".rs") {
            out.push(path);
        }
    }
}

/// Whether `line` names git as a program or as a string a program could be
/// built from.
fn names_git(line: &str) -> bool {
    line.contains("\"git\"") || line.contains("\"git.exe\"")
}

/// The 1-indexed lines of `src` that are git sites, production code only.
fn sites_in(src: &str) -> Vec<usize> {
    let lines: Vec<&str> = src.lines().collect();
    let mut sites = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        // Everything after the first `#[cfg(test)]`-gated module is test
        // code; the test module is conventionally last in the file.
        if (trimmed.starts_with("#[cfg(test)]") || trimmed.starts_with("#[cfg(all(test"))
            && lines[i + 1..(i + 4).min(lines.len())]
                .iter()
                .any(|l| l.trim_start().starts_with("mod "))
        {
            break;
        }
        if !trimmed.starts_with("//") && names_git(line) {
            sites.push(i + 1);
        }
    }
    sites
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn the_scanner_sees_a_spawn_and_ignores_tests_and_comments() {
    for spawn in [
        r#"let out = std::process::Command::new("git").arg("status");"#,
        r#"let mut cmd = atlas_process::command("git");"#,
        r#"let mut cmd = atlas_process::async_command("git");"#,
        r#"let program = if cfg!(windows) { "git.exe" } else { "git" };"#,
        r#"run(cwd, "git", &["status"], TIMEOUT)"#,
    ] {
        assert_eq!(sites_in(spawn), vec![1], "{spawn}");
    }
    for not_a_spawn in [
        r#"// Command::new("git") is what this used to do."#,
        r#"GitCommand::new(path, &["status"]).run()"#,
        r#"let name = "github";"#,
    ] {
        assert!(sites_in(not_a_spawn).is_empty(), "{not_a_spawn}");
    }
    let with_tests =
        "fn real() {}\n#[cfg(test)]\nmod tests {\n    fn g() { Command::new(\"git\"); }\n}\n";
    assert!(sites_in(with_tests).is_empty());
}

#[test]
fn every_git_process_is_built_by_the_chokepoint() {
    let root = repo_root();
    let mut files = Vec::new();
    for dir in ["src-tauri/src", "crates"] {
        walk(&root.join(dir), &mut files);
    }
    assert!(
        files.len() >= MIN_FILES,
        "walked {} Rust files, expected at least {MIN_FILES}: the audit is not seeing the workspace",
        files.len()
    );

    for (path, reason) in ALLOWED {
        assert!(
            reason.len() >= 20,
            "{path}: an allowlist entry needs a real reason"
        );
    }

    let mut found_chokepoint = false;
    let mut new_sites: Vec<String> = Vec::new();
    let mut allowed_hit: Vec<&str> = Vec::new();
    for file in &files {
        let rel = file
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        if skipped(&format!("/{rel}")) {
            continue;
        }
        let Ok(src) = fs::read_to_string(file) else {
            continue;
        };
        let sites = sites_in(&src);
        if rel == CHOKEPOINT {
            // The scanner run over the chokepoint must report it: proof that
            // it recognises the real thing, not only this file's samples.
            found_chokepoint = !sites.is_empty();
            continue;
        }
        if sites.is_empty() {
            continue;
        }
        if let Some((path, _)) = ALLOWED.iter().find(|(path, _)| *path == rel) {
            allowed_hit.push(path);
        } else {
            new_sites.extend(sites.into_iter().map(|line| format!("{rel}:{line}")));
        }
    }

    assert!(
        found_chokepoint,
        "{CHOKEPOINT} was not found, or the scanner no longer sees the spawn in it"
    );
    assert!(
        new_sites.is_empty(),
        "git named outside {CHOKEPOINT}. Run it through atlas_git::GitCommand (its \
         env(), stdin(), timeout(), output() and stdout_capped() cover what a caller needs), \
         or, if this is not a spawn, add the file to ALLOWED with the reason:\n  {}",
        new_sites.join("\n  ")
    );
    let stale: Vec<&str> = ALLOWED
        .iter()
        .map(|(path, _)| *path)
        .filter(|path| !allowed_hit.contains(path))
        .collect();
    assert!(
        stale.is_empty(),
        "ALLOWED entries that no longer name git: remove them: {stale:?}"
    );
}
