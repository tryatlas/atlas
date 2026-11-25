//! `AppState` — the small Rust-owned struct that mirrors what `useProjectStore`
//! used to persist via zustand's localStorage middleware. Shape matches the
//! JS side via `#[serde(rename_all = "camelCase")]` so the frontend can use
//! the deserialized payload verbatim.
//!
//! The frontend's TypeScript for these structs is generated from them
//! (`app_state_bindings.rs` → `src/bindings/app-state/`): after changing a
//! field or a serde attribute here, run `bun run bindings:gen`.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};
use ts_rs::TS;

/// Current schema version. Bump and migrate (or reset) when fields change
/// shape. Older payloads with a smaller `version` are loadable as long as
/// the missing fields default to sensible values.
///
/// v2 introduced the multi-project model (`projects`/
/// `active_workspace_id`); `current_project` is retained only as a
/// migration source for v1 payloads.
///
/// v3 introduced the Organisation layer above projects
/// (`organisations`/`active_organisation_id`, plus `org_id` on each
/// project). v2 payloads are migrated by wrapping all existing
/// projects in a default local "Personal" org.
///
/// v4 removed `AppSettings` from this struct entirely (issue #64) — user
/// preferences live in their own validated `config.toml`
/// (`crate::state::atlas_config`).
pub const SCHEMA_VERSION: u32 = 4;

/// Just enough to name a project: the {name, path} pair the legacy v1
/// `current_project` field and the recents list carry. `Project` proper is
/// below.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub name: String,
    pub path: String,
    /// ISO-8601 timestamp; the frontend reads this verbatim.
    pub last_opened: String,
    /// The Organisation this was opened under.
    ///
    /// `None` on every entry written before recents were scoped. The frontend
    /// backfills those from the project list by path rather than showing them
    /// everywhere: orgs are the tenant boundary, and an unscoped recents list
    /// put one org's project names and absolute paths in front of every other
    /// org, one click away from being forked into the wrong one.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub org_id: Option<String>,
}

/// A single open project = one project plus its UI state identity. The
/// `id` is the stable key that replaces `webview.label()` everywhere Rust
/// state used to be keyed per-window (file index, git watcher, mention
/// cache, recent files).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    /// Owning Organisation. `None` on pre-v3 payloads — `migrate()` backfills
    /// it to the default org. The sidebar filters projects by the active org.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub org_id: Option<String>,
    /// Optional git remote. The ONLY field (besides id/name) that syncs to the
    /// server (`workspace_refs.git_url`) for one-click clone; the source tree
    /// itself never syncs. `None` for local-only projects.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub git_url: Option<String>,
    /// ISO-8601 timestamp of the last time this project was the active
    /// one; used to order the sidebar / pick a fallback on close.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub last_active_at: Option<String>,
}

/// A top-level tenant that owns a set of projects (the Linear "workspace
/// picker" model). Exactly one org is active per window. Local-only until the
/// user opts into sync per org (Chrome-profile model). The shape is a superset
/// of the server `organization` row so cloud sync is a thin adapter:
/// `{ id, name, slug, logo, metadata }` map to the server; the rest is local.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Organisation {
    pub id: String,
    pub name: String,
    /// URL-safe unique handle (server enforces a global unique index). Derived
    /// from `name` at create time; kept stable thereafter.
    pub slug: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub color: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub logo: Option<String>,
    /// ISO-8601 creation timestamp.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub created_at: Option<String>,
    /// Per-org memory of the last active project, so an org switch restores
    /// the user where they left off. Local-only (the server has no such notion).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub active_workspace_id: Option<String>,
    /// Opt-in cloud sync flag (Chrome-profile model). `false` = local-only.
    #[serde(default)]
    pub sync_enabled: bool,
    /// The server `organization.id` once this org has been linked via
    /// "Turn on sync". `None` while local-only. Reconciliation seam for the
    /// auth branch.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub remote_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    /// Legacy single-project field. Kept for migration from v1 `state.json`;
    /// the frontend now derives "current project" from
    /// `active_workspace_id`. New writes leave this `None`.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub current_project: Option<ProjectRef>,
    #[serde(default)]
    pub recent_projects: Vec<RecentProject>,
    /// STORAGE KEYS, not concepts: `workspaces` and `active_workspace_id` are
    /// what `state.json` has held since v2, so renaming them would need a data
    /// migration and break every existing install. These are projects.
    #[serde(default)]
    pub workspaces: Vec<Project>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub active_workspace_id: Option<String>,
    /// The Organisation layer above projects (v3). Each project is
    /// tagged with an `org_id`; the sidebar shows only the active org's set.
    #[serde(default)]
    pub organisations: Vec<Organisation>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub active_organisation_id: Option<String>,
    /// Stable anonymous id for opt-in product telemetry (PostHog `distinct_id`).
    /// Generated once on first launch (see `lib.rs` setup); never contains PII.
    /// `None` on old `state.json` files — backfilled + persisted at startup.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub telemetry_anon_id: Option<String>,
    #[serde(default = "default_version")]
    pub version: u32,
}

fn default_version() -> u32 {
    SCHEMA_VERSION
}

