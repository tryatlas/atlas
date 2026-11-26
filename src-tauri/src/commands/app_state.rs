//! Tauri command surface for the Rust-owned `AppState`.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use serde::Serialize;
use tauri::{AppHandle, Runtime, State};
use ts_rs::TS;

use crate::state::{
    AppSettings, AppState, AppStateHandle, AppStatePatch, AtlasConfigHandle, ConfigStatus,
};

/// Bootstrap response: `AppState` (projects/recents/orgs) plus the
/// `config.toml`-sourced settings snapshot, combined into one payload so the
/// frontend pays a single IPC round trip at boot. The two remain separately
/// stored/versioned on the Rust side — this struct exists only at the wire
/// boundary, matching the issue #64 design record's "bootstrap may combine
/// state and config for latency; they still don't share a source of truth".
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct BootstrapPayload {
    #[serde(flatten)]
    pub state: AppState,
    /// The settings' TypeScript is `settings:gen`'s, written from the same
    /// registry as the Rust struct, so the generated payload names that type
    /// instead of generating a second copy of it.
    #[ts(type = "import(\"../../features/settings/lib/app-settings\").AppSettings")]
    pub settings: AppSettings,
    pub config_generation: u64,
    /// Whether `config.toml` actually loaded. This is the ONLY signal the UI
    /// gets at boot that the file on disk is broken and the settings on
    /// screen are Atlas's defaults rather than the user's — computed since
    /// #64 but, until now, reachable only through `get_atlas_config_info`,
    /// which nothing called. A malformed config silently reverted every
    /// preference (`shareTelemetry` back to ON included) with no banner.
    pub config_status: ConfigStatus,
}

/// One-shot bootstrap: returns the full `AppState` snapshot plus the current
/// settings. Called by the frontend exactly once on app mount, before any UI
/// that depends on `currentProject` / `recentProjects` / settings renders.
#[tauri::command]
pub fn bootstrap_app_state(
    state: State<'_, AppStateHandle>,
    config: State<'_, AtlasConfigHandle>,
) -> BootstrapPayload {
    let config_guard = config.lock();
    let state = state.lock().clone();
    // `AppState::migrate` seeds a "Personal" org on every load path, and the
    // frontend refuses to create a project without one. If this ever fires
    // again, a load path has stopped migrating — see `AppState::from_raw`.
    if state.organisations.is_empty() {
        tracing::warn!(
            target: "atlas::app_state",
            "bootstrapping with zero organisations; the frontend cannot add a project"
        );
    }
    BootstrapPayload {
        state,
        settings: config_guard.effective().clone(),
        config_generation: config_guard.generation(),
        config_status: config_guard.status().clone(),
    }
}

/// Which data profile this process runs under (`atlas-profile`), for the few
/// places the window names it: the title says "Atlas Dev", and copy that
/// spells out a path says `.atlas-dev/`. The profile is the backend's to know
/// — it comes from the identifier the binary was built with — so the window
/// asks rather than guessing from its own build.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppProfile {
    pub dev: bool,
    pub product_name: &'static str,
    pub dir_name: &'static str,
}

#[tauri::command]
pub fn app_profile() -> AppProfile {
    let profile = atlas_profile::current();
    AppProfile {
        dev: profile.is_dev(),
        product_name: profile.product_name(),
        dir_name: profile.dir_name(),
    }
}

/// Orders the background writes of `state.json`.
///
/// Every save takes a ticket while it still holds the state lock, so ticket
/// order is snapshot order. The writes run on detached threads, which the OS
/// may schedule in any order; [`Self::write`] serializes them and drops a
/// write whose ticket is older than one already on disk, so an older snapshot
/// can never land after a newer one. [`Self::flush`] lets the quit path wait
/// for the newest ticket before the process exits.
pub struct OrderedSaves {
    issued: AtomicU64,
    /// The newest ticket whose write has finished (or was attempted).
    landed: Mutex<u64>,
    changed: Condvar,
}

impl OrderedSaves {
    pub const fn new() -> Self {
        Self {
            issued: AtomicU64::new(0),
            landed: parking_lot::const_mutex(0),
            changed: Condvar::new(),
        }
    }

