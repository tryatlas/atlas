//! Persistent per-project store of Claude Code plans.
//!
//! Every time the agent proposes a plan (the ExitPlanMode permission, which
//! carries `{ plan: "<markdown>" }`), the frontend captures it here together
//! with the user message that triggered it and a timestamp. The Plans panel
//! reads them back so the user can browse every plan ever made for the
//! project, across sessions.
//!
//! Stored as `<project>/.atlas/plans.json` — same simple atomic-write pattern
//! as `canvas.rs`.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRecord {
    /// Stable id (frontend-generated). Used for dedup + React keys.
    pub id: String,
    /// ACP session id the plan belongs to (also the JSONL transcript stem).
    #[serde(default)]
    pub session_id: Option<String>,
    /// Chat session title at capture time, for display.
    #[serde(default)]
    pub session_title: Option<String>,
    /// The user message that triggered the plan.
    pub user_message: String,
    /// The plan itself, as markdown.
    pub plan: String,
    /// ISO 8601 capture time (frontend clock — Rust avoids wall-clock here).
    pub timestamp: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PlansFile {
    #[serde(default)]
    pub plans: Vec<PlanRecord>,
}

fn plans_path(project_path: &str) -> std::path::PathBuf {
    atlas_profile::dir_in(Path::new(project_path)).join("plans.json")
}

fn read_plans(project_path: &str) -> Result<PlansFile, String> {
    let path = plans_path(project_path);
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| format!("read plans.json: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PlansFile::default()),
        Err(e) => Err(format!("read plans.json: {e}")),
    }
}

fn write_plans(project_path: &str, file: &PlansFile) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    atlas_fs::replace_file(plans_path(project_path), payload).map_err(|e| e.to_string())
}

/// Return every saved plan for the project, newest first.
#[tauri::command]
pub async fn plans_load(project_path: String) -> Result<Vec<PlanRecord>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<PlanRecord>, String> {
        let mut plans = read_plans(&project_path)?.plans;
        // Newest first — the panel shows most-recent plans at the top.
        plans.reverse();
        Ok(plans)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Append a plan, returning the full list (newest first). Idempotent: a plan
/// with the same `(session_id, plan)` content is not stored twice, so a
/// re-delivered permission can't create duplicates.
#[tauri::command]
pub async fn plans_append(
    project_path: String,
    record: PlanRecord,
) -> Result<Vec<PlanRecord>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<PlanRecord>, String> {
        static APPEND_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
        let _guard = APPEND_LOCK.lock();
        let mut file = read_plans(&project_path)?;
        let dup = file
            .plans
            .iter()
            .any(|p| p.session_id == record.session_id && p.plan == record.plan);
        if !dup {
            file.plans.push(record);
            write_plans(&project_path, &file)?;
        }
        let mut plans = file.plans;
        plans.reverse();
        Ok(plans)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(id: &str) -> PlanRecord {
        PlanRecord {
            id: id.to_string(),
            session_id: Some("session".to_string()),
            session_title: None,
            user_message: "do it".to_string(),
            plan: format!("# plan {id}"),
            timestamp: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    #[tokio::test]
    async fn a_damaged_plans_file_survives_an_append_and_can_be_repaired() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().to_string_lossy().to_string();
        let path = plans_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{ damaged").unwrap();
        assert!(plans_append(root.clone(), record("a")).await.is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ damaged");
        fs::write(&path, r#"{"plans":[]}"#).unwrap();
        assert_eq!(plans_append(root, record("a")).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn appended_plans_load_back_and_leave_only_their_file() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().to_string_lossy().to_string();

        // The first append is also the one that creates the profile directory.
        plans_append(root.clone(), record("a")).await.unwrap();
        plans_append(root.clone(), record("b")).await.unwrap();

        let ids: Vec<String> = plans_load(root)
            .await
            .unwrap()
            .into_iter()
            .map(|p| p.id)
            .collect();
        assert_eq!(ids, ["b", "a"], "newest first");
        assert_eq!(
            crate::commands::file_names_in(&atlas_profile::dir_in(project.path())),
            ["plans.json"]
        );
    }
}