/// The slice of [`AppState`] the **frontend** is allowed to write.
///
/// Deliberately a distinct type. `save_app_state` used to take a whole
/// `AppState` and do `*guard = payload`, so every Rust-owned field was silently
/// destroyed by any settings change: the frontend's `buildAppStatePayload()`
/// never sent `telemetryAnonId`, it deserialized to `None`, persisted as null,
/// and the next launch minted a fresh id. One device became a new analytics
/// person on every settings save.
///
/// Listing the frontend-owned fields here — rather than special-casing the one
/// field that got bitten — means the next Rust-owned field added to `AppState`
/// is safe by construction instead of by remembering.
#[derive(Debug, Clone, PartialEq, Deserialize, TS)]
#[cfg_attr(test, derive(Serialize))]
#[serde(rename_all = "camelCase")]
pub struct AppStatePatch {
    #[serde(default)]
    pub recent_projects: Vec<RecentProject>,
    /// STORAGE KEYS, not concepts: `workspaces` and `active_workspace_id` are
    /// what `state.json` has held since v2, so renaming them would need a data
    /// migration and break every existing install. These are projects.
    #[serde(default)]
    pub workspaces: Vec<Project>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub active_workspace_id: Option<String>,
    #[serde(default)]
    pub organisations: Vec<Organisation>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub active_organisation_id: Option<String>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            current_project: None,
            recent_projects: Vec::new(),
            workspaces: Vec::new(),
            active_workspace_id: None,
            organisations: Vec::new(),
            active_organisation_id: None,
            telemetry_anon_id: None,
            version: SCHEMA_VERSION,
        }
    }
}

/// A globally-unique handle for the auto-created "Personal" organisation.
///
/// Every install creates one, so a fixed `"personal"` would collide for the
/// second person who ever turns on sync — the server's unique index on
/// `organization.slug` would reject it, and the failure would land on a user who
/// never chose the handle in the first place. Suffixing per-install entropy
/// makes the first sync of a default org always succeed.
///
/// The entropy is a **fresh random UUID**, deliberately not the telemetry
/// anon-id: a slug is public and leaves the machine, and the org's creation
/// time sits right next to it, so hashing that id with a timestamp would be
/// recomputable by anyone holding both — quietly linking an anonymous telemetry
/// profile to a named account. Random bytes give the same uniqueness and cannot
/// correlate to anything.
fn default_personal_slug() -> String {
    use sha2::{Digest, Sha256};
    use std::time::{SystemTime, UNIX_EPOCH};

    let entropy = uuid::Uuid::new_v4();
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let digest = Sha256::digest(format!("{entropy}:{millis}").as_bytes());
    // 5 bytes = 10 hex chars (~2^40). The handle stays typeable, and the space
    // is far beyond anything a birthday collision reaches in practice.
    let short: String = digest.iter().take(5).map(|b| format!("{b:02x}")).collect();
    format!("personal-{short}")
}

impl AppState {
    /// Migrate a freshly-deserialized older payload in place. Idempotent —
    /// re-running on an already-migrated state is a no-op.
    ///
    /// v1 → v2: if no projects exist yet but a legacy `current_project` is
    /// present, synthesize a single project from it and make it active.
    ///
    /// v2 → v3: if no organisations exist yet, wrap every project in a
    /// default local "Personal" org and make it active.
    fn migrate(&mut self) {
        if self.workspaces.is_empty() {
            if let Some(project) = self.current_project.take() {
                let id = uuid::Uuid::new_v4().to_string();
                self.active_workspace_id = Some(id.clone());
                self.workspaces.push(Project {
                    id,
                    name: project.name,
                    path: project.path,
                    org_id: None,
                    git_url: None,
                    last_active_at: None,
                });
            }
        }
        self.current_project = None;

        // v2 → v3: ensure a default Organisation owns all existing projects.
        if self.organisations.is_empty() {
            let org_id = uuid::Uuid::new_v4().to_string();
            self.organisations.push(Organisation {
                id: org_id.clone(),
                name: "Personal".to_string(),
                slug: default_personal_slug(),
                color: None,
                logo: None,
                created_at: None,
                active_workspace_id: self.active_workspace_id.clone(),
                sync_enabled: false,
                remote_id: None,
            });
            self.active_organisation_id = Some(org_id);
        }

        // Repair installs created before the handle carried entropy: their
        // default org still holds the literal `"personal"`, which is exactly
        // the collision above avoids. Safe to rewrite only while the org is
        // UNSYNCED — once `remote_id` is set the server owns that handle and
        // it is not ours to change. Narrowed to the untouched auto-created
        // default (name AND slug both still the originals) so a handle the
        // user deliberately typed is never silently swapped underneath them.
        for org in &mut self.organisations {
            if org.remote_id.is_none() && org.name == "Personal" && org.slug == "personal" {
                org.slug = default_personal_slug();
            }
        }

        // Backfill org ownership on any untagged project (covers both
        // the fresh migration above and stray untagged entries — the frontend
        // can mint `org_id: null` rows during a boot race, and every render
        // surface filters strictly by org, so an untagged row would otherwise
        // be invisible in one org and leak into all of them). When no active
        // org is set, fall back to the first org rather than leaving rows
        // untagged forever.
        let default_org = self
            .active_organisation_id
            .clone()
            .or_else(|| self.organisations.first().map(|o| o.id.clone()));
        if let Some(default_org) = default_org {
            let mut backfilled = 0usize;
            for ws in &mut self.workspaces {
                if ws.org_id.is_none() {
                    ws.org_id = Some(default_org.clone());
                    backfilled += 1;
                }
            }
            if backfilled > 0 {
                tracing::info!(
                    count = backfilled,
                    default_org = %default_org,
                    "backfilled org_id on untagged projects"
                );
            }
        }

        self.version = SCHEMA_VERSION;
    }
}

/// Thread-safe handle registered as Tauri managed state.
pub type AppStateHandle = Arc<Mutex<AppState>>;

