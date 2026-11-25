//! The activity log's on-disk half.
//!
//! Two files, and the split matters. A **project** log lives inside the project
//! (`<project>/.atlas/logs.jsonl`), so it is already scoped to exactly one
//! Organisation by construction — a project belongs to one. The **pinned** log
//! is the one that was global: a single `~/.atlas/log/pinned.jsonl` mixing every
//! org's kept entries into one list, which is what made the console a global
//! surface in an app whose every other surface is per-org.
//!
//! It is now `~/.atlas/log/orgs/<org>/pinned.jsonl`, with the legacy file
//! adopted by the first org that asks for it (see [`pinned_path`]) so nothing
//! anyone pinned before this change is lost.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Directory holding one org's log files.
fn org_log_dir(org: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let root = atlas_profile::dir_in(&home).join("log");
    // An org id is a UUID we minted, but it arrives from the renderer — so
    // treat it as untrusted and refuse anything that could climb out of the log
    // directory rather than trusting the caller.
    if org.is_empty() || org.contains(['/', '\\']) || org.contains("..") {
        return Err("invalid organization id".into());
    }
    Ok(root.join("orgs").join(org))
}

/// Where the pre-org global pinned log lived.
fn legacy_pinned_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    Ok(atlas_profile::dir_in(&home)
        .join("log")
        .join("pinned.jsonl"))
}

