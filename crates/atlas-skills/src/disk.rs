//! Disk helpers: durable writes, the symlink/copy that materializes a
//! projection, recursive copy, and the content hash used for drift detection.

use crate::paths::{canonical_skill_dir, skills_base};
use crate::registry::{tool_link_path, tool_skills_dir, ToolDef};
use std::fs;
use std::path::{Path, PathBuf};

// ── Disk helpers ───────────────────────────────────────────────────────────────

/// [`atlas_fs::replace_file`] in this module's error type.
pub(crate) fn atomic_write(path: &Path, payload: &str) -> Result<(), String> {
    atlas_fs::replace_file(path, payload).map_err(|e| e.to_string())
}

/// Compute the relative symlink target from a tool's skills dir up to the
/// canonical `<root>/.agents/skills/<name>`. Used only for `<root>`-relative dirs
/// (the common case). For env-relocated absolute dirs we fall back to an absolute
/// target via [`canonical_symlink_target`].
fn relative_symlink_target(skills_dir_rel: &Path, safe_name: &str) -> PathBuf {
    let up = "../".repeat(skills_dir_rel.components().count());
    PathBuf::from(format!("{up}.agents/skills/{safe_name}"))
}

/// Best symlink target for a projection: relative when the tool dir is under
/// `<root>` (keeps the link valid if the tree moves), absolute otherwise (env
/// override relocated the dir outside `<root>`).
fn canonical_symlink_target(root: &Path, def: &ToolDef, scope: &str, safe_name: &str) -> PathBuf {
    let dir = tool_skills_dir(def, scope, root);
    if let Ok(rel) = dir.strip_prefix(root) {
        relative_symlink_target(rel, safe_name)
    } else {
        skills_base(root).join(safe_name)
    }
}

/// Wipe whatever entry sits at the projection path (symlink/file/dir), so we can
/// re-materialize cleanly. Only ever the `<name>` entry inside the tool dir.
pub(crate) fn clear_entry(link: &Path) -> Result<(), String> {
    if let Ok(meta) = link.symlink_metadata() {
        if !meta.file_type().is_symlink() && meta.is_dir() {
            fs::remove_dir_all(link).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(link).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Create a relative symlink from the tool skills dir to the canonical skill.
/// Idempotent: a stale entry is removed first, then recreated.
pub(crate) fn create_symlink(
    root: &Path,
    def: &ToolDef,
    scope: &str,
    safe_name: &str,
) -> Result<(), String> {
    let link = tool_link_path(root, def, scope, safe_name);
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    clear_entry(&link)?;
    let target = canonical_symlink_target(root, def, scope, safe_name);
    symlink(&target, &link).map_err(|e| format!("symlink failed: {e}"))
}

/// Materialize a copy projection: recursively copy canonical → tool dir.
pub(crate) fn create_copy(
    root: &Path,
    def: &ToolDef,
    scope: &str,
    safe_name: &str,
) -> Result<(), String> {
    let canonical = canonical_skill_dir(&skills_base(root), safe_name)?;
    if !canonical.join("SKILL.md").is_file() {
        return Err(format!("canonical skill not found: {safe_name}"));
    }
    let link = tool_link_path(root, def, scope, safe_name);
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    copy_dir_all(&canonical, &link)
}

/// Remove a tool's projection for a skill (symlink or copy). Best-effort.
pub(crate) fn remove_symlink(
    root: &Path,
    def: &ToolDef,
    scope: &str,
    safe_name: &str,
) -> Result<(), String> {
    let link = tool_link_path(root, def, scope, safe_name);
    clear_entry(&link)
}

#[cfg(unix)]
pub(crate) fn symlink(target: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(target, link)
}

#[cfg(not(unix))]
pub(crate) fn symlink(_target: &Path, _link: &Path) -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "symlinks are only supported on unix in v1",
    ))
}

