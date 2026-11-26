use std::fs;
use std::path::Path;

const DEFAULT_EMPTY: &str =
    r#"{"version":2,"viewport":{"x":0,"y":0,"zoom":1},"nodes":[],"edges":[]}"#;

fn validate_canvas(raw: &str) -> Result<(), String> {
    use serde_json::Value;
    let value: Value = serde_json::from_str(raw).map_err(|e| format!("read canvas.json: {e}"))?;
    let board = |value: &Value| {
        let viewport = value.get("viewport").is_none_or(|viewport| {
            ["x", "y", "zoom"]
                .iter()
                .all(|key| viewport[*key].as_f64().is_some_and(f64::is_finite))
                && viewport["zoom"].as_f64().is_some_and(|zoom| zoom > 0.0)
        });
        value["nodes"]
            .as_array()
            .is_some_and(|nodes| nodes.iter().all(|node| node["id"].is_string()))
            && value.get("edges").is_none_or(|edges| {
                edges.as_array().is_some_and(|edges| {
                    edges.iter().all(|edge| {
                        ["id", "source", "target"]
                            .iter()
                            .all(|key| edge[*key].is_string())
                    })
                })
            })
            && viewport
    };
    let valid = match value.get("version").and_then(Value::as_u64) {
        Some(1..=3) => board(&value),
        None if value.get("version").is_none() => board(&value),
        Some(4) => (|| {
            let (Some(pages), Some(tree), Some(active)) = (
                value["pages"].as_array(),
                value["tree"].as_array(),
                value["activePageId"].as_str(),
            ) else {
                return false;
            };
            let page_ids: std::collections::HashSet<_> = pages
                .iter()
                .filter_map(|page| page["id"].as_str())
                .collect();
            let tree_ids: std::collections::HashSet<_> = tree
                .iter()
                .filter_map(|entry| entry["id"].as_str())
                .collect();
            !pages.is_empty()
                && page_ids.len() == pages.len()
                && tree_ids.len() == tree.len()
                && page_ids.contains(active)
                && pages.iter().all(|page| {
                    page["id"].as_str().is_some_and(|id| !id.is_empty())
                        && board(page)
                        && tree
                            .iter()
                            .any(|entry| entry["id"] == page["id"] && entry["kind"] == "page")
                })
                && tree.iter().all(|entry| {
                    entry["id"].is_string()
                        && entry["name"].is_string()
                        && (entry["parentId"].is_null() || entry["parentId"].is_string())
                        && entry["order"].as_f64().is_some_and(f64::is_finite)
                        && match entry["kind"].as_str() {
                            Some("folder") => true,
                            Some("page") => {
                                entry["id"].as_str().is_some_and(|id| page_ids.contains(id))
                            }
                            _ => false,
                        }
                })
        })(),
        _ => false,
    };
    if !valid {
        return Err(
            "canvas.json has an invalid or unsupported format. Repair it and reload before saving."
                .into(),
        );
    }
    Ok(())
}

fn read_canvas(path: &Path) -> Result<String, String> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => DEFAULT_EMPTY.into(),
        Err(e) => return Err(format!("read canvas.json: {e}")),
    };
    validate_canvas(&raw)?;
    Ok(raw)
}