/// This org's pinned log, adopting the legacy global file if it has not been
/// claimed yet.
///
/// The adoption is a **move**, not a copy, and it is first-come: whichever org
/// is active the first time the console opens after upgrading inherits the old
/// pins. Copying into every org instead would duplicate each entry N times,
/// and dropping them would silently discard the one thing in this feature the
/// user explicitly asked to keep.
fn pinned_path(org: &str) -> Result<PathBuf, String> {
    let dir = org_log_dir(org)?;
    let path = dir.join("pinned.jsonl");
    if !path.exists() {
        if let Ok(legacy) = legacy_pinned_path() {
            if legacy.exists() {
                fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                // A failed rename is not fatal — the caller just starts empty.
                let _ = fs::rename(&legacy, &path);
            }
        }
    }
    Ok(path)
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Serializes this process's appends and trims: a trim reads the whole file
/// and replaces it, so an append landing between the two would be lost.
static LOG_WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Append `entry_json` as one line, in ONE `write_all` on an `O_APPEND` file.
/// `writeln!` made two writes (the entry, then the newline), and two
/// appenders interleaved between them into a line that parses as neither.
fn append_line(path: &Path, entry_json: &str) -> Result<(), String> {
    let mut line = entry_json.replace('\n', " ");
    line.push('\n');
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

/// Where a trim keeping about `keep` bytes of `content` starts: just past the
/// first newline at or after the byte offset, so the kept part opens on a
/// whole line. Searched as bytes, so an offset inside a multi-byte character
/// never panics; without a newline, the next character boundary.
fn trim_start(content: &str, keep: usize) -> usize {
    let from = content.len().saturating_sub(keep);
    match content.as_bytes()[from..].iter().position(|&b| b == b'\n') {
        Some(i) => from + i + 1,
        None => (from..=content.len())
            .find(|&i| content.is_char_boundary(i))
            .unwrap_or(content.len()),
    }
}

/// One Organisation's pinned entries. Empty for an org that has pinned nothing.
#[tauri::command]
pub async fn load_pinned_log(org: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let path = pinned_path(&org)?;
        if !path.exists() {
            return Ok(String::new());
        }
        fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn append_pinned_log(org: String, entry_json: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = pinned_path(&org)?;
        ensure_dir(&path)?;
        let _writes = LOG_WRITES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        append_line(&path, &entry_json)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Clear **this org's** pins only. Another Organisation's kept entries are a
/// different file and are not touched.
#[tauri::command]
pub async fn clear_pinned_log(org: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = pinned_path(&org)?;
        let _writes = LOG_WRITES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if path.exists() {
            fs::write(&path, "").map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn rewrite_pinned_log(org: String, entries_json: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = pinned_path(&org)?;
        let _writes = LOG_WRITES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // Caller passes the full body (each line one entry, newline separated).
        atlas_fs::replace_file(&path, &entries_json).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ── Project-scoped activity log ──────────────────────────────────────────────
//
// The Log view's full activity stream is persisted PER PROJECT at
// `<project>/.atlas/logs.jsonl` (one JSON entry per line) so it survives app
// restarts and never bleeds across projects. The file is soft-capped so a
// long-lived project can't grow it without bound.

/// Keep the project log under this many bytes (trimmed from the front).
const PROJECT_LOG_CAP_BYTES: u64 = 1024 * 1024; // 1 MB

fn project_log_path(project: &str) -> PathBuf {
    atlas_profile::dir_in(PathBuf::from(project)).join("logs.jsonl")
}

#[tauri::command]
pub async fn load_project_log(project: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let path = project_log_path(&project);
        if !path.exists() {
            return Ok(String::new());
        }
        fs::read_to_string(&path).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn append_project_log(project: String, entry_json: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = project_log_path(&project);
        ensure_dir(&path)?;
        let _writes = LOG_WRITES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        append_line(&path, &entry_json)?;
        // Soft-cap: if the file grew past the limit, keep the most recent bytes
        // starting at a line boundary.
        if let Ok(meta) = fs::metadata(&path) {
            if meta.len() > PROJECT_LOG_CAP_BYTES {
                if let Ok(content) = fs::read_to_string(&path) {
                    let start = trim_start(&content, (PROJECT_LOG_CAP_BYTES / 2) as usize);
                    let _ = atlas_fs::replace_file(&path, &content[start..]);
                }
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn clear_project_log(project: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let path = project_log_path(&project);
        let _writes = LOG_WRITES
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if path.exists() {
            fs::write(&path, "").map_err(|e| e.to_string())?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Past the cap the log is rewritten whole, from a line boundary.
    #[tokio::test]
    async fn an_oversized_project_log_is_trimmed_to_whole_lines() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().to_string_lossy().to_string();

        // The first append is also the one that creates the profile directory.
        append_project_log(root.clone(), r#"{"n":"first"}"#.into())
            .await
            .unwrap();
        let line = format!("{{\"pad\":\"{}\"}}\n", "x".repeat(1000));
        let filler = line.repeat(PROJECT_LOG_CAP_BYTES as usize / line.len() + 1);
        std::fs::write(project_log_path(&root), filler).unwrap();
        append_project_log(root.clone(), r#"{"n":"last"}"#.into())
            .await
            .unwrap();

        let log = load_project_log(root).await.unwrap();
        assert!(
            (log.len() as u64) < PROJECT_LOG_CAP_BYTES,
            "trimmed: {}",
            log.len()
        );
        let lines: Vec<&str> = log.lines().collect();
        assert!(lines[0].starts_with(r#"{"pad":"#), "starts on a line");
        assert_eq!(lines.last(), Some(&r#"{"n":"last"}"#));
        assert_eq!(
            crate::commands::file_names_in(&atlas_profile::dir_in(project.path())),
            ["logs.jsonl"]
        );
    }

    /// S1: the trim cut must land on a character boundary. A log of
    /// multi-byte characters used to panic slicing at a raw byte offset.
    #[tokio::test]
    async fn trimming_a_log_of_multi_byte_characters_does_not_panic() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().to_string_lossy().to_string();
        append_project_log(root.clone(), r#"{"n":"first"}"#.into())
            .await
            .unwrap();

        // One long line of two-byte characters, sized so the byte offset the
        // trim starts from falls inside one of them.
        let last = "{\"n\":\"last\"}\n";
        let mut filler = format!(
            "{{\"p\":\"{}\"}}\n",
            "é".repeat(PROJECT_LOG_CAP_BYTES as usize)
        );
        let keep_from = |filler: &str| {
            (filler.len() + last.len()).saturating_sub((PROJECT_LOG_CAP_BYTES / 2) as usize)
        };
        if filler.is_char_boundary(keep_from(&filler)) {
            // One byte after the run moves the cut by one within it.
            filler.insert(filler.len() - 1, ' ');
        }
        assert!(!filler.is_char_boundary(keep_from(&filler)));
        std::fs::write(project_log_path(&root), &filler).unwrap();

        append_project_log(root.clone(), r#"{"n":"last"}"#.into())
            .await
            .unwrap();

        let log = load_project_log(root).await.unwrap();
        assert!((log.len() as u64) < PROJECT_LOG_CAP_BYTES);
        assert!(log.ends_with(last));
    }

    /// S1: concurrent appends each land as one whole line. `writeln!` wrote
    /// the entry and its newline in two writes, so two appenders interleaved.
    #[tokio::test]
    async fn concurrent_appends_never_interleave() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().to_string_lossy().to_string();
        let entry = |i: usize| format!("{{\"n\":{i},\"pad\":\"{}\"}}", "x".repeat(2000));

        let mut jobs = tokio::task::JoinSet::new();
        for i in 0..200 {
            let root = root.clone();
            let line = entry(i);
            jobs.spawn(async move {
                append_project_log(root.clone(), line.clone())
                    .await
                    .unwrap();
            });
        }
        while let Some(job) = jobs.join_next().await {
            job.unwrap();
        }

        let log = load_project_log(root).await.unwrap();
        let lines: Vec<&str> = log.lines().collect();
        assert_eq!(lines.len(), 200, "lines merged or split");
        for line in lines {
            serde_json::from_str::<serde_json::Value>(line).expect("a torn line");
        }
    }

    #[tokio::test]
    async fn concurrent_pinned_appends_never_interleave() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pinned.jsonl");
        let mut jobs = tokio::task::JoinSet::new();
        for i in 0..200 {
            let path = path.clone();
            jobs.spawn_blocking(move || {
                append_line(
                    &path,
                    &format!("{{\"n\":{i},\"pad\":\"{}\"}}", "y".repeat(2000)),
                )
                .unwrap();
            });
        }
        while let Some(job) = jobs.join_next().await {
            job.unwrap();
        }
        let log = std::fs::read_to_string(&path).unwrap();
        assert_eq!(log.lines().count(), 200);
        for line in log.lines() {
            serde_json::from_str::<serde_json::Value>(line).expect("a torn line");
        }
    }
}