impl AppState {
    /// Apply a frontend save, preserving every Rust-owned field.
    ///
    /// The counterpart to [`AppStatePatch`]: what is absent from the patch is
    /// absent because Rust owns it, and stays untouched here.
    pub fn apply_patch(&mut self, p: AppStatePatch) {
        // Legacy v1 field — the frontend derives the current project from
        // `active_workspace_id`, and the patch has no key for this one.
        // Never re-adopted.
        self.current_project = None;
        self.recent_projects = p.recent_projects;
        self.workspaces = p.workspaces;
        self.active_workspace_id = p.active_workspace_id;
        self.organisations = p.organisations;
        self.active_organisation_id = p.active_organisation_id;
        self.version = SCHEMA_VERSION;
        // `telemetry_anon_id` (and anything Rust adds later) is deliberately
        // NOT assigned here. See the `AppStatePatch` doc.
    }

    /// `<app_data_dir>/state.json`. Returns `None` if the data dir can't be
    /// resolved (no $HOME / no `APPDATA`, etc.) — caller falls back to
    /// `AppState::default()`.
    fn path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
        app.path().app_data_dir().ok().map(|d| d.join("state.json"))
    }

    /// Read from disk synchronously. Designed to be called from `setup()`
    /// before the webview opens — the cost is one `fs::read_to_string` of a
    /// few-KB JSON file (~1 ms on warm cache). Falls back to `Self::default()`
    /// on any I/O or parse failure so a corrupt file never blocks app launch —
    /// and, like every other input, that fallback is still migrated (see
    /// [`Self::from_raw`]).
    ///
    /// Also returns the raw `settings` object, if any, exactly as it appeared
    /// in the file — the typed `AppState` no longer has a `settings` field
    /// (issue #64) so `serde_json` would otherwise silently drop it on the
    /// floor as an unrecognized key. The caller feeds this to
    /// `atlas_config::bootstrap` for the one-time `config.toml` export.
    pub fn load<R: Runtime>(app: &AppHandle<R>) -> Self {
        match Self::path(app) {
            Some(path) => Self::load_at(&path),
            None => Self::from_raw(None),
        }
    }

    /// [`Self::load`] for a known path, so the read is reachable without an
    /// `AppHandle`.
    ///
    /// A `state.json` that exists but cannot be read or parsed is moved aside
    /// to `state.json.corrupt-<ms>` (see [`set_aside_corrupt`]) before the
    /// defaults are returned. The setup-time save writes those defaults back
    /// to `state.json` moments later, so without the move every project and
    /// organisation in the file would be overwritten with no trace.
    fn load_at(path: &Path) -> Self {
        let raw = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Self::from_raw(None),
            Err(e) => {
                tracing::error!("state.json at {} unreadable: {e}", path.display());
                set_aside_corrupt(path, None);
                return Self::from_raw(None);
            }
        };
        let parsed = std::str::from_utf8(&raw)
            .map_err(|e| e.to_string())
            .and_then(|text| serde_json::from_str::<AppState>(text).map_err(|e| e.to_string()));
        match parsed {
            Ok(mut state) => {
                state.migrate();
                state
            }
            Err(e) => {
                tracing::error!("state.json at {} does not parse: {e}", path.display());
                set_aside_corrupt(path, Some(&raw));
                Self::from_raw(None)
            }
        }
    }

    /// The parse+migrate half of [`Self::load`], split out so it is reachable
    /// without an `AppHandle`.
    ///
    /// `None` is a FIRST RUN (no `state.json` yet, or no resolvable app data
    /// dir) and MUST still migrate. `load` used to return `Self::default()`
    /// straight from its early returns, which skipped `migrate()` and left
    /// `organisations` empty on a fresh install — the one input every other
    /// path seeds a "Personal" org for. The frontend filters every render
    /// surface by the active org and refuses to create a project without
    /// one, so the visible symptom was "Open Folder" picking a directory and
    /// doing nothing at all until the second launch, by which point the
    /// boot-time save in `setup()` had written a `state.json` for this path
    /// to parse and migrate.
    fn from_raw(raw: Option<&str>) -> Self {
        let mut state: AppState = raw
            .map(|raw| serde_json::from_str(raw).unwrap_or_default())
            .unwrap_or_default();
        state.migrate();
        state
    }

    /// Merge `state` over whatever `state.json` already holds, rather than
    /// replacing the file wholesale.
    ///
    /// Merging keeps any key another build of Atlas writes, for exactly the
    /// reason `config.toml` patches preserve unknown TOML keys. The keys
    /// Atlas itself retired are dropped: `settings` (now `config.toml`) and
    /// its `settingsConfigMigrated` marker, so `state.json` carries no stale
    /// shadow of the settings, and `groups`, the project folders the sidebar
    /// no longer has.
    fn merged_for_save(path: &Path, state: &AppState) -> serde_json::Result<serde_json::Value> {
        let existing = match std::fs::read(path) {
            Ok(bytes) => Some(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
            Err(e) => {
                // Unreadable is not "absent": writing over it would destroy
                // whatever it holds, so the save fails instead.
                return Err(serde_json::Error::io(e));
            }
        };
        let parsed = existing.as_deref().and_then(|bytes| {
            serde_json::from_slice::<serde_json::Value>(bytes)
                .ok()
                .filter(serde_json::Value::is_object)
        });
        if let (Some(bytes), None) = (existing.as_deref(), parsed.as_ref()) {
            // Not a JSON object: keep it before the merge replaces it.
            tracing::error!(
                "state.json at {} is not a JSON object; setting it aside",
                path.display()
            );
            set_aside_corrupt(path, Some(bytes));
        }
        let mut merged =
            parsed.unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()));

        let fresh = serde_json::to_value(state)?;
        if let (Some(dst), Some(src)) = (merged.as_object_mut(), fresh.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
            dst.remove("settings");
            dst.remove("settingsConfigMigrated");
            dst.remove("groups");
        }
        Ok(merged)
    }

    /// Atomic write — a uniquely-named temp file then `rename`, so a crash
    /// mid-write can never leave a torn JSON file behind.
    ///
    /// The temp name carries a UUID rather than being the fixed
    /// `state.json.tmp`: saves overlap in practice (the boot-time telemetry-id
    /// write against the frontend's debounced flush), and
    /// two of them sharing one temp path can interleave into exactly the torn
    /// file the rename is supposed to prevent. That matters more since
    /// [`Self::merged_for_save`] made this a read-modify-write, and a torn
    /// `state.json` loses every project. `sync_all` before the rename is what
    /// makes the atomicity
    /// real — otherwise the rename can reach disk ahead of its bytes.
    pub fn save<R: Runtime>(app: &AppHandle<R>, state: &AppState) -> std::io::Result<()> {
        let Some(path) = Self::path(app) else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "could not resolve app_data_dir",
            ));
        };
        Self::save_at(&path, state)
    }

    /// [`Self::save`] for a known path, so the write is reachable without an
    /// `AppHandle`.
    fn save_at(path: &Path, state: &AppState) -> std::io::Result<()> {
        let merged = Self::merged_for_save(path, state)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
        let raw = serde_json::to_string_pretty(&merged)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
        atlas_fs::replace_file(path, raw)
    }
}

