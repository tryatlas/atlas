//! The path rules, through the public interface: which roots a store opens
//! on, and that no skill name reaches outside `<root>/.agents/skills`.
//!
//! The guard is lexical: a name is reduced to one safe path segment and the
//! resolved path is checked against the store's base. It does not resolve
//! symlinks, which the tests at the bottom pin as the code stands.

mod common;

use std::fs;
use std::path::Path;

use atlas_skills::SkillStore;
use common::{project_store, skill_md, snapshot, write};

#[test]
fn a_store_opens_only_on_a_root_it_can_trust() {
    let home = Path::new("/home/someone");
    type Case<'a> = (
        Option<&'a Path>,
        &'a str,
        Option<&'a str>,
        Result<(), &'a str>,
    );
    let cases: &[Case] = &[
        (Some(home), "global", None, Ok(())),
        (
            None,
            "global",
            None,
            Err("could not resolve home directory"),
        ),
        (Some(home), "project", Some("/work/repo"), Ok(())),
        // A project's store needs no home directory to open.
        (None, "project", Some("/work/repo"), Ok(())),
        (
            Some(home),
            "project",
            None,
            Err("project scope requires a projectPath"),
        ),
        (
            Some(home),
            "project",
            Some(""),
            Err("project scope requires a projectPath"),
        ),
        (
            Some(home),
            "project",
            Some("   "),
            Err("project scope requires a projectPath"),
        ),
        (
            Some(home),
            "project",
            Some("/work/repo/../../etc"),
            Err("invalid projectPath: parent-directory segments are not allowed"),
        ),
        (
            Some(home),
            "project",
            Some("../sibling"),
            Err("invalid projectPath: parent-directory segments are not allowed"),
        ),
        (
            Some(home),
            "workspace",
            None,
            Err("invalid scope: workspace"),
        ),
        (Some(home), "", None, Err("invalid scope: ")),
    ];
    for (home, scope, project_path, expected) in cases {
        let got = SkillStore::open(*home, scope, *project_path).map(|_| ());
        assert_eq!(
            got.as_ref().map_err(String::as_str),
            expected.as_ref().map(|()| &()).map_err(|e| *e),
            "open({home:?}, {scope:?}, {project_path:?})"
        );
    }
}

/// `tmp/root` is the project; `tmp/outside` is a skill-shaped directory beside
/// it that no name may reach.
fn root_with_a_neighbour() -> (tempfile::TempDir, SkillStore) {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("root");
    fs::create_dir_all(root.join(".claude")).unwrap();
    write(
        &root.join(".agents/skills/kept/SKILL.md"),
        &skill_md("kept", "Stays", "kept body"),
    );
    write(
        &tmp.path().join("outside/SKILL.md"),
        &skill_md("outside", "Not yours", "secret"),
    );
    let store = project_store(&tmp.path().join("home"), &root);
    (tmp, store)
}

#[test]
fn no_skill_name_reaches_outside_the_store() {
    let (tmp, store) = root_with_a_neighbour();
    let absolute = tmp.path().join("outside").to_string_lossy().to_string();
    // (name as sent, what every lookup reports)
    let cases: &[(&str, &str)] = &[
        ("../outside", "skill not found: outside"),
        ("../../outside", "skill not found: outside"),
        ("..\\outside", "skill not found: outside"),
        ("./../outside/", "skill not found: outside"),
        ("kept/../../outside", "skill not found: kept-..-..-outside"),
        ("a/b", "skill not found: a-b"),
        ("a\\b", "skill not found: a-b"),
        ("..", "invalid skill name: \"..\""),
        (".", "invalid skill name: \".\""),
        ("", "invalid skill name: \"\""),
        ("///", "invalid skill name: \"///\""),
        ("  ", "invalid skill name: \"  \""),
    ];
    let before = snapshot(tmp.path());
    for (name, expected) in cases {
        assert_eq!(store.read(name).unwrap_err(), *expected, "read {name:?}");
        assert_eq!(store.path(name).unwrap_err(), *expected, "path {name:?}");
        assert_eq!(
            store.set_enabled(name, "claude-code", true).unwrap_err(),
            *expected,
            "set_enabled {name:?}"
        );
        assert!(
            store.project(name, "claude-code", true).is_err(),
            "project {name:?}"
        );
        assert!(store.adopt(name).is_err(), "adopt {name:?}");
        assert!(store.promote(name).is_err(), "promote {name:?}");
        // Deleting a skill that is not there succeeds, and deletes nothing.
        let deleted = store.delete(name);
        assert_eq!(
            deleted.is_err(),
            expected.starts_with("invalid"),
            "delete {name:?}"
        );
    }
    // An absolute path is one more name: it becomes a single segment.
    let err = store.read(&absolute).unwrap_err();
    assert!(err.starts_with("skill not found: "), "{err}");
    assert!(!err["skill not found: ".len()..].contains('/'), "{err}");
    store.delete(&absolute).unwrap();

    // The neighbour, and the skill in the store, are untouched. The only
    // thing written is the store's own ledger, by the deletes.
    let mut after = snapshot(tmp.path());
    assert!(after
        .remove("root/.agents/skills/.projections.json")
        .is_some());
    assert_eq!(before, after);
}

