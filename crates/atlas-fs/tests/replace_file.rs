//! `replace_file` through its public interface. Durability across power loss
//! is the one promise not tested here: nothing in a test can cut the power.

use std::fs;
use std::path::Path;

use atlas_fs::replace_file;
#[cfg(unix)]
use atlas_fs::replace_file_with_mode;

fn names_in(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn replaces_existing_content() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("config.toml");
    fs::write(&path, "a much longer first version\n").unwrap();

    replace_file(&path, "second\n").unwrap();

    assert_eq!(fs::read_to_string(&path).unwrap(), "second\n");
}

#[test]
fn creates_the_file_when_absent() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("new.json");

    replace_file(&path, b"{}").unwrap();

    assert_eq!(fs::read(&path).unwrap(), b"{}");
}

#[test]
fn creates_missing_parent_directories() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("a").join("b").join("ledger.json");

    replace_file(&path, "[]").unwrap();

    assert_eq!(fs::read_to_string(&path).unwrap(), "[]");
}

#[test]
fn leaves_no_temp_file_after_success() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("only.md");

    replace_file(&path, "one").unwrap();
    replace_file(&path, "two").unwrap();

    assert_eq!(names_in(dir.path()), ["only.md"]);
}

#[test]
fn a_failed_write_leaves_no_temp_file_and_the_target_untouched() {
    let dir = tempfile::tempdir().unwrap();
    // A non-empty directory at the target: the temp is written, then the
    // rename over it is refused.
    let target = dir.path().join("config.toml");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("keep"), "kept").unwrap();

    assert!(replace_file(&target, "x").is_err());

    assert_eq!(names_in(dir.path()), ["config.toml"]);
    assert_eq!(fs::read_to_string(target.join("keep")).unwrap(), "kept");
}

#[test]
fn errors_when_the_parent_cannot_be_a_directory() {
    let dir = tempfile::tempdir().unwrap();
    let blocker = dir.path().join("blocker");
    fs::write(&blocker, "a file, not a directory").unwrap();

    assert!(replace_file(blocker.join("child.json"), "x").is_err());

    assert_eq!(names_in(dir.path()), ["blocker"]);
    assert_eq!(
        fs::read_to_string(&blocker).unwrap(),
        "a file, not a directory"
    );
}

#[test]
fn errors_when_the_path_names_no_file() {
    assert!(replace_file(Path::new("/"), "x").is_err());
}

/// The bug this module replaced: `path.with_extension("tmp")` gave `a.json`
/// and `a.md` the one temp path `a.tmp`, so two writers could publish each
/// other's bytes.
#[test]
fn same_stem_different_extension_do_not_collide() {
    let dir = tempfile::tempdir().unwrap();
    let json = dir.path().join("a.json");
    let md = dir.path().join("a.md");
    let json_body = "j".repeat(64 * 1024);
    let md_body = "m".repeat(64 * 1024);

    std::thread::scope(|scope| {
        for _ in 0..4 {
            scope.spawn(|| {
                for _ in 0..25 {
                    replace_file(&json, &json_body).unwrap();
                }
            });
            scope.spawn(|| {
                for _ in 0..25 {
                    replace_file(&md, &md_body).unwrap();
                }
            });
        }
    });

    assert_eq!(fs::read_to_string(&json).unwrap(), json_body);
    assert_eq!(fs::read_to_string(&md).unwrap(), md_body);
    assert_eq!(names_in(dir.path()), ["a.json", "a.md"]);
}

#[test]
fn concurrent_writers_to_one_path_each_land_a_complete_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("shared.json");
    // Each writer's payload is one repeated byte, of a different length, so
    // a torn or interleaved file cannot pass for any of them.
    let payloads: Vec<Vec<u8>> = (0..8u8)
        .map(|i| vec![b'a' + i; 32 * 1024 + usize::from(i) * 4096])
        .collect();
    replace_file(&path, &payloads[0]).unwrap();

    std::thread::scope(|scope| {
        for payload in &payloads {
            let path = &path;
            scope.spawn(move || {
                for _ in 0..25 {
                    replace_file(path, payload).unwrap();
                }
            });
        }
        // A reader racing the writers never sees a partial file either.
        let (path, payloads) = (&path, &payloads);
        scope.spawn(move || {
            for _ in 0..200 {
                let seen = fs::read(path).unwrap();
                assert!(payloads.contains(&seen), "read a torn file");
            }
        });
    });

    let last = fs::read(&path).unwrap();
    assert!(payloads.contains(&last), "the final file is torn");
    assert_eq!(names_in(dir.path()), ["shared.json"]);
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn mode_of(path: &Path) -> u32 {
        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn applies_the_mode_to_a_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets");

        replace_file_with_mode(&path, "KEY=1\n", 0o600).unwrap();

        assert_eq!(mode_of(&path), 0o600);
        assert_eq!(fs::read_to_string(&path).unwrap(), "KEY=1\n");
    }

    #[test]
    fn applies_the_mode_when_replacing_a_wider_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("profile");
        fs::write(&path, "old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        replace_file_with_mode(&path, "new", 0o600).unwrap();

        assert_eq!(mode_of(&path), 0o600);
    }

    /// Exactly the mode asked for, not the mode minus the umask: 0o666 would
    /// come out as 0o644 under the usual 022 if `open` alone set it.
    #[test]
    fn the_mode_is_exact_not_masked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wide");

        replace_file_with_mode(&path, "x", 0o666).unwrap();

        assert_eq!(mode_of(&path), 0o666);
    }
}

#[cfg(unix)]
#[test]
fn opted_in_replacement_preserves_symlink_and_updates_its_target() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("actual.toml");
    let link = dir.path().join("config.toml");
    fs::write(&target, "before").unwrap();
    std::os::unix::fs::symlink("actual.toml", &link).unwrap();
    atlas_fs::replace_file_follow_symlink(&link, "after").unwrap();
    assert_eq!(fs::read_link(&link).unwrap(), Path::new("actual.toml"));
    assert_eq!(fs::read_to_string(&target).unwrap(), "after");
    fs::remove_file(&target).unwrap();
    assert!(atlas_fs::replace_file_follow_symlink(&link, "lost").is_err());
    assert!(link.symlink_metadata().unwrap().file_type().is_symlink());
    assert!(!target.exists());
}
