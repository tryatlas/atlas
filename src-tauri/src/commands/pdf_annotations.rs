//! Per-project persistence of editable PDF annotations (highlights, freehand,
//! notes). Stored as `<project>/.atlas/pdf-annotations.json` — a map keyed by
//! the PDF's absolute path → its annotations.
//!
//! Annotations are kept as editable data (NOT flattened into the PDF) so they
//! stay erasable/movable across sessions. Geometry is normalized (0..1) on the
//! frontend; this layer just persists the opaque JSON. Same atomic tmp+rename
//! pattern as `plans.rs`.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// Opaque per-annotation JSON — the frontend owns the schema (discriminated by
/// `kind`: highlight | pencil | note).
pub type Annotation = serde_json::Value;

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct PdfAnnotationsFile {
    #[serde(default, rename = "byPath")]
    pub by_path: HashMap<String, Vec<Annotation>>,
    #[serde(flatten)]
    extra: HashMap<String, serde_json::Value>,
}

// The file contains every PDF's annotations: serialize the entire read/change/write.
static WRITER: Mutex<()> = Mutex::new(());

fn annotations_path(project_path: &str) -> std::path::PathBuf {
    atlas_profile::dir_in(Path::new(project_path)).join("pdf-annotations.json")
}

fn read_all(project_path: &str) -> Result<PdfAnnotationsFile, String> {
    match fs::read_to_string(annotations_path(project_path)) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(PdfAnnotationsFile::default())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn write_all(project_path: &str, file: &PdfAnnotationsFile) -> Result<(), String> {
    let payload = serde_json::to_string(file).map_err(|e| e.to_string())?;
    atlas_fs::replace_file(annotations_path(project_path), payload).map_err(|e| e.to_string())
}

/// All annotations for one PDF (empty if none saved yet).
#[tauri::command]
pub async fn pdf_annotations_load(
    project_path: String,
    pdf_path: String,
) -> Result<Vec<Annotation>, String> {
    tokio::task::spawn_blocking(move || {
        Ok(read_all(&project_path)?
            .by_path
            .remove(&pdf_path)
            .unwrap_or_default())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Replace the annotation set for one PDF. An empty vec drops the entry so the
/// file doesn't accumulate keys for PDFs whose annotations were all erased.
#[tauri::command]
pub async fn pdf_annotations_save(
    project_path: String,
    pdf_path: String,
    annotations: Vec<Annotation>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let _writer = WRITER.lock().map_err(|error| error.to_string())?;
        let mut file = read_all(&project_path)?;
        if annotations.is_empty() {
            file.by_path.remove(&pdf_path);
        } else {
            file.by_path.insert(pdf_path, annotations);
        }
        write_all(&project_path, &file)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn saved_annotations_load_back_and_leave_only_their_file() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().to_string_lossy().to_string();
        let pdf = "/papers/a.pdf".to_string();
        let note = |text: &str| vec![serde_json::json!({ "kind": "note", "text": text })];

        // The first save is also the one that creates the profile directory.
        pdf_annotations_save(root.clone(), pdf.clone(), note("first"))
            .await
            .unwrap();
        pdf_annotations_save(root.clone(), pdf.clone(), note("second"))
            .await
            .unwrap();

        assert_eq!(
            pdf_annotations_load(root, pdf).await.unwrap(),
            note("second")
        );
        assert_eq!(
            crate::commands::file_names_in(&atlas_profile::dir_in(project.path())),
            ["pdf-annotations.json"]
        );
    }
    #[tokio::test]
    async fn concurrent_pdf_saves_preserve_every_document() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().to_string_lossy().into_owned();
        let mut jobs = tokio::task::JoinSet::new();
        for i in 0..32 {
            let root = root.clone();
            jobs.spawn(async move {
                pdf_annotations_save(
                    root,
                    format!("/{i}.pdf"),
                    vec![serde_json::json!({"id": i})],
                )
                .await
                .unwrap();
            });
        }
        while let Some(job) = jobs.join_next().await {
            job.unwrap();
        }
        assert_eq!(read_all(&root).unwrap().by_path.len(), 32);
    }

    #[tokio::test]
    async fn corrupt_annotation_storage_is_never_overwritten() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().to_string_lossy().into_owned();
        let path = annotations_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "broken annotations").unwrap();
        assert!(pdf_annotations_load(root.clone(), "/a.pdf".into())
            .await
            .is_err());
        assert!(pdf_annotations_save(root, "/a.pdf".into(), vec![])
            .await
            .is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "broken annotations");
    }
}
