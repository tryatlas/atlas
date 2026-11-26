//! Per-project "recently opened files" queue. Owned by Rust so it
//! persists across app restarts (in `<project>/.atlas/recent-files.json`)
//! and survives project switches without the frontend needing to
//! manage two stores.
//!
//! State machine:
//!   - `recent_files_open_project(path)` — load the on-disk list,
//!     swap in as the active project, return current items.
//!   - `recent_files_push(abs_path, rel)` — dedupe by abs_path,
//!     bump to head, cap at 20, save (debounced), emit
//!     `atlas:recent-files-changed`.
//!   - `recent_files_list()` — current snapshot.
//!   - `recent_files_clear()` — empty + save + emit.
//!
//! The frontend listens for the event and mirrors locally; the JS
//! `recent-files-store` is a thin cache that rehydrates from Rust on
//! project change, never the source of truth.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

/// Hard cap on the queue length. Matches the previous JS-side `CAP = 20`.
const QUEUE_CAP: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub abs_path: String,
    /// Path relative to the project root, e.g. `src/foo.ts`. This is
    /// what the picker displays.
    pub rel: String,
    /// Unix milliseconds of the most-recent open.
    pub touched_at: i64,
}

struct ProjectRecents {
    root: PathBuf,
    items: Arc<RwLock<Vec<RecentFile>>>,
}

#[derive(Default)]
pub struct RecentFilesState {
    /// One queue per open project (keyed by project id), so multiple
    /// resident projects each keep their own recent-files list.
    per_project: RwLock<HashMap<String, ProjectRecents>>,
}

impl RecentFilesState {
    pub fn new() -> Self {
        Self::default()
    }