#[test]
fn a_name_with_separators_or_capitals_is_one_folded_segment() {
    let (tmp, store) = root_with_a_neighbour();
    write(
        &tmp.path().join("root/.agents/skills/a-b/SKILL.md"),
        &skill_md("a-b", "Dashed", "dashed body"),
    );
    // Separators collapse to a dash, so `a/b` is the skill `a-b`.
    assert_eq!(store.read("a/b").unwrap().body.trim(), "dashed body");
    assert_eq!(store.read("A B").unwrap().body.trim(), "dashed body");
    // Names fold to lowercase: two spellings are one skill, never two dirs.
    assert_eq!(
        store.read("KEPT").unwrap().raw,
        store.read("kept").unwrap().raw
    );
    assert_eq!(store.path("Kept").unwrap(), store.path("kept").unwrap());
    assert!(store
        .path("Kept")
        .unwrap()
        .ends_with(".agents/skills/kept/SKILL.md"));
}

/// As the code stands: a skill directory in the store may be a symlink, and
/// the store reads through it. Deleting it removes the link, never what the
/// link points at.
#[cfg(unix)]
#[test]
fn a_symlinked_skill_dir_is_read_through_and_deleted_as_a_link() {
    let (tmp, store) = root_with_a_neighbour();
    let outside = tmp.path().join("outside");
    let link = tmp.path().join("root/.agents/skills/linked");
    std::os::unix::fs::symlink(&outside, &link).unwrap();

    assert_eq!(store.read("linked").unwrap().body.trim(), "secret");

    store.delete("linked").unwrap();
    assert!(link.symlink_metadata().is_err(), "the link is gone");
    assert!(outside.join("SKILL.md").is_file(), "its target is not");
}

/// Promotion must not copy private content from outside the skill through
/// a symlink, or leave a partial installation after refusing that link.
#[cfg(unix)]
#[test]
fn promoting_a_skill_refuses_external_file_links() {
    let (tmp, store) = root_with_a_neighbour();
    let private = tmp.path().join("private.txt");
    fs::write(&private, "not part of the skill").unwrap();
    std::os::unix::fs::symlink(
        &private,
        tmp.path().join("root/.agents/skills/kept/notes.txt"),
    )
    .unwrap();

    let error = store.promote("kept").unwrap_err();
    assert!(error.contains("absolute symlink cannot be installed"));
    assert!(!tmp.path().join("home/.agents/skills/kept").exists());
    assert!(tmp
        .path()
        .join("root/.agents/skills/kept/SKILL.md")
        .is_file());
    assert_eq!(
        fs::read_to_string(private).unwrap(),
        "not part of the skill"
    );
}

/// The pack-projection ledger (`<root>/.atlas/packs/.pack-projections.json`)
/// records where each projection landed as `targetRel`. At project scope that
/// file is part of the project, so a repository can ship a forged one. Un-
/// projecting must not delete `<root>/<targetRel>` on the ledger's word: it
/// recomputes the destination from the tool registry and acts only on an exact
/// match, so `../victim` (or any absolute path the registry would not produce)
/// is dropped from the ledger without touching the disk.
#[cfg(unix)]
#[test]
fn a_pack_ledger_entry_cannot_point_unprojection_outside_the_root() {
    let (tmp, store) = root_with_a_neighbour();
    let victim = tmp.path().join("victim");
    write(&victim.join("keep.txt"), "important");
    write(
        &tmp.path().join("root/.atlas/packs/.pack-projections.json"),
        r#"{"version":1,"projections":{"evil":{"claude-code":[
            {"kind":"agent","relPath":"agents/x.md","leaf":"x.md","mode":"symlink","targetRel":"../victim"}
        ]}}}"#,
    );

    let _ = store.unproject_pack("evil", "claude-code");

    assert!(
        victim.join("keep.txt").is_file(),
        "un-projecting a pack deleted a directory outside the project root"
    );
}