/// Build a replacement beside the destination before moving the existing
/// entry. Copy/validation failures leave the installed copy untouched.
pub(crate) fn replace_entry(
    dst: &Path,
    build: impl FnOnce(&Path) -> Result<(), String>,
) -> Result<(), String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let parent = dst.parent().ok_or("destination has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut staging = None;
    for _ in 0..64 {
        let serial = NEXT.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(".atlas-stage-{}-{serial}", std::process::id()));
        match fs::create_dir(&path) {
            Ok(()) => {
                staging = Some(path);
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    struct Cleanup {
        path: PathBuf,
        keep: bool,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            if !self.keep {
                let _ = fs::remove_dir_all(&self.path);
            }
        }
    }
    let mut staging = Cleanup {
        path: staging.ok_or("cannot reserve installation staging directory")?,
        keep: false,
    };
    let payload = staging.path.join("new");
    build(&payload)?;
    let backup = staging.path.join("previous");
    let existed = match dst.symlink_metadata() {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.to_string()),
    };
    if existed {
        fs::rename(dst, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(&payload, dst) {
        if existed {
            if let Err(restore) = fs::rename(&backup, dst) {
                staging.keep = true;
                return Err(format!("install failed: {error}; restore failed: {restore}; previous copy is preserved at {}", backup.display()));
            }
        }
        return Err(error.to_string());
    }
    Ok(())
}

/// Copy an entire tree, preserving internal directory and dangling symlinks
/// without following them. Links escaping the copied tree are refused before
/// any existing installation is replaced.
pub(crate) fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    replace_entry(dst, |staging| copy_tree(src, staging))
}

pub(crate) fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    let source_root = fs::canonicalize(src).map_err(|e| e.to_string())?;
    let parent = dst.parent().ok_or("copy destination has no parent")?;
    if fs::canonicalize(parent)
        .map_err(|e| e.to_string())?
        .starts_with(&source_root)
    {
        return Err("cannot copy a directory into itself".to_string());
    }
    copy_tree_inner(&source_root, &source_root, dst)
}

fn copy_tree_inner(root: &Path, src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_symlink() {
            let target = fs::read_link(&from).map_err(|e| e.to_string())?;
            // Absolute links encode the throwaway clone path and cannot be
            // preserved in a moved installation. Relative links stay valid.
            if target.is_absolute() {
                return Err(format!(
                    "absolute symlink cannot be installed: {}",
                    from.display()
                ));
            }
            let mut resolved = src.to_path_buf();
            for component in target.components() {
                match component {
                    std::path::Component::Normal(part) => resolved.push(part),
                    std::path::Component::ParentDir => {
                        resolved.pop();
                    }
                    std::path::Component::CurDir => {}
                    _ => return Err(format!("invalid symlink: {}", from.display())),
                }
            }
            if !resolved.starts_with(root) {
                return Err(format!(
                    "symlink escapes the installed tree: {}",
                    from.display()
                ));
            }
            // A link such as `alias/../private`, with `alias -> .`, can
            // escape even though its lexical spelling stays inside the tree.
            // Resolve the existing prefix too; a dangling final target is fine.
            let mut existing = src.join(&target);
            loop {
                match fs::canonicalize(&existing) {
                    Ok(resolved) if resolved.starts_with(root) => break,
                    Ok(_) => {
                        return Err(format!(
                            "symlink escapes the installed tree: {}",
                            from.display()
                        ));
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        if !existing.pop() {
                            return Err(format!("cannot resolve symlink: {}", from.display()));
                        }
                    }
                    Err(error) => return Err(error.to_string()),
                }
            }
            #[cfg(unix)]
            std::os::unix::fs::symlink(&target, &to).map_err(|e| e.to_string())?;
            #[cfg(windows)]
            {
                use std::os::windows::fs::FileTypeExt;
                if ty.is_symlink_dir() {
                    std::os::windows::fs::symlink_dir(&target, &to)
                } else {
                    std::os::windows::fs::symlink_file(&target, &to)
                }
                .map_err(|e| e.to_string())?;
            }
            #[cfg(not(any(unix, windows)))]
            return Err("symlink installation is unsupported on this platform".to_string());
        } else if ty.is_dir() {
            copy_tree_inner(root, &from, &to)?;
        } else if ty.is_file() {
            fs::copy(&from, &to).map_err(|e| e.to_string())?;
        } else {
            return Err(format!("unsupported entry in skill: {}", from.display()));
        }
    }
    Ok(())
}

// ── Content hashing (CP.3) ───────────────────────────────────────────────────────

