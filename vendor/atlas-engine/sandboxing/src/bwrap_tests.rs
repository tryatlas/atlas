// Modified by Atlas from upstream OpenAI Codex (Apache-2.0). See CONTEXT.md.
use super::*;
use pretty_assertions::assert_eq;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;
use std::time::Instant;
use tempfile::tempdir;

#[test]
fn system_bwrap_warning_reports_missing_system_bwrap() {
    assert_eq!(
        system_bwrap_warning_for_path(/*system_bwrap_path*/ None),
        Some(MISSING_BWRAP_WARNING.to_string())
    );
}

#[test]
fn system_bwrap_warning_reports_user_namespace_failures() {
    for failure in USER_NAMESPACE_FAILURES {
        let fake_bwrap = write_fake_bwrap(&format!(
            r#"#!/bin/sh
echo '{failure}' >&2
exit 1
"#
        ));
        let fake_bwrap_path: &Path = fake_bwrap.as_ref();

        assert_eq!(
            system_bwrap_warning_for_path_within(Some(fake_bwrap_path), PATIENT_PROBE),
            Some(USER_NAMESPACE_WARNING.to_string()),
            "{failure}",
        );
    }
}

#[test]
fn system_bwrap_warning_skips_unrelated_bwrap_failures() {
    let fake_bwrap = write_fake_bwrap(
        r#"#!/bin/sh
echo 'bwrap: Unknown option --argv0' >&2
exit 1
"#,
    );
    let fake_bwrap_path: &Path = fake_bwrap.as_ref();

    assert_eq!(system_bwrap_warning_for_path(Some(fake_bwrap_path)), None);
}

#[test]
fn system_bwrap_probe_times_out_without_reporting_a_warning() {
    let fake_bwrap = write_fake_bwrap(
        r#"#!/bin/sh
sleep 30
exit 0
"#,
    );
    let fake_bwrap_path: &Path = fake_bwrap.as_ref();
    let started_at = Instant::now();

    assert!(system_bwrap_has_user_namespace_access(
        fake_bwrap_path,
        Duration::from_millis(10),
    ));
    // Far short of the script's own 30 s, with room for a loaded machine to
    // be slow about spawning and killing it.
    assert!(started_at.elapsed() < Duration::from_secs(10));
}

#[test]
fn system_bwrap_probe_does_not_wait_for_descendants_holding_stderr_open() {
    let fake_bwrap = write_fake_bwrap(
        r#"#!/bin/sh
echo 'No permissions to create a new namespace' >&2
sleep 30 &
exit 1
"#,
    );
    let fake_bwrap_path: &Path = fake_bwrap.as_ref();
    let started_at = Instant::now();

    // The script itself exits at once; only its descendant lingers, holding
    // stderr open for 30 s. Reading the failure means the probe saw the exit
    // within its patience, and returning well inside those 30 s means it did
    // not wait for the descendant.
    assert!(!system_bwrap_has_user_namespace_access(
        fake_bwrap_path,
        PATIENT_PROBE,
    ));
    assert!(started_at.elapsed() < PATIENT_PROBE);
}

#[test]
fn detects_wsl1_proc_version_formats() {
    assert!(proc_version_indicates_wsl1(
        "Linux version 4.4.0-22621-Microsoft"
    ));
    assert!(proc_version_indicates_wsl1(
        "Linux version 5.15.0-microsoft-standard-WSL1"
    ));
    assert!(proc_version_indicates_wsl1(
        "Linux version 5.15.0-wsl-microsoft-standard-WSL1"
    ));
}

#[test]
fn does_not_treat_wsl2_or_native_linux_as_wsl1() {
    assert!(!proc_version_indicates_wsl1(
        "Linux version 6.6.87.2-microsoft-standard-WSL2"
    ));
    assert!(!proc_version_indicates_wsl1(
        "Linux version 6.6.87.2-wsl-microsoft-standard-WSL2"
    ));
    assert!(!proc_version_indicates_wsl1(
        "Linux version 4.19.104-microsoft-standard"
    ));
    assert!(!proc_version_indicates_wsl1(
        "Linux version 6.6.87.2-microsoft-standard-WSL3"
    ));
    assert!(!proc_version_indicates_wsl1("Linux version 6.8.0"));
}

#[test]
fn finds_first_executable_bwrap_in_joined_search_path() {
    let temp_dir = tempdir().expect("temp dir");
    let cwd = temp_dir.path().join("cwd");
    let first_dir = temp_dir.path().join("first");
    let second_dir = temp_dir.path().join("second");
    std::fs::create_dir_all(&cwd).expect("create cwd");
    std::fs::create_dir_all(&first_dir).expect("create first dir");
    std::fs::create_dir_all(&second_dir).expect("create second dir");
    std::fs::write(first_dir.join("bwrap"), "not executable").expect("write non-executable bwrap");
    let expected_bwrap = write_named_fake_bwrap_in(&second_dir);
    let search_path = std::env::join_paths([first_dir, second_dir]).expect("join search path");

    assert_eq!(
        find_system_bwrap_in_search_paths(std::env::split_paths(&search_path), &cwd, None),
        Some(expected_bwrap)
    );
}

