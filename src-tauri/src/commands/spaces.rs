//! Realtime Spaces: the bridge between `atlas_comms::spaces` and the renderer.
//!
//! Same trust boundary as `commands::comms` — only Rust holds the Bearer, so
//! the renderer can neither dial the Space socket nor fetch its media. Frames
//! are shuttled opaquely (`atlas:spaces` window events); every codec decision
//! lives in the renderer, mirroring the web client.

use atlas_comms::spaces::{SpaceSummary, SpacesManager};
use tauri::{AppHandle, Manager};

use super::comms::{manager as comms_manager, map_err as map_comms_err, org as org_of};

/// The window event channel, one per subsystem like `atlas:comms`.
pub const SPACES_EVENT: &str = "atlas:spaces";

pub struct SpacesState(pub SpacesManager);

/// Ids reach URLs and filenames; hold them to their server shape so a
/// compromised renderer cannot splice `&`, `/` or `..` into a path or query
/// built around them. (Server ids are ULIDs / UUID-ish tokens.)
fn safe_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 128 {
        return Err("bad id".to_string());
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("bad id".to_string());
    }
    Ok(())
}

// Drafts share the local Yjs journal; this discriminator never enters a URL.
fn safe_page_id(id: &str) -> Result<(), String> {
    safe_id(id.strip_prefix("draft:").unwrap_or(id))
}

fn spaces(app: &AppHandle) -> Result<SpacesManager, String> {
    app.try_state::<SpacesState>()
        .map(|s| s.0.clone())
        .ok_or_else(|| "spaces is not ready".to_string())
}

/// The org + managers every command starts from. Spaces piggybacks on the chat
/// manager's active org — one source of truth for "which server org am I".
fn ctx(app: &AppHandle) -> Result<(SpacesManager, atlas_comms::CommsManager, String), String> {
    let sp = spaces(app)?;
    let mgr = comms_manager(app)?;
    let org = org_of(&mgr)?;
    Ok((sp, mgr, org))
}

fn check_scope(app: &AppHandle, account_id: &str, org_id: &str) -> Result<(), String> {
    safe_id(account_id)?;
    safe_id(org_id)?;
    let auth = app
        .try_state::<super::auth::AuthState>()
        .ok_or_else(|| "account is not ready".to_string())?;
    match auth.core().snapshot() {
        crate::auth::AuthSnapshot::SignedIn {
            user: Some(user),
            comms_org_id: Some(org),
            ..
        } if user.id == account_id && org == org_id => Ok(()),
        _ => Err("Space account changed; reconnect before replaying edits".into()),
    }
}

fn check_local_account(app: &AppHandle, account_id: &str, org_id: &str) -> Result<(), String> {
    safe_id(account_id)?;
    safe_id(org_id)?;
    let auth = app
        .try_state::<super::auth::AuthState>()
        .ok_or("account is not ready")?;
    match auth.core().snapshot() {
        crate::auth::AuthSnapshot::SignedIn {
            user: Some(user), ..
        } if user.id == account_id => Ok(()),
        _ => Err("Sign in to the account that owns these saved edits".into()),
    }
}