/// Stable content hash of a skill directory for **change detection** (not
/// security). Walks every file under `dir` sorted by relative path and folds
/// `(relpath_bytes, 0x00, file_bytes)` into a 64-bit FNV-1a, returned as hex.
/// Missing dir → empty string (treated as "no content").
pub(crate) fn hash_skill_dir(dir: &Path) -> String {
    const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

    // Collect (relative-path, absolute-path) for every file, sorted by relpath.
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect_files(dir, dir, &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hash = FNV_OFFSET;
    let mut fold = |bytes: &[u8]| {
        for &b in bytes {
            hash ^= b as u64;
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    };
    for (rel, abs) in &files {
        fold(rel.as_bytes());
        fold(&[0x00]);
        if let Ok(target) = fs::read_link(abs) {
            fold(b"symlink\0");
            fold(target.to_string_lossy().as_bytes());
        } else if let Ok(bytes) = fs::read(abs) {
            fold(&bytes);
        }
    }
    format!("{hash:016x}")
}

/// Recursively gather files under `dir` as `(relative-to-base path, abs path)`.
/// Symlinks are not followed (only real files contribute to the hash).
fn collect_files(base: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = path.symlink_metadata() else {
            continue;
        };
        if meta.is_dir() && !meta.file_type().is_symlink() {
            collect_files(base, &path, out);
        } else if let Ok(rel) = path.strip_prefix(base) {
            out.push((rel.to_string_lossy().replace('\\', "/"), path));
        }
    }
}

#[cfg(test)]
mod replacement_tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn tree_copy_refuses_an_escape_through_an_internal_link() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let installed = root.path().join("installed");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&installed).unwrap();
        fs::write(installed.join("SKILL.md"), "local edits").unwrap();
        fs::write(root.path().join("private"), "private content").unwrap();
        std::os::unix::fs::symlink(".", source.join("alias")).unwrap();
        for target in ["alias/../private", "alias/../future"] {
            let link = source.join("escape");
            std::os::unix::fs::symlink(target, &link).unwrap();
            assert!(copy_dir_all(&source, &installed)
                .unwrap_err()
                .contains("symlink escapes"));
            assert_eq!(
                fs::read_to_string(installed.join("SKILL.md")).unwrap(),
                "local edits"
            );
            fs::remove_file(link).unwrap();
        }
    }

    #[test]
    fn a_failed_replacement_keeps_the_installed_tree() {
        let root = tempfile::tempdir().unwrap();
        let installed = root.path().join("installed");
        fs::create_dir(&installed).unwrap();
        fs::write(installed.join("SKILL.md"), "local edits").unwrap();
        let error = replace_entry(&installed, |staging| {
            fs::create_dir(staging).unwrap();
            fs::write(staging.join("SKILL.md"), "partial update").unwrap();
            Err("copy failed".to_string())
        });
        assert!(error.is_err());
        assert_eq!(
            fs::read_to_string(installed.join("SKILL.md")).unwrap(),
            "local edits"
        );
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn tree_copy_preserves_internal_directory_and_dangling_links() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir_all(source.join("scripts")).unwrap();
        fs::write(source.join("scripts/run.sh"), "echo ready").unwrap();
        std::os::unix::fs::symlink("scripts", source.join("bin")).unwrap();
        std::os::unix::fs::symlink("future", source.join("optional")).unwrap();
        let installed = root.path().join("installed");
        copy_dir_all(&source, &installed).unwrap();
        assert_eq!(
            fs::read_link(installed.join("bin")).unwrap(),
            Path::new("scripts")
        );
        assert_eq!(
            fs::read_link(installed.join("optional")).unwrap(),
            Path::new("future")
        );
        assert_eq!(
            fs::read_to_string(installed.join("bin/run.sh")).unwrap(),
            "echo ready"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_escaping_link_refuses_an_update_before_removing_the_old_copy() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let installed = root.path().join("installed");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&installed).unwrap();
        fs::write(installed.join("SKILL.md"), "keep this").unwrap();
        std::os::unix::fs::symlink("../private", source.join("escape")).unwrap();
        assert!(copy_dir_all(&source, &installed).is_err());
        assert_eq!(
            fs::read_to_string(installed.join("SKILL.md")).unwrap(),
            "keep this"
        );
    }
}
