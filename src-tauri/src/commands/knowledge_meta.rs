//! Per-page knowledge metadata.
//!
//! Persists `Status / Owner / Tags / Created / Last edited / Icon / Cover`
//! for each `.atlas/knowledge/*.md` entry in a single project-scoped JSON
//! file:
//!
//!   <project>/.atlas/knowledge/_meta.json
//!
//! Shape:
//! ```json
//! {
//!   "version": 1,
//!   "pages": {
//!     "<entryId>": {
//!       "icon":       "🧠",
//!       "cover":      "covers/<id>.jpg" | "gradient:slate-1",
//!       "status":     "Draft",
//!       "tags":       ["agents", "runtime"],
//!       "owner":      "sayan",
//!       "created_at": "2026-05-25T...",
//!       "updated_at": "2026-05-25T..."
//!     }
//!   }
//! }
//! ```
//!
//! Each mutation reads, updates and atomically commits under one writer lock.
//! The command acknowledges only after persistence. Failed reads preserve the
//! original file and can be retried after repair.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use parking_lot::Mutex;
use serde::{Deserialize, Deserializer, Serialize};
use tauri::{AppHandle, Emitter, State};

/// Distinguish "field absent" from "field present and JSON null" when
/// deserializing into `Option<Option<T>>`:
///   - absent     → field default = `None`            (don't touch)
///   - `null`     → `Some(None)`                       (CLEAR the value)
///   - `"v"`      → `Some(Some("v"))`                  (SET the value)
///
/// Without this, serde's default Option deserializer collapses both
/// "absent" and "null" into `None`, so the patch can never clear a
/// field. (That bug was the actual cause of "remove cover doesn't
/// remove" — the optimistic UI showed null, but Rust's snapshot
/// silently kept the old value.)
fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Deserialize::deserialize(deserializer).map(Some)
}

/// The on-disk shape — bump `version` for future schema changes; the
/// loader rejects unknown versions rather than guessing.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KnowledgeMetaFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub pages: HashMap<String, PageMeta>,
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

fn default_version() -> u32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PageMeta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cover: Option<String>,
    /// User-chosen display title. Source of truth for the page header
    /// and the sidebar — replaces the previous "first `#` of body"
    /// derivation. Falls back to filename when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

/// Patch input — every field is optional so callers can update one
/// attribute at a time. Pass `Some(None)` (JS: `null`) to clear, or
/// omit a field to leave it untouched.
#[derive(Debug, Clone, Deserialize, Default)]
pub struct PageMetaPatch {
    #[serde(default, deserialize_with = "double_option")]
    pub icon: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub cover: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub title: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub status: Option<Option<String>>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub owner: Option<Option<String>>,
}

impl PageMetaPatch {
    fn apply(self, meta: &mut PageMeta) {
        if let Some(v) = self.icon {
            meta.icon = v;
        }
        if let Some(v) = self.cover {
            meta.cover = v;
        }
        if let Some(v) = self.title {
            meta.title = v;
        }
        if let Some(v) = self.status {
            meta.status = v;
        }
        if let Some(v) = self.tags {
            meta.tags = v;
        }
        if let Some(v) = self.owner {
            meta.owner = v;
        }
    }
}

#[derive(Default)]
pub struct KnowledgeMetaState {
    write_lock: Mutex<()>,
}

impl KnowledgeMetaState {
    pub fn new() -> Self {
        Self::default()
    }
}

fn meta_path(project_path: &str) -> PathBuf {
    atlas_profile::dir_in(Path::new(project_path))
        .join("knowledge")
        .join("_meta.json")
}

fn load_from_disk(project_path: &str) -> Result<KnowledgeMetaFile, String> {
    match fs::read_to_string(meta_path(project_path)) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("read _meta.json: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(KnowledgeMetaFile {
            version: 1,
            ..Default::default()
        }),
        Err(e) => Err(format!("read _meta.json: {e}")),
    }
}

fn write_to_disk(project_path: &str, file: &KnowledgeMetaFile) -> Result<(), String> {
    let body = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    atlas_fs::replace_file(meta_path(project_path), body).map_err(|e| e.to_string())
}

fn update_file<T>(
    state: &KnowledgeMetaState,
    project_path: &str,
    change: impl FnOnce(&mut KnowledgeMetaFile) -> T,
) -> Result<T, String> {
    let _guard = state.write_lock.lock();
    let mut snapshot = load_from_disk(project_path)?;
    if snapshot.version != 1 {
        return Err(
            "This version of _meta.json is read-only. Update Atlas before editing it.".into(),
        );
    }
    let result = change(&mut snapshot);
    write_to_disk(project_path, &snapshot)?;
    Ok(result)
}