#[tauri::command]
pub async fn spaces_outbox_save_snapshot(
    app: AppHandle,
    account_id: String,
    org_id: String,
    conv_id: String,
    page_id: String,
    data: String,
) -> Result<(), String> {
    use base64::Engine;
    for id in [&account_id, &org_id, &conv_id] {
        safe_id(id)?;
    }
    safe_page_id(&page_id)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "bad base64".to_string())?;
    let mgr = comms_manager(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        mgr.with_store(|store| {
            store.save_space_snapshot(&account_id, &org_id, &conv_id, &page_id, &bytes)
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(map_comms_err)
}

#[tauri::command]
pub async fn spaces_outbox_snapshot(
    app: AppHandle,
    account_id: String,
    org_id: String,
    conv_id: String,
    page_id: String,
) -> Result<Option<Vec<u8>>, String> {
    check_local_account(&app, &account_id, &org_id)?;
    safe_id(&conv_id)?;
    safe_page_id(&page_id)?;
    let mgr = comms_manager(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        mgr.with_store(|store| store.load_space_snapshot(&account_id, &org_id, &conv_id, &page_id))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(map_comms_err)
}

pub(super) fn check_optional_scope(
    app: &AppHandle,
    account_id: Option<&str>,
    org_id: Option<&str>,
) -> Result<(), String> {
    match (account_id, org_id) {
        (Some(account), Some(org)) => check_scope(app, account, org),
        (None, None) => Ok(()),
        _ => Err("Space account and organization must be supplied together".into()),
    }
}

/// Journal before attempting the socket. The captured identity is retained
/// even if sign-out happened while the save was queued; this writes locally
/// and never transmits under a different account.
#[tauri::command]
pub async fn spaces_outbox_enqueue(
    app: AppHandle,
    account_id: String,
    org_id: String,
    conv_id: String,
    page_id: String,
    data: String,
) -> Result<i64, String> {
    use base64::Engine;
    for id in [&account_id, &org_id, &conv_id] {
        safe_id(id)?;
    }
    safe_page_id(&page_id)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "bad base64".to_string())?;
    let mgr = comms_manager(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        mgr.with_store(|store| {
            store.enqueue_space_update(&account_id, &org_id, &conv_id, &page_id, &bytes)
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(map_comms_err)
}

#[tauri::command]
pub async fn spaces_outbox_load(
    app: AppHandle,
    account_id: String,
    org_id: String,
    conv_id: String,
    page_id: String,
) -> Result<Vec<atlas_comms::store::SpaceOutboxEntry>, String> {
    check_local_account(&app, &account_id, &org_id)?;
    safe_id(&conv_id)?;
    safe_page_id(&page_id)?;
    let mgr = comms_manager(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        mgr.with_store(|store| store.load_space_updates(&account_id, &org_id, &conv_id, &page_id))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(map_comms_err)
}

/// Only a server snapshot that contains the queued update may acknowledge it.
/// A successful socket enqueue is deliberately insufficient.
#[tauri::command]
pub async fn spaces_outbox_acknowledge(
    app: AppHandle,
    account_id: String,
    org_id: String,
    conv_id: String,
    page_id: String,
    ids: Vec<i64>,
) -> Result<(), String> {
    check_scope(&app, &account_id, &org_id)?;
    safe_id(&conv_id)?;
    safe_page_id(&page_id)?;
    let mgr = comms_manager(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        mgr.with_store(|store| {
            store.acknowledge_space_updates(&account_id, &org_id, &conv_id, &page_id, &ids)
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(map_comms_err)
}

/// Open (or share) the socket for a conversation's Space.
#[tauri::command(async)]
pub async fn spaces_connect(app: AppHandle, conv_id: String) -> Result<(), String> {
    safe_id(&conv_id)?;
    let (sp, _, org) = ctx(&app)?;
    sp.connect(&org, &conv_id);
    Ok(())
}

#[tauri::command(async)]
pub async fn spaces_disconnect(app: AppHandle, conv_id: String) -> Result<(), String> {
    safe_id(&conv_id)?;
    spaces(&app)?.disconnect(&conv_id);
    Ok(())
}

/// The server's `error.detail.reconnect === true` instruction: drop the socket
/// and redial for fresh slots.
#[tauri::command(async)]
pub async fn spaces_cycle(app: AppHandle, conv_id: String) -> Result<(), String> {
    safe_id(&conv_id)?;
    spaces(&app)?.cycle(&conv_id);
    Ok(())
}

/// Send one JSON control frame, already built against the contract renderer-side.
#[tauri::command(async)]
pub async fn spaces_send_control(
    app: AppHandle,
    conv_id: String,
    frame: String,
    account_id: Option<String>,
    org_id: Option<String>,
) -> Result<(), String> {
    check_optional_scope(&app, account_id.as_deref(), org_id.as_deref())?;
    safe_id(&conv_id)?;
    spaces(&app)?.send_control(&conv_id, frame);
    Ok(())
}

/// Send one binary frame (base64). Updates and awareness both ride here.
#[tauri::command(async)]
pub async fn spaces_send_binary(
    app: AppHandle,
    conv_id: String,
    data: String,
    account_id: Option<String>,
    org_id: Option<String>,
) -> Result<(), String> {
    use base64::Engine;
    check_optional_scope(&app, account_id.as_deref(), org_id.as_deref())?;
    safe_id(&conv_id)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| "bad base64".to_string())?;
    spaces(&app)?
        .send_binary(&conv_id, bytes)
        .map_err(map_comms_err)
}

/// The REST pre-flight: creates the Space lazily and maps 401/403/404 to
/// refusals a UI can render — a failed WS handshake cannot say why.
#[tauri::command(async)]
pub async fn spaces_summary(app: AppHandle, conv_id: String) -> Result<SpaceSummary, String> {
    safe_id(&conv_id)?;
    let (_, mgr, org) = ctx(&app)?;
    mgr.rest()
        .space_summary(&org, &conv_id)
        .await
        .map_err(map_comms_err)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceMediaUploaded {
    pub content_hash: String,
    pub mime: String,
    pub media_kind: String,
    pub bytes: u64,
}

/// The contract's media allowlist — no SVG, deliberately; that absence is the
/// whole XSS defence for `inline` serving. Mime is derived from the extension
/// because no filename ever crosses the wire.
fn media_mime(path: &std::path::Path) -> Option<(&'static str, &'static str)> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => ("image/png", "image"),
        "jpg" | "jpeg" => ("image/jpeg", "image"),
        "gif" => ("image/gif", "image"),
        "webp" => ("image/webp", "image"),
        "mp4" => ("video/mp4", "video"),
        "webm" => ("video/webm", "video"),
        _ => return None,
    })
}

const SPACE_MEDIA_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Hash → reserve → deliver. `stored: true` on the reservation is dedup and
/// skips the PUT entirely. The caller adds the canvas node only after this
/// resolves — an upload failure must never leave a broken node in the doc.
#[tauri::command(async)]
pub async fn spaces_media_upload(
    app: AppHandle,
    conv_id: String,
    path: String,
) -> Result<SpaceMediaUploaded, String> {
    safe_id(&conv_id)?;
    let (_, mgr, org) = ctx(&app)?;
    let file = std::path::PathBuf::from(&path);
    let Some((mime, kind)) = media_mime(&file) else {
        return Err("unsupported media type".to_string());
    };
    // Size gate BEFORE the read: a 4GB .mp4 must be refused from metadata,
    // not loaded into RAM to be measured.
    let size_on_disk = tokio::fs::metadata(&file)
        .await
        .map_err(|e| e.to_string())?
        .len();
    if size_on_disk > SPACE_MEDIA_MAX_BYTES {
        return Err("file is larger than the 64 MiB media limit".to_string());
    }
    let bytes = tokio::fs::read(&file).await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 > SPACE_MEDIA_MAX_BYTES {
        return Err("file is larger than the 64 MiB media limit".to_string());
    }

    // Lowercase hex SHA-256 — the object's identity and the R2 write check.
    let content_hash = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        format!("{:x}", hasher.finalize())
    };

    let size = bytes.len() as u64;
    let reserved = mgr
        .rest()
        .space_media_reserve(&org, &conv_id, &content_hash, mime, size)
        .await
        .map_err(map_comms_err)?;
    if !reserved.stored {
        mgr.rest()
            .space_media_put(&org, &conv_id, &content_hash, mime, bytes)
            .await
            .map_err(map_comms_err)?;
    }

    Ok(SpaceMediaUploaded {
        content_hash,
        mime: mime.to_string(),
        media_kind: kind.to_string(),
        bytes: size,
    })
}

/// Ensure a media object is in the local cache and return its absolute path
/// for `convertFileSrc`. Cached by hash — the object is immutable, so the
/// web's ticket-renewal dance does not apply here.
#[tauri::command(async)]
pub async fn spaces_media_fetch(
    app: AppHandle,
    conv_id: String,
    content_hash: String,
    mime: String,
) -> Result<String, String> {
    safe_id(&conv_id)?;
    // The hash is the filename; hold it to its contract shape so it can never
    // be a path.
    if content_hash.len() != 64 || !content_hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("bad content hash".to_string());
    }
    let ext = match mime.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => "bin",
    };
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("spaces-media");
    let path = dir.join(format!("{content_hash}.{ext}"));
    if let Some(hit) = cache_lookup(dir.clone(), path.clone()).await? {
        return Ok(hit);
    }

    let (_, mgr, org) = ctx(&app)?;
    let bytes = mgr
        .rest()
        .space_media_download(&org, &conv_id, &content_hash)
        .await
        .map_err(map_comms_err)?;
    // The hash IS the object's identity, and this cache is immutable by
    // name — verify before the bytes become permanent, or a misbehaving
    // server poisons that hash's slot forever.
    let actual = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        format!("{:x}", hasher.finalize())
    };
    if actual != content_hash {
        return Err("media bytes did not match their content hash".to_string());
    }
    // A cache of a download: atomic, but not flushed to disk.
    cache_store(path, bytes, MEDIA_CACHE_MAX_BYTES).await
}

/// Byte ceiling for each download cache (`spaces-media`, `comms-attachments`).
/// Least-recently-used files go first once a write takes a cache past it.
pub(crate) const MEDIA_CACHE_MAX_BYTES: u64 = 512 * 1024 * 1024;

/// Look `path` up in the download cache `dir`, off the async runtime. A hit
/// has its mtime bumped so pruning treats it as recently used.
pub(crate) async fn cache_lookup(
    dir: std::path::PathBuf,
    path: std::path::PathBuf,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        if !atlas_fs::cache_file_present(&path) {
            return Ok(None);
        }
        touch(&path);
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write a downloaded file into its cache, off the async runtime, then prune
/// the cache back under `max_bytes`, sparing the file just written.
pub(crate) async fn cache_store(
    path: std::path::PathBuf,
    bytes: impl AsRef<[u8]> + Send + 'static,
    max_bytes: u64,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        atlas_fs::replace_cache_file(&path, bytes.as_ref()).map_err(|e| e.to_string())?;
        if let Some(dir) = path.parent() {
            prune_cache_dir(dir, max_bytes, &path);
        }
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn touch(path: &std::path::Path) {
    if let Ok(file) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = file.set_modified(std::time::SystemTime::now());
    }
}

/// Delete the oldest (by mtime) regular files in `dir` until what is left
/// totals at most `max_bytes`. `keep` is never deleted. Best effort: an entry
/// that cannot be read or removed is skipped. BLOCKING.
pub(crate) fn prune_cache_dir(dir: &std::path::Path, max_bytes: u64, keep: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, u64, std::path::PathBuf)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            if !meta.is_file() {
                return None;
            }
            let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            Some((modified, meta.len(), entry.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|(_, len, _)| *len).sum();
    if total <= max_bytes {
        return;
    }
    files.sort_by_key(|(modified, _, _)| *modified);
    for (_, len, path) in files {
        if total <= max_bytes {
            break;
        }
        if path == keep {
            continue;
        }
        if std::fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// R5: the download caches were never pruned. A write that takes one past
    /// its ceiling evicts the oldest files first, and never the new one.
    #[test]
    fn prune_evicts_oldest_first_and_spares_the_new_file() {
        let dir = std::env::temp_dir().join(format!("atlas-prune-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let base = std::time::SystemTime::now() - std::time::Duration::from_secs(1000);
        let mut paths = Vec::new();
        for (i, name) in ["a", "b", "c", "d"].iter().enumerate() {
            let p = dir.join(name);
            std::fs::write(&p, [0u8; 100]).unwrap();
            let f = std::fs::OpenOptions::new().write(true).open(&p).unwrap();
            f.set_modified(base + std::time::Duration::from_secs(i as u64 * 10))
                .unwrap();
            paths.push(p);
        }
        // `a` is the oldest but is the file just written: it must survive.
        prune_cache_dir(&dir, 250, &paths[0]);
        let left: Vec<bool> = paths.iter().map(|p| p.exists()).collect();
        assert_eq!(left, vec![true, false, false, true]);

        // Under the ceiling: nothing goes.
        prune_cache_dir(&dir, 10_000, &dir.join("none"));
        assert!(paths[0].exists() && paths[3].exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn media_mime_allowlist_matches_contract() {
        use std::path::Path;
        assert_eq!(media_mime(Path::new("a.PNG")), Some(("image/png", "image")));
        assert_eq!(
            media_mime(Path::new("a.jpeg")),
            Some(("image/jpeg", "image"))
        );
        assert_eq!(
            media_mime(Path::new("a.webm")),
            Some(("video/webm", "video"))
        );
        // SVG's absence is the defence, not an oversight.
        assert_eq!(media_mime(Path::new("a.svg")), None);
        assert_eq!(media_mime(Path::new("noext")), None);
    }
}