#[test]
fn skips_workspace_local_bwrap_in_joined_search_path() {
    let temp_dir = tempdir().expect("temp dir");
    let cwd = temp_dir.path().join("cwd");
    let trusted_dir = temp_dir.path().join("trusted");
    std::fs::create_dir_all(&cwd).expect("create cwd");
    std::fs::create_dir_all(&trusted_dir).expect("create trusted dir");
    let _workspace_bwrap = write_named_fake_bwrap_in(&cwd);
    let expected_bwrap = write_named_fake_bwrap_in(&trusted_dir);
    let search_path = std::env::join_paths([cwd.clone(), trusted_dir]).expect("join search path");

    assert_eq!(
        find_system_bwrap_in_search_paths(std::env::split_paths(&search_path), &cwd, None),
        Some(expected_bwrap)
    );
}

#[test]
fn root_cwd_does_not_hide_system_bwrap_candidates() {
    let temp_dir = tempdir().expect("temp dir");
    let bin_dir = temp_dir.path().join("bin");
    std::fs::create_dir_all(&bin_dir).expect("create bin dir");
    let expected_bwrap = write_named_fake_bwrap_in(&bin_dir);
    let search_path = std::env::join_paths([bin_dir]).expect("join search path");

    assert_eq!(
        find_system_bwrap_in_search_paths(
            std::env::split_paths(&search_path),
            Path::new("/"),
            None
        ),
        Some(expected_bwrap)
    );
}

#[test]
fn appimage_bundle_does_not_shadow_the_system_bwrap() {
    let temp = tempdir().unwrap();
    let bundle = temp.path().join("appdir");
    let bundled_bin = bundle.join("usr/bin");
    let system_bin = temp.path().join("system/bin");
    std::fs::create_dir_all(&bundled_bin).unwrap();
    std::fs::create_dir_all(&system_bin).unwrap();
    write_named_fake_bwrap_in(&bundled_bin);
    let expected = write_named_fake_bwrap_in(&system_bin);
    assert_eq!(
        find_system_bwrap_in_search_paths(
            [bundled_bin.clone(), system_bin],
            Path::new("/"),
            Some(&bundle)
        ),
        Some(expected)
    );
    assert_eq!(
        find_system_bwrap_in_search_paths([bundled_bin], Path::new("/"), Some(&bundle)),
        None
    );
}

/// How long a test lets the probe wait for a fake `bwrap` that exits at once.
/// The app's own 500 ms is a guess at a machine with nothing else to do; a
/// test binary runs beside dozens of others, and a probe that times out
/// reports "no warning", which a test would read as a missed one.
const PATIENT_PROBE: Duration = Duration::from_secs(10);

/// A fake `bwrap` script, in a directory of its own that goes with it.
struct FakeBwrap {
    path: PathBuf,
    _dir: tempfile::TempDir,
}

impl AsRef<Path> for FakeBwrap {
    fn as_ref(&self) -> &Path {
        &self.path
    }
}

fn write_fake_bwrap(contents: &str) -> FakeBwrap {
    write_fake_bwrap_in(
        &std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        contents,
    )
}

/// Write an executable script without this process ever holding it open for
/// writing.
///
/// Linux refuses to exec a file that anything has open for writing
/// (`ETXTBSY`), and a descriptor this process opens is copied into every child
/// another test thread forks, until that child execs. Writing the script from
/// here therefore left a window in which the probe's own spawn failed with
/// "Text file busy", which the probe reports as "no warning": the tests failed
/// about once in twenty runs on a loaded machine. A child shell writes the
/// file instead and has exited, with its descriptor, before anything execs it.
fn write_fake_bwrap_in(dir: &Path, contents: &str) -> FakeBwrap {
    use std::io::Write;
    use std::process::Command;
    use std::process::Stdio;

    // Bazel can mount the OS temp directory `noexec`, so prefer the current
    // working directory for fake executables and fall back to the default temp
    // dir outside that environment.
    let dir = tempfile::tempdir_in(dir)
        .ok()
        .unwrap_or_else(|| tempdir().expect("temp dir"));
    let path = dir.path().join("bwrap");
    let mut writer = Command::new("/bin/sh")
        .args(["-c", r#"cat > "$1" && chmod 755 "$1""#, "sh"])
        .arg(&path)
        .stdin(Stdio::piped())
        .spawn()
        .expect("spawn fake bwrap writer");
    writer
        .stdin
        .take()
        .expect("writer stdin")
        .write_all(contents.as_bytes())
        .expect("write fake bwrap");
    assert!(writer.wait().expect("fake bwrap writer").success());
    FakeBwrap { path, _dir: dir }
}

fn write_named_fake_bwrap_in(dir: &Path) -> PathBuf {
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    let path = dir.join("bwrap");
    fs::write(&path, "#!/bin/sh\n").expect("write fake bwrap");
    let permissions = fs::Permissions::from_mode(0o755);
    fs::set_permissions(&path, permissions).expect("chmod fake bwrap");
    fs::canonicalize(path).expect("canonicalize fake bwrap")
}