    /// The next ticket. Take it under the same lock the snapshot is cloned
    /// under, so tickets and snapshots are ordered alike.
    pub fn ticket(&self) -> u64 {
        self.issued.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Run `write` for `ticket` unless a newer ticket already landed. Writes
    /// are serialized: the lock is held across `write`.
    pub fn write(&self, ticket: u64, write: impl FnOnce() -> std::io::Result<()>) {
        let mut landed = self.landed.lock();
        if ticket > *landed {
            if let Err(e) = write() {
                tracing::warn!(target: "atlas::app_state", "save failed: {e}");
            }
            *landed = ticket;
        }
        self.changed.notify_all();
    }

    /// Wait until every ticket issued so far has landed, or `timeout` passes.
    /// Returns whether it all landed.
    pub fn flush(&self, timeout: Duration) -> bool {
        let target = self.issued.load(Ordering::SeqCst);
        let deadline = Instant::now() + timeout;
        let mut landed = self.landed.lock();
        while *landed < target {
            if self.changed.wait_until(&mut landed, deadline).timed_out() {
                return *landed >= target;
            }
        }
        true
    }
}

impl Default for OrderedSaves {
    fn default() -> Self {
        Self::new()
    }
}

/// The process's `state.json` writes.
pub static APP_STATE_SAVES: OrderedSaves = OrderedSaves::new();

/// Called on the way out: wait (bounded) for the last `save_app_state` to
/// reach the disk, since its write runs on a detached thread the exit would
/// otherwise kill.
pub fn flush_app_state_saves() {
    if !APP_STATE_SAVES.flush(Duration::from_secs(2)) {
        tracing::warn!(target: "atlas::app_state", "quit before the last state save landed");
    }
}

/// Merge a frontend save into the in-memory snapshot and persist it to disk.
/// The disk write runs on a background thread so the IPC reply isn't blocked on
/// fsync — this command resolves as soon as the in-memory state is updated. For
/// the frontend's purposes, that's "saved" — the on-disk copy converges within
/// milliseconds and is only needed on the next app launch. The writes are
/// ordered through [`APP_STATE_SAVES`], and the quit path flushes them.
///
/// Takes an [`AppStatePatch`], **not** an `AppState`: the payload is a subset of
/// the wire shape the frontend already sends, and taking the narrower type is
/// what stops a settings save from wiping Rust-owned fields. See that type's
/// doc for the analytics bug this prevents.
#[tauri::command]
pub fn save_app_state<R: Runtime>(
    payload: AppStatePatch,
    state: State<'_, AppStateHandle>,
    app: AppHandle<R>,
) -> Result<(), String> {
    let (snapshot, ticket) = {
        let mut guard = state.lock();
        guard.apply_patch(payload);
        (guard.clone(), APP_STATE_SAVES.ticket())
    };
    std::thread::spawn(move || {
        APP_STATE_SAVES.write(ticket, || AppState::save(&app, &snapshot));
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// D6: two saves whose threads run in the opposite order. The older
    /// snapshot must not land after the newer one.
    #[test]
    fn an_older_save_never_lands_after_a_newer_one() {
        let saves = OrderedSaves::new();
        let disk = Mutex::new(String::new());
        let older = saves.ticket();
        let newer = saves.ticket();

        saves.write(newer, || {
            *disk.lock() = "newer".into();
            Ok(())
        });
        saves.write(older, || {
            *disk.lock() = "older".into();
            Ok(())
        });

        assert_eq!(*disk.lock(), "newer");
    }

    /// D6: the quit path waits for the pending write to finish.
    #[test]
    fn flush_waits_for_the_pending_write() {
        let saves = Arc::new(OrderedSaves::new());
        let disk = Arc::new(Mutex::new(String::new()));
        let ticket = saves.ticket();
        let writer = {
            let (saves, disk) = (saves.clone(), disk.clone());
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(100));
                saves.write(ticket, || {
                    *disk.lock() = "saved".into();
                    Ok(())
                });
            })
        };

        assert!(saves.flush(Duration::from_secs(5)));
        assert_eq!(*disk.lock(), "saved");
        writer.join().unwrap();
    }

    #[test]
    fn flush_gives_up_after_its_timeout() {
        let saves = OrderedSaves::new();
        let _never_written = saves.ticket();
        assert!(!saves.flush(Duration::from_millis(20)));
    }
}