/// Move an unusable `state.json` aside to `state.json.corrupt-<ms>`, next to
/// it, so the next save cannot overwrite the only copy of the user's projects.
///
/// A rename is atomic and keeps the file byte for byte. When it fails (a
/// filesystem that refuses it) and the bytes are in hand, they are written to
/// the backup name through `atlas_fs::replace_file` instead, which is atomic
/// too. Returns the backup path, or `None` when neither worked; every outcome
/// is logged.
fn set_aside_corrupt(path: &Path, bytes: Option<&[u8]>) -> Option<PathBuf> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis());
    let name = path
        .file_name()
        .map_or_else(|| "state.json".into(), |n| n.to_string_lossy().into_owned());
    let mut backup = path.with_file_name(format!("{name}.corrupt-{now}"));
    let mut n = 1;
    while backup.exists() {
        backup = path.with_file_name(format!("{name}.corrupt-{now}-{n}"));
        n += 1;
    }
    match std::fs::rename(path, &backup) {
        Ok(()) => {
            tracing::warn!("kept the unusable state file as {}", backup.display());
            return Some(backup);
        }
        Err(e) => tracing::warn!("could not move {} aside: {e}", path.display()),
    }
    match bytes.map(|bytes| atlas_fs::replace_file(&backup, bytes)) {
        Some(Ok(())) => {
            tracing::warn!("copied the unusable state file to {}", backup.display());
            Some(backup)
        }
        Some(Err(e)) => {
            tracing::error!("could not back up {}: {e}", path.display());
            None
        }
        None => None,
    }
}