#[tauri::command]
pub async fn knowledge_meta_load(
    project_path: String,
    state: State<'_, Arc<KnowledgeMetaState>>,
) -> Result<KnowledgeMetaFile, String> {
    let state = Arc::clone(state.inner());
    tokio::task::spawn_blocking(move || {
        let _guard = state.write_lock.lock();
        load_from_disk(&project_path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn knowledge_meta_patch(
    project_path: String,
    entry_id: String,
    patch: PageMetaPatch,
    state: State<'_, Arc<KnowledgeMetaState>>,
    app: AppHandle,
) -> Result<PageMeta, String> {
    let state = Arc::clone(state.inner());
    let path = project_path.clone();
    let updated = tokio::task::spawn_blocking(move || {
        update_file(&state, &path, |file| {
            let now = Utc::now().to_rfc3339();
            let entry = file.pages.entry(entry_id).or_default();
            if entry.created_at.is_none() {
                entry.created_at = Some(now.clone());
            }
            patch.apply(entry);
            entry.updated_at = Some(now);
            entry.clone()
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = app.emit(
        "atlas:knowledge:meta-changed",
        serde_json::json!({ "projectPath": project_path }),
    );
    Ok(updated)
}

#[tauri::command]
pub async fn knowledge_meta_delete(
    project_path: String,
    entry_id: String,
    state: State<'_, Arc<KnowledgeMetaState>>,
    app: AppHandle,
) -> Result<(), String> {
    let state = Arc::clone(state.inner());
    let path = project_path.clone();
    tokio::task::spawn_blocking(move || {
        update_file(&state, &path, |file| {
            file.pages.remove(&entry_id);
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    let _ = app.emit(
        "atlas:knowledge:meta-changed",
        serde_json::json!({ "projectPath": project_path }),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project() -> (tempfile::TempDir, String) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        (dir, path)
    }

    /// Compare one page's metadata a field at a time, with no `..`: a field
    /// added to `PageMeta` does not compile until it is compared here.
    fn assert_same_page(got: PageMeta, want: PageMeta) {
        let PageMeta {
            icon,
            cover,
            title,
            status,
            tags,
            owner,
            created_at,
            updated_at,
            extra,
        } = got;
        assert_eq!(icon, want.icon, "icon");
        assert_eq!(cover, want.cover, "cover");
        assert_eq!(title, want.title, "title");
        assert_eq!(status, want.status, "status");
        assert_eq!(tags, want.tags, "tags");
        assert_eq!(owner, want.owner, "owner");
        assert_eq!(created_at, want.created_at, "created_at");
        assert_eq!(updated_at, want.updated_at, "updated_at");
        assert_eq!(extra, want.extra, "unknown fields");
    }

    /// A restart: what was written for a page is what the next launch reads,
    /// for a page with every field set and for one with none.
    #[test]
    fn page_metadata_survives_a_restart_field_for_field() {
        let (_dir, path) = project();
        let full = PageMeta {
            icon: Some("🧠".into()),
            cover: Some("covers/abc.jpg".into()),
            title: Some("Agent runtime".into()),
            status: Some("Draft".into()),
            tags: vec!["agents".into(), "runtime".into()],
            owner: Some("sayan".into()),
            created_at: Some("2026-05-25T10:00:00+00:00".into()),
            updated_at: Some("2026-05-26T11:30:00+00:00".into()),
            ..Default::default()
        };
        let empty = PageMeta {
            icon: None,
            cover: None,
            title: None,
            status: None,
            tags: Vec::new(),
            owner: None,
            created_at: None,
            updated_at: None,
            ..Default::default()
        };
        let saved = KnowledgeMetaFile {
            version: 1,
            pages: HashMap::from([
                ("full".to_string(), full.clone()),
                ("empty".to_string(), empty.clone()),
            ]),
            ..Default::default()
        };

        write_to_disk(&path, &saved).unwrap();
        let KnowledgeMetaFile {
            version, mut pages, ..
        } = load_from_disk(&path).unwrap();

        assert_eq!(version, 1);
        assert_eq!(pages.len(), 2);
        assert_same_page(pages.remove("full").unwrap(), full);
        assert_same_page(pages.remove("empty").unwrap(), empty);
        assert!(!meta_path(&path).with_extension("json.tmp").exists());
    }

    #[test]
    fn invalid_files_survive_mutations_and_repair_is_seen_without_restart() {
        let (_dir, path) = project();
        let state = KnowledgeMetaState::new();
        assert_eq!(load_from_disk(&path).unwrap().version, 1);
        let file = meta_path(&path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        for original in ["{ not json", r#"{"version":2,"pages":{"a":{}}}"#] {
            fs::write(&file, original).unwrap();
            assert!(update_file(&state, &path, |data| {
                data.pages.clear();
            })
            .is_err());
            assert_eq!(fs::read_to_string(&file).unwrap(), original);
        }
        fs::write(
            &file,
            r#"{"pages":{"a":{"pinned":true},"b":{"title":"Retained"}},"future":42}"#,
        )
        .unwrap();
        update_file(&state, &path, |data| {
            data.pages.get_mut("a").unwrap().title = Some("Changed".into());
        })
        .unwrap();
        let restored = load_from_disk(&path).unwrap();
        assert_eq!(restored.pages["a"].title.as_deref(), Some("Changed"));
        assert_eq!(restored.pages["a"].extra["pinned"], true);
        assert_eq!(restored.pages["b"].title.as_deref(), Some("Retained"));
        assert_eq!(restored.extra["future"], 42);
    }
}