    /// Clone the (root, items) handle for a project, if open.
    fn snapshot(&self, key: &str) -> Option<(PathBuf, Arc<RwLock<Vec<RecentFile>>>)> {
        self.per_project
            .read()
            .get(key)
            .map(|p| (p.root.clone(), p.items.clone()))
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn store_path(project_root: &Path) -> PathBuf {
    atlas_profile::dir_in(project_root).join("recent-files.json")
}

fn load_from_disk(project_root: &Path) -> Vec<RecentFile> {
    let path = store_path(project_root);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

/// Replaced whole, so a crash mid-write doesn't leave a torn JSON file.
fn save_to_disk(project_root: &Path, items: &[RecentFile]) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(items).map_err(|e| format!("serialize failed: {e}"))?;
    atlas_fs::replace_file(store_path(project_root), raw).map_err(|e| format!("write failed: {e}"))
}

/// Saves run on the blocking pool, so pushes in quick succession (the burst
/// at startup in #372) can save at the same time. Each lands a whole file,
/// but unserialized an older list can be the last one written.
static SAVE_LOCK: Mutex<()> = Mutex::new(());

/// Write the project's current list. The list is read under the save lock,
/// so whichever save runs last writes the newest state.
fn save_latest(project_root: &Path, items: &RwLock<Vec<RecentFile>>) -> Result<(), String> {
    let _guard = SAVE_LOCK.lock();
    let snapshot = items.read().clone();
    save_to_disk(project_root, &snapshot)
}

/// Best-effort: any error is logged and swallowed (the in-memory list is
/// still correct; the next save will retry the write).
fn persist(project_root: &Path, items: &RwLock<Vec<RecentFile>>) {
    if let Err(e) = save_latest(project_root, items) {
        tracing::warn!(target: "atlas::recent_files", "{e}");
    }
}

fn emit_changed(app: &AppHandle, workspace_id: &str, project_root: &Path, items: &[RecentFile]) {
    let _ = app.emit(
        "atlas:recent-files-changed",
        serde_json::json!({
            "workspaceId": workspace_id,
            "project": project_root.to_string_lossy(),
            "items": items,
        }),
    );
}

/// Open (or replace) the active project. Loads `<project>/.atlas/recent-files.json`,
/// makes it the current state, and returns the items so the caller
/// can hydrate the UI without waiting for the change event.
#[tauri::command]
pub async fn recent_files_open_project(
    project_path: String,
    workspace_id: Option<String>,
    state: State<'_, RecentFilesState>,
) -> Result<Vec<RecentFile>, String> {
    let key = workspace_id.unwrap_or_else(|| project_path.clone());
    let root = PathBuf::from(&project_path);
    // Idempotent: a resident project's queue is already loaded — return it.
    if let Some((_, items_lock)) = state.snapshot(&key) {
        return Ok(items_lock.read().clone());
    }
    let items = tokio::task::spawn_blocking(move || load_from_disk(&PathBuf::from(&project_path)))
        .await
        .map_err(|e| e.to_string())?;
    let items_arc = Arc::new(RwLock::new(items.clone()));
    state.per_project.write().insert(
        key,
        ProjectRecents {
            root,
            items: items_arc,
        },
    );
    Ok(items)
}

#[tauri::command(async)]
pub fn recent_files_close_project(
    workspace_id: Option<String>,
    state: State<'_, RecentFilesState>,
) {
    match workspace_id {
        Some(id) => {
            state.per_project.write().remove(&id);
        }
        None => state.per_project.write().clear(),
    }
}

/// Push a file onto the front of the queue. Dedupe by abs_path; cap
/// at `QUEUE_CAP`. Persists synchronously (cheap — the file is
/// tiny and writes are infrequent) and emits the change event.
///
/// Silently no-ops if no project is open or if the path doesn't
/// belong to the currently-active project (avoids cross-project
/// pollution during the brief window between switching projects
/// and the frontend dropping stale push intents).
#[tauri::command]
pub async fn recent_files_push(
    abs_path: String,
    rel: String,
    workspace_id: String,
    state: State<'_, RecentFilesState>,
    app: AppHandle,
) -> Result<Vec<RecentFile>, String> {
    let Some((root, items_lock)) = state.snapshot(&workspace_id) else {
        return Ok(Vec::new());
    };

    // Ignore pushes from outside the current project. Frontend tab
    // listeners can fire just after a project switch.
    if !Path::new(&abs_path).starts_with(&root) {
        return Ok(items_lock.read().clone());
    }

    let entry = RecentFile {
        abs_path: abs_path.clone(),
        rel,
        touched_at: now_ms(),
    };

    let updated: Vec<RecentFile> = {
        let mut w = items_lock.write();
        w.retain(|it| it.abs_path != abs_path);
        w.insert(0, entry);
        if w.len() > QUEUE_CAP {
            w.truncate(QUEUE_CAP);
        }
        w.clone()
    };

    let items_for_disk = items_lock;
    let root_for_disk = root.clone();
    tokio::task::spawn_blocking(move || persist(&root_for_disk, &items_for_disk));

    emit_changed(&app, &workspace_id, &root, &updated);
    Ok(updated)
}

/// Re-point recent-files entries after a rename/move so the picker shows the
/// new name instead of a stale one. Handles a single file (`abs_path == old`)
/// and a directory rename (entries under `old/` are re-prefixed to `new/`).
#[tauri::command]
pub async fn recent_files_rename(
    old_path: String,
    new_path: String,
    workspace_id: String,
    state: State<'_, RecentFilesState>,
    app: AppHandle,
) -> Result<Vec<RecentFile>, String> {
    let Some((root, items_lock)) = state.snapshot(&workspace_id) else {
        return Ok(Vec::new());
    };

    let rel_of = |abs: &str| {
        Path::new(abs)
            .strip_prefix(&root)
            .unwrap_or_else(|_| Path::new(abs))
            .components()
            .map(|c| c.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join("/")
    };
    let old_prefix = format!("{old_path}/");
    let new_prefix = format!("{new_path}/");

    let updated: Vec<RecentFile> = {
        let mut w = items_lock.write();
        for it in w.iter_mut() {
            if it.abs_path == old_path {
                it.abs_path = new_path.clone();
                it.rel = rel_of(&new_path);
            } else if it.abs_path.starts_with(&old_prefix) {
                let rest = it.abs_path[old_prefix.len()..].to_string();
                let np = format!("{new_prefix}{rest}");
                it.rel = rel_of(&np);
                it.abs_path = np;
            }
        }
        w.clone()
    };

    let items_for_disk = items_lock;
    let root_for_disk = root.clone();
    tokio::task::spawn_blocking(move || persist(&root_for_disk, &items_for_disk));
    emit_changed(&app, &workspace_id, &root, &updated);
    Ok(updated)
}

#[tauri::command]
pub async fn recent_files_clear(
    workspace_id: String,
    state: State<'_, RecentFilesState>,
    app: AppHandle,
) -> Result<(), String> {
    let Some((root, items_lock)) = state.snapshot(&workspace_id) else {
        return Ok(());
    };
    items_lock.write().clear();
    let items_for_disk = items_lock;
    let root_for_disk = root.clone();
    tokio::task::spawn_blocking(move || persist(&root_for_disk, &items_for_disk));
    emit_changed(&app, &workspace_id, &root, &[]);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(n: usize) -> RecentFile {
        RecentFile {
            abs_path: format!("/p/file-{n}.rs"),
            rel: format!("file-{n}.rs"),
            touched_at: n as i64,
        }
    }

    #[test]
    fn overlapping_saves_all_succeed_and_the_newest_list_wins() {
        // https://github.com/pacifio/atlas/issues/372: a burst of pushes saved
        // concurrently through the shared `.tmp` path, so some renames failed
        // with ENOENT.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let items = Arc::new(RwLock::new(Vec::new()));

        let handles: Vec<_> = (0..16)
            .map(|t| {
                let root = root.clone();
                let items = items.clone();
                std::thread::spawn(move || {
                    for i in 0..25 {
                        items.write().insert(0, entry(t * 100 + i));
                        save_latest(&root, &items).unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }

        let on_disk = load_from_disk(&root);
        let in_memory = items.read().clone();
        assert_eq!(on_disk.len(), in_memory.len());
        assert!(on_disk
            .iter()
            .zip(&in_memory)
            .all(|(a, b)| a.abs_path == b.abs_path));
        assert!(!store_path(&root).with_extension("json.tmp").exists());
    }

    /// A restart: the list a project had is the list it opens with. The row
    /// is taken apart with no `..`, so a field added to `RecentFile` does not
    /// compile until it is compared here.
    #[test]
    fn the_list_survives_a_restart_field_for_field() {
        let dir = tempfile::tempdir().unwrap();
        let saved = vec![
            RecentFile {
                abs_path: "/p/src/main.rs".into(),
                rel: "src/main.rs".into(),
                touched_at: 1_762_000_000_123,
            },
            RecentFile {
                abs_path: "/p/README.md".into(),
                rel: "README.md".into(),
                touched_at: 1_761_000_000_456,
            },
        ];

        save_to_disk(dir.path(), &saved).unwrap();
        let loaded = load_from_disk(dir.path());

        assert_eq!(loaded.len(), saved.len());
        for (got, want) in loaded.into_iter().zip(saved) {
            let RecentFile {
                abs_path,
                rel,
                touched_at,
            } = got;
            assert_eq!(abs_path, want.abs_path);
            assert_eq!(rel, want.rel);
            assert_eq!(touched_at, want.touched_at);
        }
    }

    /// What the file tolerates today: no file is an empty list, a key this
    /// build does not know is ignored, and one row missing a field empties
    /// the whole list (no field has a default).
    #[test]
    fn a_missing_file_an_unknown_key_and_a_short_row_load_as_they_do_today() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load_from_disk(dir.path()).is_empty());

        let path = store_path(dir.path());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            r#"[{ "absPath": "/p/a.rs", "rel": "a.rs", "touchedAt": 5, "pinned": true }]"#,
        )
        .unwrap();
        let loaded = load_from_disk(dir.path());
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].abs_path, "/p/a.rs");

        std::fs::write(
            &path,
            r#"[{ "absPath": "/p/a.rs", "rel": "a.rs", "touchedAt": 5 }, { "absPath": "/p/b.rs" }]"#,
        )
        .unwrap();
        assert!(load_from_disk(dir.path()).is_empty());
    }
}
