//! Coordinate content persistence and optional running-agent confirmation
//! before every graceful exit. Repeated requests share the same barrier.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, Manager, State};

pub const QUIT_REQUESTED_EVENT: &str = "atlas:quit-requested";

#[derive(Default)]
pub struct QuitGuardState {
    /// The frontend's listener is installed, so a held quit gets an answer.
    ready: AtomicBool,
    /// A save/confirmation is already in progress.
    asking: AtomicBool,
    approved: AtomicBool,
    exit_code: std::sync::Mutex<i32>,
}

/// Whether to hold this user quit. `true` means the caller prevents the exit
/// and the frontend has been asked.
pub fn hold_quit(app: &AppHandle) -> bool {
    hold_exit(app, None)
}

pub fn request_quit(app: &AppHandle) {
    if !hold_quit(app) {
        app.exit(0);
    }
}

pub fn hold_exit(app: &AppHandle, code: Option<i32>) -> bool {
    let Some(guard) = app.try_state::<QuitGuardState>() else {
        return false;
    };
    if guard.approved.swap(false, Ordering::SeqCst) {
        return false;
    }
    if app.get_webview_window("main").is_none() || !guard.ready.load(Ordering::SeqCst) {
        return false;
    }
    if guard.asking.swap(true, Ordering::SeqCst) {
        return true;
    }
    *guard
        .exit_code
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = code.unwrap_or(0);
    if app.emit(QUIT_REQUESTED_EVENT, ()).is_err() {
        guard.asking.store(false, Ordering::SeqCst);
        return false;
    }
    true
}

/// The frontend's listener is installed.
#[tauri::command]
pub fn quit_guard_ready(guard: State<'_, QuitGuardState>) {
    guard.ready.store(true, Ordering::SeqCst);
}

/// The answer to [`QUIT_REQUESTED_EVENT`]: quit now, or stay.
#[tauri::command]
pub fn quit_guard_answer(app: AppHandle, guard: State<'_, QuitGuardState>, quit: bool) {
    guard.asking.store(false, Ordering::SeqCst);
    if quit {
        guard.approved.store(true, Ordering::SeqCst);
        let code = *guard
            .exit_code
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        app.exit(code);
    }
}