/// The values the round-trip tests, the bindings fixtures and the frontend's
/// restart test are all built from.
///
/// Every struct is written as a literal with no `..Default::default()`, on
/// purpose: a field added to one of them does not compile here until it is
/// given a value, so it cannot skip the round trip.
#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;

    /// Every field holds a value that is not its default, bar the two the
    /// load path itself decides: `current_project`, which `migrate` always
    /// clears, and `version`, which it always sets.
    pub(crate) fn full_state() -> AppState {
        AppState {
            current_project: None,
            recent_projects: vec![
                RecentProject {
                    name: "atlas".into(),
                    path: "/Users/dev/atlas".into(),
                    last_opened: "2026-11-02T09:30:00.000Z".into(),
                    org_id: Some("org-1".into()),
                },
                RecentProject {
                    name: "server".into(),
                    path: "/Users/dev/server".into(),
                    last_opened: "2026-10-28T17:05:00.000Z".into(),
                    org_id: Some("org-2".into()),
                },
            ],
            workspaces: vec![
                Project {
                    id: "ws-1".into(),
                    name: "atlas".into(),
                    path: "/Users/dev/atlas".into(),
                    org_id: Some("org-1".into()),
                    git_url: Some("git@example.com:dev/atlas.git".into()),
                    last_active_at: Some("2026-11-02T09:30:00.000Z".into()),
                },
                Project {
                    id: "ws-2".into(),
                    name: "server".into(),
                    path: "/Users/dev/server".into(),
                    org_id: Some("org-2".into()),
                    git_url: Some("https://example.com/dev/server.git".into()),
                    last_active_at: Some("2026-10-28T17:05:00.000Z".into()),
                },
            ],
            active_workspace_id: Some("ws-1".into()),
            organisations: vec![
                Organisation {
                    id: "org-1".into(),
                    name: "Personal".into(),
                    slug: "personal-0a1b2c3d4e".into(),
                    color: Some("#3366ff".into()),
                    logo: Some("data:image/png;base64,AAAA".into()),
                    created_at: Some("2026-01-15T08:00:00.000Z".into()),
                    active_workspace_id: Some("ws-1".into()),
                    sync_enabled: false,
                    remote_id: None,
                },
                Organisation {
                    id: "org-2".into(),
                    name: "Northwind".into(),
                    slug: "northwind".into(),
                    color: Some("#ff6633".into()),
                    logo: Some("https://example.com/northwind.png".into()),
                    created_at: Some("2026-03-20T12:00:00.000Z".into()),
                    active_workspace_id: Some("ws-2".into()),
                    sync_enabled: true,
                    remote_id: Some("srv-org-2".into()),
                },
            ],
            active_organisation_id: Some("org-1".into()),
            telemetry_anon_id: Some("5b0c6c1e-7a52-4f0e-9d0b-3a8a3f1f2c11".into()),
            version: SCHEMA_VERSION,
        }
    }

    /// The least a migrated state can hold: one organisation, and every
    /// optional field empty. What it serializes to is how an absent value
    /// crosses the wire (`null`, or a missing key).
    pub(crate) fn minimal_state() -> AppState {
        AppState {
            current_project: None,
            recent_projects: vec![RecentProject {
                name: "atlas".into(),
                path: "/Users/dev/atlas".into(),
                last_opened: "2026-11-02T09:30:00.000Z".into(),
                org_id: None,
            }],
            workspaces: vec![Project {
                id: "ws-1".into(),
                name: "atlas".into(),
                path: "/Users/dev/atlas".into(),
                org_id: Some("org-1".into()),
                git_url: None,
                last_active_at: None,
            }],
            active_workspace_id: None,
            organisations: vec![Organisation {
                id: "org-1".into(),
                name: "Personal".into(),
                slug: "personal-0a1b2c3d4e".into(),
                color: None,
                logo: None,
                created_at: None,
                active_workspace_id: None,
                sync_enabled: false,
                remote_id: None,
            }],
            active_organisation_id: Some("org-1".into()),
            telemetry_anon_id: None,
            version: SCHEMA_VERSION,
        }
    }

    /// The save the frontend sends for `state`: every field it owns.
    pub(crate) fn patch_of(state: &AppState) -> AppStatePatch {
        AppStatePatch {
            recent_projects: state.recent_projects.clone(),
            workspaces: state.workspaces.clone(),
            active_workspace_id: state.active_workspace_id.clone(),
            organisations: state.organisations.clone(),
            active_organisation_id: state.active_organisation_id.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A `state.json` path in its own temp directory. Keep the `TempDir` alive
    /// for the test: dropping it deletes the directory.
    fn tmp_state_path() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        (dir, path)
    }

    fn state_file_with_legacy_settings(path: &Path) {
        std::fs::write(
            path,
            serde_json::json!({
                "version": 1,
                "recentProjects": [],
                "settings": { "enterToSend": false, "gitBlameInline": false },
            })
            .to_string(),
        )
        .unwrap();
    }

    /// Settings live in `config.toml`; a save drops the copy an older build
    /// left in `state.json` rather than carrying a stale shadow forever.
    #[test]
    fn a_save_drops_the_retired_settings_object() {
        let (_dir, path) = tmp_state_path();
        state_file_with_legacy_settings(&path);

        let merged = AppState::merged_for_save(&path, &AppState::default()).unwrap();

        assert!(merged.get("settings").is_none());
        assert!(merged.get("settingsConfigMigrated").is_none());
    }

    /// Merging must not resurrect stale values for keys the struct owns — the
    /// fresh state always wins on its own fields.
    #[test]
    fn merging_lets_the_live_state_win_on_its_own_fields() {
        let (_dir, path) = tmp_state_path();
        std::fs::write(
            &path,
            serde_json::json!({ "version": 1, "recentProjects": [
                { "name": "old", "path": "/old", "lastOpened": "then" }
            ]})
            .to_string(),
        )
        .unwrap();

        let merged = AppState::merged_for_save(&path, &AppState::default()).unwrap();

        assert_eq!(merged["recentProjects"], serde_json::json!([]));
    }

    /// Exactly the payload `buildAppStatePayload()` sends — note the absence of
    /// `telemetryAnonId`, which is the whole point.
    ///
    /// `activeWorkspaceId` is the FROZEN wire key (see `AppStatePatch`): the
    /// rename to "project" stopped at the storage boundary. This fixture used
    /// to say `activeProjectId`, which `AppStatePatch` — no
    /// `deny_unknown_fields` — silently dropped, so every assertion below ran
    /// against a field the frontend had never actually set.
    fn frontend_payload() -> AppStatePatch {
        serde_json::from_value(serde_json::json!({
            "recentProjects": [],
            "workspaces": [],
            "activeWorkspaceId": "proj-1",
            "organisations": [],
            "activeOrganisationId": null,
        }))
        .expect("frontend payload deserializes as a patch")
    }

    /// Guards the fixture itself: if the frozen key is ever mistyped again, the
    /// payload deserializes to `None` and this fails instead of passing quietly.
    #[test]
    fn frontend_payload_carries_the_frozen_active_project_key() {
        assert_eq!(
            frontend_payload().active_workspace_id.as_deref(),
            Some("proj-1")
        );
    }

    /// The same freeze, one level down. `Organisation::active_workspace_id` is
    /// a NESTED storage key inside the `organisations` array, which the
    /// workspace→project rename missed: the frontend sent `activeProjectId`,
    /// serde dropped it (no `deny_unknown_fields`, `#[serde(default)]`), and
    /// `apply_patch` committed `None` over every org's last-active project.
    /// The frontend now translates at the seam (`organisations/types.ts`
    /// `toOrganisationWire`); this asserts what it must translate *to*.
    #[test]
    fn an_organisation_carries_the_frozen_nested_active_project_key() {
        let org: Organisation = serde_json::from_value(serde_json::json!({
            "id": "org-1",
            "name": "Personal",
            "slug": "personal",
            "activeWorkspaceId": "proj-1",
            "syncEnabled": false,
        }))
        .expect("wire organisation deserializes");
        assert_eq!(org.active_workspace_id.as_deref(), Some("proj-1"));

        // …and the app-side spelling is exactly the silent drop being guarded.
        let renamed: Organisation = serde_json::from_value(serde_json::json!({
            "id": "org-1",
            "name": "Personal",
            "slug": "personal",
            "activeProjectId": "proj-1",
            "syncEnabled": false,
        }))
        .expect("an unknown key is not an error — that is the whole problem");
        assert_eq!(renamed.active_workspace_id, None);
    }

    /// The project folders are gone from the sidebar, and so is their key: a
    /// save drops the `groups` an older build left in `state.json`.
    #[test]
    fn a_save_drops_the_retired_groups_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(
            &path,
            r#"{ "groups": [{ "id": "g1", "name": "g" }], "recentProjects": [] }"#,
        )
        .unwrap();

        let merged = AppState::merged_for_save(&path, &AppState::default()).unwrap();

        assert!(merged.get("groups").is_none());
    }

    /// The regression test for the analytics bug: a settings save must not cost
    /// the install its telemetry identity. Before `AppStatePatch`, `save_app_state`
    /// did `*guard = payload` and this id became `None` on every settings change,
    /// so the next launch minted a new PostHog person.
    #[test]
    fn apply_patch_preserves_telemetry_anon_id() {
        let mut state = AppState {
            telemetry_anon_id: Some("device-uuid".into()),
            ..AppState::default()
        };

        state.apply_patch(frontend_payload());

        assert_eq!(state.telemetry_anon_id.as_deref(), Some("device-uuid"));
    }

    /// A first run — no `state.json` on disk — must come up with the default
    /// Organisation, exactly like a parsed file with none does. Without one
    /// the frontend's `requireActiveOrgId()` is `undefined`, `addProject`
    /// bails with a log line and no UI feedback, and "Open Folder" picks a
    /// directory and silently does nothing until the app is relaunched.
    #[test]
    fn a_first_run_still_gets_the_default_organisation() {
        let state = AppState::from_raw(None);

        assert_eq!(
            state.organisations.len(),
            1,
            "no default org on a fresh install"
        );
        assert_eq!(state.organisations[0].name, "Personal");
        assert_eq!(
            state.active_organisation_id.as_deref(),
            Some(state.organisations[0].id.as_str()),
            "default org exists but nothing is active"
        );
        assert_eq!(state.version, SCHEMA_VERSION);
    }

    /// A present-but-unreadable `state.json` takes the same fallback and is
    /// migrated the same way: the two inputs must never diverge again.
    #[test]
    fn a_corrupt_state_file_still_gets_the_default_organisation() {
        let state = AppState::from_raw(Some("{ not json"));

        assert_eq!(state.organisations.len(), 1);
        assert_eq!(state.organisations[0].name, "Personal");
        assert!(state.active_organisation_id.is_some());
    }

    fn corrupt_backups(dir: &Path) -> Vec<PathBuf> {
        let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| {
                p.file_name()
                    .is_some_and(|n| n.to_string_lossy().starts_with("state.json.corrupt-"))
            })
            .collect();
        found.sort();
        found
    }

    /// D2: a `state.json` that does not parse is kept, byte for byte, before
    /// the boot-time save writes defaults over `state.json`.
    #[test]
    fn a_corrupt_state_file_is_kept_before_the_boot_save_overwrites_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let corrupt = r#"{"recentProjects": [ {"name": "precious""#;
        std::fs::write(&path, corrupt).unwrap();

        let loaded = AppState::load_at(&path);
        assert_eq!(loaded.organisations.len(), 1, "defaults still load");
        AppState::save_at(&path, &loaded).unwrap();

        let backups = corrupt_backups(dir.path());
        assert_eq!(backups.len(), 1, "no corrupt backup next to state.json");
        assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), corrupt);
        assert!(AppState::load_at(&path).organisations.len() == 1);
    }

    /// D2: valid JSON that is not an object is kept by the merge too, rather
    /// than silently replaced.
    #[test]
    fn a_non_object_state_file_is_kept_before_a_save_replaces_it() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        std::fs::write(&path, "[1, 2, 3]").unwrap();

        AppState::save_at(&path, &AppState::default()).unwrap();

        let backups = corrupt_backups(dir.path());
        assert_eq!(backups.len(), 1);
        assert_eq!(std::fs::read_to_string(&backups[0]).unwrap(), "[1, 2, 3]");
    }

    /// A missing file is a first run, not corruption: nothing is set aside.
    #[test]
    fn a_missing_state_file_leaves_no_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("state.json");
        let loaded = AppState::load_at(&path);
        AppState::save_at(&path, &loaded).unwrap();
        assert!(corrupt_backups(dir.path()).is_empty());
    }

    /// A patch with unknown/extra keys (an older or newer frontend) still parses,
    /// and absent keys fall back to their defaults rather than failing the save.
    #[test]
    fn patch_tolerates_partial_payloads() {
        let patch: AppStatePatch =
            serde_json::from_value(serde_json::json!({ "recentProjects": [] }))
                .expect("partial payload");
        let mut state = AppState {
            telemetry_anon_id: Some("keep-me".into()),
            ..AppState::default()
        };
        state.apply_patch(patch);
        assert_eq!(state.telemetry_anon_id.as_deref(), Some("keep-me"));
        assert_eq!(state.version, SCHEMA_VERSION);
    }

    /// `AppState` no longer has a `settings` field at all (issue #64) — user
    /// preferences live in `config.toml` now. A `state.json` written by an
    /// older Atlas build still carries a `settings` object; `serde_json`
    /// silently drops unrecognized keys for structs without
    /// `deny_unknown_fields`, so this must parse cleanly and leave every other
    /// field intact rather than erroring or resetting anything.
    #[test]
    fn a_legacy_settings_key_in_state_json_does_not_break_parsing() {
        let state: AppState = serde_json::from_value(serde_json::json!({
            "settings": { "disabledBuiltinAgents": ["kilo"], "enterToSend": false },
            "recentProjects": [
                { "name": "demo", "path": "/tmp/demo", "lastOpened": "2024-01-01T00:00:00Z" }
            ],
        }))
        .expect("an older state file parses even with the retired settings key present");
        assert_eq!(state.recent_projects.len(), 1);
    }

    // ── A restart: what is saved is what loads ─────────────────────────────

    /// Compare two states one field at a time. Both are taken apart with no
    /// `..`, so a field added to `AppState` does not compile until it is
    /// compared here.
    fn assert_same_state(loaded: AppState, expected: AppState) {
        let AppState {
            current_project,
            recent_projects,
            workspaces,
            active_workspace_id,
            organisations,
            active_organisation_id,
            telemetry_anon_id,
            version,
        } = loaded;
        assert_eq!(current_project, expected.current_project, "currentProject");
        assert_eq!(recent_projects, expected.recent_projects, "recentProjects");
        assert_eq!(workspaces, expected.workspaces, "workspaces");
        assert_eq!(
            active_workspace_id, expected.active_workspace_id,
            "activeWorkspaceId"
        );
        assert_eq!(organisations, expected.organisations, "organisations");
        assert_eq!(
            active_organisation_id, expected.active_organisation_id,
            "activeOrganisationId"
        );
        assert_eq!(
            telemetry_anon_id, expected.telemetry_anon_id,
            "telemetryAnonId"
        );
        assert_eq!(version, expected.version, "version");
    }

    fn fixture(name: &str) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src/state/fixtures")
            .join(name);
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
    }

    /// Save through `save_at`, then load through `load_at` as the next launch
    /// does. Nothing is dropped, renamed or reset on the way.
    #[test]
    fn a_fully_populated_state_survives_a_restart() {
        let (_dir, path) = tmp_state_path();
        let saved = fixtures::full_state();

        AppState::save_at(&path, &saved).unwrap();

        assert_same_state(AppState::load_at(&path), saved);
    }

    /// The same with every optional field empty: an absent value is written
    /// as `null` and reads back as `None`, not as something migrated in.
    #[test]
    fn a_state_with_every_optional_field_empty_survives_a_restart() {
        let (_dir, path) = tmp_state_path();
        let saved = fixtures::minimal_state();

        AppState::save_at(&path, &saved).unwrap();

        assert_same_state(AppState::load_at(&path), saved);
    }

    /// A second save over the first leaves no trace of the first, and no
    /// temp file beside it.
    #[test]
    fn a_later_save_replaces_the_earlier_one() {
        let (dir, path) = tmp_state_path();
        AppState::save_at(&path, &fixtures::full_state()).unwrap();
        let later = fixtures::minimal_state();

        AppState::save_at(&path, &later).unwrap();

        assert_same_state(AppState::load_at(&path), later);
        let names: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["state.json"]);
    }

    /// The frontend's save carries every field it owns, so applying it to the
    /// state it was built from changes nothing: the Rust-owned id included.
    #[test]
    fn the_frontends_own_save_reproduces_the_state() {
        for state in [fixtures::full_state(), fixtures::minimal_state()] {
            let mut applied = state.clone();
            applied.apply_patch(fixtures::patch_of(&state));
            assert_same_state(applied, state);
        }
    }

    /// A key this build does not know is not an error on load, and a save
    /// carries it through: another build of Atlas may own it.
    #[test]
    fn an_unknown_key_is_tolerated_on_load_and_kept_by_a_save() {
        let (_dir, path) = tmp_state_path();
        let mut on_disk = serde_json::to_value(fixtures::full_state()).unwrap();
        on_disk["fromANewerBuild"] = serde_json::json!({ "kept": true });
        on_disk["workspaces"][0]["fromANewerBuild"] = serde_json::json!(1);
        std::fs::write(&path, on_disk.to_string()).unwrap();

        let loaded = AppState::load_at(&path);
        assert_same_state(loaded.clone(), fixtures::full_state());

        AppState::save_at(&path, &loaded).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["fromANewerBuild"], serde_json::json!({ "kept": true }));
        // Only a TOP-LEVEL unknown key survives: the lists are rewritten from
        // the typed state, so a key nested in a row is dropped by the save.
        assert!(raw["workspaces"][0].get("fromANewerBuild").is_none());
    }

    /// Every field but the three a row cannot do without is optional in the
    /// file, and an absent one loads as its default.
    #[test]
    fn a_missing_optional_field_loads_as_its_default() {
        let (_dir, path) = tmp_state_path();
        std::fs::write(
            &path,
            serde_json::json!({
                "recentProjects": [
                    { "name": "atlas", "path": "/Users/dev/atlas", "lastOpened": "then" }
                ],
                "workspaces": [{ "id": "ws-1", "name": "atlas", "path": "/Users/dev/atlas" }],
                "organisations": [{ "id": "org-1", "name": "Northwind", "slug": "northwind" }],
                "activeOrganisationId": "org-1",
            })
            .to_string(),
        )
        .unwrap();

        let loaded = AppState::load_at(&path);

        assert_same_state(
            loaded,
            AppState {
                current_project: None,
                recent_projects: vec![RecentProject {
                    name: "atlas".into(),
                    path: "/Users/dev/atlas".into(),
                    last_opened: "then".into(),
                    org_id: None,
                }],
                workspaces: vec![Project {
                    id: "ws-1".into(),
                    name: "atlas".into(),
                    path: "/Users/dev/atlas".into(),
                    // Not a default: `migrate` gives an untagged project to
                    // the active organisation.
                    org_id: Some("org-1".into()),
                    git_url: None,
                    last_active_at: None,
                }],
                active_workspace_id: None,
                organisations: vec![Organisation {
                    id: "org-1".into(),
                    name: "Northwind".into(),
                    slug: "northwind".into(),
                    color: None,
                    logo: None,
                    created_at: None,
                    active_workspace_id: None,
                    sync_enabled: false,
                    remote_id: None,
                }],
                active_organisation_id: Some("org-1".into()),
                telemetry_anon_id: None,
                version: SCHEMA_VERSION,
            },
        );
    }

    /// A required field missing from one row fails the whole parse, and the
    /// load falls back to a first run. Pinned because it is the costly case:
    /// one bad row and the next save writes the empty state over the file.
    #[test]
    fn a_row_missing_a_required_field_resets_the_whole_state() {
        let (_dir, path) = tmp_state_path();
        let mut on_disk = serde_json::to_value(fixtures::full_state()).unwrap();
        on_disk["workspaces"][1]
            .as_object_mut()
            .unwrap()
            .remove("path");
        std::fs::write(&path, on_disk.to_string()).unwrap();

        let loaded = AppState::load_at(&path);

        assert!(loaded.workspaces.is_empty());
        assert!(loaded.recent_projects.is_empty());
        assert_eq!(loaded.organisations.len(), 1);
        assert_eq!(loaded.organisations[0].name, "Personal");
        assert_eq!(loaded.telemetry_anon_id, None);
    }

    // ── Migrations: one fixture per schema version that shipped ────────────

    /// v1 held one project, in `currentProject`. It becomes the only project,
    /// active, in a new default organisation.
    #[test]
    fn a_v1_file_migrates_its_one_project_into_a_default_organisation() {
        let state = AppState::from_raw(Some(&fixture("state-v1.json")));

        assert_eq!(state.version, SCHEMA_VERSION);
        assert_eq!(state.current_project, None);
        assert_eq!(state.organisations.len(), 1);
        let org = &state.organisations[0];
        assert_eq!(org.name, "Personal");
        assert!(org.slug.starts_with("personal-"), "slug: {}", org.slug);
        assert_eq!(
            state.active_organisation_id.as_deref(),
            Some(org.id.as_str())
        );
        assert_eq!(state.workspaces.len(), 1);
        let project = &state.workspaces[0];
        assert_eq!(
            (project.name.as_str(), project.path.as_str()),
            ("atlas", "/Users/dev/atlas")
        );
        assert_eq!(project.org_id.as_deref(), Some(org.id.as_str()));
        assert_eq!(
            state.active_workspace_id.as_deref(),
            Some(project.id.as_str())
        );
        assert_eq!(org.active_workspace_id, state.active_workspace_id);
        assert_eq!(state.recent_projects.len(), 1);
        assert_eq!(state.recent_projects[0].org_id, None);
    }

    /// v2 had projects and no organisations. Every project is given to a new
    /// default organisation, which remembers the active one.
    #[test]
    fn a_v2_file_migrates_its_projects_into_a_default_organisation() {
        let state = AppState::from_raw(Some(&fixture("state-v2.json")));

        assert_eq!(state.version, SCHEMA_VERSION);
        assert_eq!(state.organisations.len(), 1);
        let org = &state.organisations[0];
        assert_eq!(
            state.active_organisation_id.as_deref(),
            Some(org.id.as_str())
        );
        assert_eq!(org.active_workspace_id.as_deref(), Some("ws-2"));
        assert_eq!(state.active_workspace_id.as_deref(), Some("ws-2"));
        let ids: Vec<_> = state.workspaces.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, ["ws-1", "ws-2"]);
        for project in &state.workspaces {
            assert_eq!(project.org_id.as_deref(), Some(org.id.as_str()));
        }
        assert_eq!(
            state.workspaces[0].last_active_at.as_deref(),
            Some("2025-03-01T09:00:00Z")
        );
    }

    /// v3 is today's shape plus the keys v4 retired. The state loads as
    /// written, bar the two repairs `migrate` makes; the retired keys are
    /// ignored by the load and dropped by the next save.
    #[test]
    fn a_v3_file_loads_as_written_and_its_retired_keys_go_on_the_next_save() {
        let (_dir, path) = tmp_state_path();
        std::fs::write(&path, fixture("state-v3.json")).unwrap();

        let state = AppState::load_at(&path);

        assert_eq!(state.version, SCHEMA_VERSION);
        assert_eq!(state.telemetry_anon_id.as_deref(), Some("device-uuid"));
        assert_eq!(state.active_organisation_id.as_deref(), Some("org-1"));
        assert_eq!(state.active_workspace_id.as_deref(), Some("ws-1"));
        assert_eq!(state.organisations.len(), 2);
        // The untouched default organisation's literal handle is replaced…
        assert!(state.organisations[0].slug.starts_with("personal-"));
        assert_eq!(
            state.organisations[0].active_workspace_id.as_deref(),
            Some("ws-1")
        );
        // …and a synced organisation's is the server's, so it stays.
        assert_eq!(state.organisations[1].slug, "northwind");
        assert_eq!(
            state.organisations[1].remote_id.as_deref(),
            Some("srv-org-2")
        );
        assert!(state.organisations[1].sync_enabled);
        assert_eq!(
            state.workspaces[0].git_url.as_deref(),
            Some("git@example.com:dev/atlas.git")
        );
        // The untagged project goes to the active organisation.
        assert_eq!(state.workspaces[1].org_id.as_deref(), Some("org-1"));

        AppState::save_at(&path, &state).unwrap();
        let raw: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        for retired in ["settings", "settingsConfigMigrated", "groups"] {
            assert!(raw.get(retired).is_none(), "{retired} survived a save");
        }
        assert_same_state(AppState::load_at(&path), state);
    }
}
