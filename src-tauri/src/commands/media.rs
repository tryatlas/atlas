//! Bounded, seekable loopback media for WebKitGTK, whose media stack cannot
//! play custom asset schemes. Each open has a random capability and an owned
//! file descriptor; close/window destruction revokes it and stops its server.

use std::{collections::HashMap, fs::File, sync::Arc};

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, Method, Response, StatusCode},
    routing::get,
    Router,
};
use serde::Serialize;
use tauri::Manager;
use tokio::sync::watch;

#[derive(Default)]
pub struct MediaState(parking_lot::Mutex<HashMap<String, Lease>>);

struct Lease {
    window: String,
    stop: watch::Sender<bool>,
}

impl Drop for Lease {
    fn drop(&mut self) {
        self.stop.send_replace(true);
    }
}

impl MediaState {
    pub fn drop_window(&self, window: &str) {
        self.0.lock().retain(|_, lease| lease.window != window);
    }
}

#[derive(Serialize)]
pub struct MediaHandle {
    url: String,
    token: String,
}

#[derive(Clone)]
struct StreamState {
    file: Arc<File>,
    length: u64,
    mime: &'static str,
    token: String,
    host: String,
    cancelled: watch::Receiver<bool>,
}

fn mime(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// Inclusive single range. Multiple ranges are refused, not expanded into
/// unbounded multipart buffers. No Range on an empty file is valid.
fn byte_range(range: Option<&str>, length: u64) -> Result<(u64, u64, bool), ()> {
    let Some(range) = range else {
        return Ok((0, length, false));
    };
    let range = range.strip_prefix("bytes=").ok_or(())?;
    let (start, end) = range.split_once('-').ok_or(())?;
    if length == 0 {
        return Err(());
    }
    let (start, end) = if start.is_empty() {
        let suffix = end.parse::<u64>().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        (length.saturating_sub(suffix), length - 1)
    } else {
        let start = start.parse::<u64>().map_err(|_| ())?;
        let end = if end.is_empty() {
            length - 1
        } else {
            end.parse::<u64>().map_err(|_| ())?.min(length - 1)
        };
        (start, end)
    };
    if start >= length || end < start {
        return Err(());
    }
    Ok((start, end - start + 1, true))
}

fn read_at(file: &File, bytes: &mut [u8], offset: u64) -> std::io::Result<usize> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_at(bytes, offset)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        file.seek_read(bytes, offset)
    }
}

async fn serve(
    State(state): State<StreamState>,
    Path(token): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> Response<Body> {
    if token != state.token || *state.cancelled.borrow() {
        return Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap();
    }
    // Prevent a non-loopback hostname from reaching this listener through DNS
    // rebinding. The capability is never included in logs or redirects.
    if headers.get(header::HOST).and_then(|v| v.to_str().ok()) != Some(state.host.as_str()) {
        return Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::empty())
            .unwrap();
    }
    let (start, count, partial) = match byte_range(
        headers.get(header::RANGE).and_then(|v| v.to_str().ok()),
        state.length,
    ) {
        Ok(range) => range,
        Err(()) => {
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{}", state.length))
                .body(Body::empty())
                .unwrap()
        }
    };
    let mut response = Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, state.mime)
        .header(header::CONTENT_LENGTH, count)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff");
    if partial {
        response = response.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{}/{}", start + count - 1, state.length),
        );
    }
    let body = if method == Method::HEAD || count == 0 {
        Body::empty()
    } else {
        Body::from_stream(futures::stream::try_unfold(
            (state, start, count),
            |(state, offset, left)| async move {
                if left == 0 || *state.cancelled.borrow() {
                    return Ok::<_, std::io::Error>(None);
                }
                let file = state.file.clone();
                let capacity = left.min(64 * 1024) as usize;
                let bytes = tokio::task::spawn_blocking(move || {
                    let mut bytes = vec![0; capacity];
                    let read = read_at(&file, &mut bytes, offset)?;
                    if read == 0 {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "media changed while reading",
                        ));
                    }
                    bytes.truncate(read);
                    Ok::<_, std::io::Error>(bytes)
                })
                .await
                .map_err(std::io::Error::other)??;
                let read = bytes.len() as u64;
                Ok(Some((bytes, (state, offset + read, left - read))))
            },
        ))
    };
    response.body(body).unwrap()
}