#[tauri::command]
pub async fn load_canvas(project_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let path = atlas_profile::dir_in(Path::new(&project_path)).join("canvas.json");
        read_canvas(&path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn save_canvas(project_path: String, payload: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let final_path = atlas_profile::dir_in(Path::new(&project_path)).join("canvas.json");
        static WRITE_LOCK: parking_lot::Mutex<()> = parking_lot::Mutex::new(());
        let _guard = WRITE_LOCK.lock();
        validate_canvas(&payload)?;
        read_canvas(&final_path)?;
        // Replaced whole: no partial write on a crash.
        atlas_fs::replace_file(&final_path, &payload).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Copy a user-picked image/video into `.atlas/canvas-media/` and return its
/// relative filename (stored on the media node). Mirrors `knowledge_cover_upload`.
#[tauri::command]
pub async fn canvas_media_upload(project_path: String, src_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let src = Path::new(&src_path);
        if !src.exists() {
            return Err("source file not found".to_string());
        }
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_lowercase();
        // Unique flat name so two files with the same basename don't collide.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let rel = format!("media_{nanos}.{ext}");
        let dir = atlas_profile::dir_in(Path::new(&project_path)).join("canvas-media");
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        fs::copy(src, dir.join(&rel)).map_err(|e| e.to_string())?;
        Ok(rel)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read a canvas media file and return it as a `data:` URL (base64). Media lives
/// under `.atlas/`, which the asset protocol 403s, so we embed the bytes directly
/// (mirrors `knowledge_cover_data_url`). Handles images and video.
#[tauri::command]
pub async fn canvas_media_data_url(project_path: String, src: String) -> Result<String, String> {
    use base64::Engine;
    // Same class as the KB cover path: `src` was joined unvalidated, so
    // `../../../../.ssh/id_rsa` read any file the user can read and handed it
    // to the renderer as a data URL. A media name is a plain segment.
    if src.is_empty()
        || src.contains('/')
        || src.contains('\\')
        || src.contains("..")
        || Path::new(&src).is_absolute()
    {
        return Err("invalid media name".to_string());
    }
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let abs = atlas_profile::dir_in(Path::new(&project_path))
            .join("canvas-media")
            .join(&src);
        // A data URL is 4/3 the file, crosses IPC whole, and lives in the JS
        // heap for as long as the node renders. Canvas media above this wants
        // a real transport, not a bigger string.
        const MAX_MEDIA_BYTES: u64 = 20 * 1024 * 1024;
        let meta = fs::metadata(&abs).map_err(|e| e.to_string())?;
        if meta.len() > MAX_MEDIA_BYTES {
            return Err("media file is too large to inline (20MB max)".to_string());
        }
        let bytes = fs::read(&abs).map_err(|e| e.to_string())?;
        let mime = match abs
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_lowercase)
            .as_deref()
        {
            Some("png") => "image/png",
            Some("gif") => "image/gif",
            Some("webp") => "image/webp",
            Some("svg") => "image/svg+xml",
            Some("avif") => "image/avif",
            Some("jpg") | Some("jpeg") => "image/jpeg",
            Some("mp4") => "video/mp4",
            Some("webm") => "video/webm",
            Some("mov") => "video/quicktime",
            Some("m4v") => "video/x-m4v",
            _ => "application/octet-stream",
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        Ok(format!("data:{mime};base64,{b64}"))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod media_guard_tests {
    use super::canvas_media_data_url;

    fn project() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("atlas-canvas-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join(".atlas/canvas-media")).unwrap();
        dir
    }

    #[tokio::test]
    async fn a_plain_name_inlines_and_a_climb_is_refused() {
        let dir = project();
        std::fs::write(dir.join(".atlas/canvas-media/pic.png"), b"png!").unwrap();
        let root = dir.to_string_lossy().to_string();

        let ok = canvas_media_data_url(root.clone(), "pic.png".into())
            .await
            .unwrap();
        assert!(ok.starts_with("data:image/png;base64,"));

        // The audit shape: this used to read any file the user could.
        for bad in ["../../../../etc/hosts", "a/b.png", "/etc/hosts", ""] {
            assert!(
                canvas_media_data_url(root.clone(), bad.into())
                    .await
                    .is_err(),
                "{bad} must be refused"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn oversized_media_is_refused_not_inlined() {
        let dir = project();
        let big = vec![0u8; 21 * 1024 * 1024];
        std::fs::write(dir.join(".atlas/canvas-media/big.png"), &big).unwrap();
        let err = canvas_media_data_url(dir.to_string_lossy().into(), "big.png".into())
            .await
            .unwrap_err();
        assert!(err.contains("too large"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod save_tests {
    use super::{load_canvas, save_canvas};

    #[tokio::test]
    async fn a_failed_load_cannot_be_overwritten_by_a_default_canvas() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().to_string_lossy().to_string();
        let path = atlas_profile::dir_in(project.path()).join("canvas.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        for original in ["{ damaged", "null", r#"{"version":99,"pages":[]}"#] {
            std::fs::write(&path, original).unwrap();
            assert!(save_canvas(root.clone(), super::DEFAULT_EMPTY.into())
                .await
                .is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        }
        std::fs::write(&path, super::DEFAULT_EMPTY).unwrap();
        save_canvas(root.clone(), super::DEFAULT_EMPTY.into())
            .await
            .unwrap();
        assert_eq!(load_canvas(root).await.unwrap(), super::DEFAULT_EMPTY);
    }

    #[tokio::test]
    async fn a_saved_canvas_loads_back_and_leaves_only_its_file() {
        let project = tempfile::tempdir().unwrap();
        let root = project.path().to_string_lossy().to_string();

        // The first save is also the one that creates the profile directory.
        save_canvas(root.clone(), r#"{"nodes":[]}"#.into())
            .await
            .unwrap();
        save_canvas(root.clone(), r#"{"nodes":[{"id":"note"}]}"#.into())
            .await
            .unwrap();

        assert_eq!(
            load_canvas(root).await.unwrap(),
            r#"{"nodes":[{"id":"note"}]}"#
        );
        assert_eq!(
            crate::commands::file_names_in(&atlas_profile::dir_in(project.path())),
            ["canvas.json"]
        );
    }
}