async fn open(
    file: File,
    length: u64,
    mime: &'static str,
) -> Result<(MediaHandle, watch::Sender<bool>), String> {
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|e| e.to_string())?;
    let host = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .to_string();
    let token = uuid::Uuid::new_v4().simple().to_string();
    let (stop, cancelled) = watch::channel(false);
    let state = StreamState {
        file: Arc::new(file),
        length,
        mime,
        token: token.clone(),
        host: host.clone(),
        cancelled: cancelled.clone(),
    };
    let router = Router::new()
        .route("/{token}", get(serve).head(serve))
        .with_state(state);
    tokio::spawn(async move {
        let mut cancelled = cancelled;
        let _ = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                if !*cancelled.borrow() {
                    let _ = cancelled.changed().await;
                }
            })
            .await;
    });
    Ok((
        MediaHandle {
            url: format!("http://{host}/{token}"),
            token,
        },
        stop,
    ))
}

#[tauri::command]
pub async fn media_open(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<MediaHandle, String> {
    let path = super::fs::resolve_media_file(&app, path).await?;
    let mime = mime(&path);
    let (file, length) = tokio::task::spawn_blocking(move || {
        let file = File::open(path).map_err(|e| e.to_string())?;
        let metadata = file.metadata().map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Err("media path must name a regular file".to_string());
        }
        Ok((file, metadata.len()))
    })
    .await
    .map_err(|e| e.to_string())??;
    let (handle, stop) = open(file, length, mime).await?;
    if app.get_webview_window(window.label()).is_none() {
        stop.send_replace(true);
        return Err("the media window closed".into());
    }
    app.state::<MediaState>().0.lock().insert(
        handle.token.clone(),
        Lease {
            window: window.label().to_string(),
            stop,
        },
    );
    Ok(handle)
}

#[tauri::command]
pub fn media_close(
    state: tauri::State<'_, MediaState>,
    window: tauri::WebviewWindow,
    token: String,
) {
    let mut leases = state.0.lock();
    if leases
        .get(&token)
        .is_some_and(|lease| lease.window == window.label())
    {
        leases.remove(&token);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn streams_seek_ranges_and_head_without_sharing_a_cursor() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("clip.webm");
        let bytes: Vec<u8> = (0..200_000).map(|n| (n % 251) as u8).collect();
        std::fs::write(&path, &bytes).unwrap();
        let (handle, stop) = open(File::open(path).unwrap(), bytes.len() as u64, "video/webm")
            .await
            .unwrap();
        let client = reqwest::Client::new();
        let head = client.head(&handle.url).send().await.unwrap();
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers()[header::CONTENT_LENGTH], "200000");
        assert!(head.bytes().await.unwrap().is_empty());
        let (a, b) = tokio::join!(
            client
                .get(&handle.url)
                .header(header::RANGE, "bytes=100-99999")
                .send(),
            client
                .get(&handle.url)
                .header(header::RANGE, "bytes=-80000")
                .send(),
        );
        let a = a.unwrap();
        assert_eq!(a.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(a.bytes().await.unwrap().as_ref(), &bytes[100..100_000]);
        assert_eq!(
            b.unwrap().bytes().await.unwrap().as_ref(),
            &bytes[120_000..]
        );
        assert_eq!(
            client
                .get(&handle.url)
                .header(header::RANGE, "bytes=200000-")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::RANGE_NOT_SATISFIABLE
        );
        assert_eq!(
            client
                .get(handle.url.replace(&handle.token, "wrong"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        stop.send_replace(true);
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        assert!(client.get(&handle.url).send().await.is_err());
    }
}
