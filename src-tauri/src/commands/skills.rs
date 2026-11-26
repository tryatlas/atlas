//! Skills and packs: the IPC commands over [`atlas_skills`].
//!
//! The skill store itself (the canonical `.agents/skills` tree, projection
//! into each agent's skills directory, bundled skills, packs) is the
//! `atlas-skills` crate, which knows nothing about Tauri. Each command here
//! does the same four things: open the store for the scope it was given, move
//! to a blocking thread, call one store operation, and report the outcome to
//! telemetry where it always has.
//!
//! What this file supplies that the crate does not look up for itself: the
//! home directory, the config file's name, GitHub as the place packs come
//! from, and the HTTP request to the skills.sh search index.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{AppHandle, Manager};

use atlas_skills::{
    AgentTarget, GitHub, InstalledPack, Pack, PackComponentMeta, PackInstallResult,
    PackProjectReport, PackProjectionView, PackSearchHit, PackSearchResponse, PackUpdateCheck,
    ReconcileView, SkillContent, SkillMeta, SkillStore,
};

/// Home dir, preferring the `dirs` crate (already a dependency) and falling
/// back to `$HOME`.
fn home_dir() -> Option<PathBuf> {
    dirs::home_dir().or_else(|| std::env::var_os("HOME").map(PathBuf::from))
}

/// The store for a command's `scope` + `projectPath`.
fn store(scope: &str, project_path: Option<&str>) -> Result<SkillStore, String> {
    SkillStore::open(home_dir().as_deref(), scope, project_path)
}

/// Run a store operation off the async runtime: every one of them blocks on
/// the filesystem, and the pack ones on `git`.
async fn blocking<T, F>(op: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(op)
        .await
        .map_err(|e| e.to_string())?
}

/// Install or upgrade the skills Atlas ships into the canonical **global**
/// store (`~/.agents/skills/<name>`). Called once at launch; see
/// [`atlas_skills::sync_bundled_skills`] for what it will and will not
/// overwrite.
pub fn ensure_bundled_skills() {
    let Some(home) = home_dir() else {
        return;
    };
    atlas_skills::sync_bundled_skills(
        &home,
        atlas_profile::current(),
        crate::state::atlas_config::CONFIG_FILE_NAME,
    );
}

// ── Tauri commands ─────────────────────────────────────────────────────────────

/// List installed skills for a scope (canonical store scan + per-agent enable).
#[tauri::command]
pub async fn skills_list(
    scope: String,
    project_path: Option<String>,
) -> Result<Vec<SkillMeta>, String> {
    let store = store(&scope, project_path.as_deref())?;
    blocking(move || store.list()).await
}

/// Read one skill's frontmatter + body (for editing/preview).
#[tauri::command]
pub async fn skills_read(
    scope: String,
    name: String,
    project_path: Option<String>,
) -> Result<SkillContent, String> {
    let store = store(&scope, project_path.as_deref())?;
    blocking(move || store.read(&name)).await
}

/// Enable/disable a single agent for a skill (create/remove its symlink).
#[tauri::command]
pub async fn skills_set_enabled(
    app: AppHandle,
    scope: String,
    name: String,
    agent: String,
    enabled: bool,
    project_path: Option<String>,
) -> Result<(), String> {
    let store = store(&scope, project_path.as_deref())?;
    let agent_ev = agent.clone();
    let res = blocking(move || store.set_enabled(&name, &agent, enabled)).await;
    if res.is_ok() {
        app.state::<Arc<crate::telemetry::TelemetryClient>>()
            .capture(
                if enabled {
                    "skill_enabled"
                } else {
                    "skill_disabled"
                },
                serde_json::json!({ "agent": agent_ev }),
            );
    }
    res
}

/// The source kind a skill or pack came from, for telemetry: the coarse
/// category, never the `owner/repo` itself. TELEMETRY.md promises "no
/// repository names or remotes", and a pack's repo is one.
const TELEMETRY_SOURCE_KIND_GITHUB: &str = "github";

/// Delete a skill: remove every agent symlink, then the canonical dir.
#[tauri::command]
pub async fn skills_delete(
    app: AppHandle,
    scope: String,
    name: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let store = store(&scope, project_path.as_deref())?;
    let scope_ev = scope.clone();
    let res = blocking(move || store.delete(&name)).await;
    if res.is_ok() {
        app.state::<Arc<crate::telemetry::TelemetryClient>>()
            .capture("skill_deleted", serde_json::json!({ "scope": scope_ev }));
    }
    res
}

/// Absolute path to a skill's `SKILL.md` (for opening in the editor).
#[tauri::command]
pub async fn skills_path(
    scope: String,
    name: String,
    project_path: Option<String>,
) -> Result<String, String> {
    let store = store(&scope, project_path.as_deref())?;
    blocking(move || store.path(&name)).await
}

/// Adopt an external/single-agent skill: copy it into the canonical store (if
/// not already there) and symlink it into every detected agent ("Make for all
/// agents"). Returns the now-managed skill.
#[tauri::command]
pub async fn skills_adopt(
    scope: String,
    name: String,
    project_path: Option<String>,
) -> Result<SkillMeta, String> {
    let store = store(&scope, project_path.as_deref())?;
    blocking(move || store.adopt(&name)).await
}

/// List registry agents as enable targets for the current scope+root.
#[tauri::command]
pub async fn agents_list_skill_targets(
    scope: String,
    project_path: Option<String>,
) -> Result<Vec<AgentTarget>, String> {
    let store = store(&scope, project_path.as_deref())?;
    blocking(move || Ok(store.targets())).await
}

// ── Tauri commands (Control Plane) ───────────────────────────────────────────────

/// List the tool registry with per-scope detection facts.
#[tauri::command]
pub async fn tools_list(
    scope: String,
    project_path: Option<String>,
) -> Result<Vec<AgentTarget>, String> {
    let store = store(&scope, project_path.as_deref())?;
    blocking(move || Ok(store.targets())).await
}

/// Build the reconciled skill × tool matrix for a scope.
#[tauri::command]
pub async fn skills_reconcile(
    scope: String,
    project_path: Option<String>,
) -> Result<ReconcileView, String> {
    let store = store(&scope, project_path.as_deref())?;
    blocking(move || store.reconcile()).await
}

/// Project a canonical skill into one tool at a scope (symlink/copy + ledger).
#[tauri::command]
pub async fn skills_project(
    scope: String,
    name: String,
    tool: String,
    force: Option<bool>,
    project_path: Option<String>,
) -> Result<(), String> {
    let store = store(&scope, project_path.as_deref())?;
    let force = force.unwrap_or(false);
    blocking(move || store.project(&name, &tool, force)).await
}

/// Remove a projection (symlink/copy) of a skill from one tool + drop its ledger.
#[tauri::command]
pub async fn skills_unproject(
    scope: String,
    name: String,
    tool: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let store = store(&scope, project_path.as_deref())?;
    blocking(move || store.unproject(&name, &tool)).await
}

/// Promote a project skill to the global library + re-project at global scope.
#[tauri::command]
pub async fn skills_promote(name: String, project_path: String) -> Result<SkillMeta, String> {
    let store = store("project", Some(&project_path))?;
    blocking(move || store.promote(&name)).await
}

/// Freeze every Atlas symlink projection into a real copy (uninstall safety).
#[tauri::command]
pub async fn skills_freeze(scope: String, project_path: Option<String>) -> Result<(), String> {
    let store = store(&scope, project_path.as_deref())?;
    blocking(move || store.freeze()).await
}

// ── Pack commands ─────────────────────────────────────────────────────────────

/// Inspect a pack directory on disk and return its manifest + component listing.
/// Read-only — nothing is installed, projected, or executed.
#[tauri::command(async)]
pub fn pack_inspect(dir: String) -> Result<Pack, String> {
    atlas_skills::inspect_pack(Path::new(&dir))
}

/// Search the skills.sh registry. Discovery only — no content is fetched.
#[tauri::command]
pub async fn pack_search(query: String) -> Result<Vec<PackSearchHit>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| format!("search request failed: {e}"))?;
    let resp = client
        .get(atlas_skills::PACK_SEARCH_URL)
        .query(&[("q", q.as_str())])
        .header("User-Agent", "atlas")
        .send()
        .await
        .map_err(|e| format!("search request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("search failed: HTTP {}", resp.status()));
    }
    let body: PackSearchResponse = resp
        .json()
        .await
        .map_err(|e| format!("bad search response: {e}"))?;
    Ok(body.skills)
}

/// Fetch a pack's source repo and parse it WITHOUT installing — for the
/// install-preview UI (shows every component the pack ships).
#[tauri::command]
pub async fn pack_remote_preview(source: String) -> Result<Pack, String> {
    blocking(move || atlas_skills::preview_pack(&GitHub, &source)).await
}

/// `pack_installed`'s properties: the source kind, scope and size only.
fn pack_installed_properties(scope: &str, skill_count: usize) -> serde_json::Value {
    serde_json::json!({
        "source_kind": TELEMETRY_SOURCE_KIND_GITHUB,
        "scope": scope,
        "skill_count": skill_count,
    })
}

/// `skill_downloaded`'s properties: the source kind and scope only.
fn skill_downloaded_properties(scope: &str) -> serde_json::Value {
    serde_json::json!({
        "source_kind": TELEMETRY_SOURCE_KIND_GITHUB,
        "scope": scope,
    })
}

/// Install a pack from its GitHub source repo into the store. Fetches the whole
/// repo, dedups against the lock, writes `skills-lock.json`. No projection
/// (Phase 3) and no script execution.
#[tauri::command]
pub async fn pack_install_remote(
    app: AppHandle,
    scope: String,
    source: String,
    force: Option<bool>,
    project_path: Option<String>,
) -> Result<PackInstallResult, String> {
    let store = store(&scope, project_path.as_deref())?;
    let force = force.unwrap_or(false);
    let scope_ev = scope.clone();
    let res = blocking(move || store.install_pack(&GitHub, &source, force)).await;
    if let Ok(result) = &res {
        app.state::<Arc<crate::telemetry::TelemetryClient>>()
            .capture(
                "pack_installed",
                pack_installed_properties(&scope_ev, result.pack.components.len()),
            );
    }
    res
}

/// Install a single skill (`skill_id`) from a GitHub `source` repo as a managed
/// skill. Granular alternative to `pack_install_remote`.
#[tauri::command]
pub async fn pack_install_skill(
    app: AppHandle,
    scope: String,
    source: String,
    skill_id: String,
    project_path: Option<String>,
) -> Result<SkillMeta, String> {
    let store = store(&scope, project_path.as_deref())?;
    // Cloned for the telemetry event (the closure moves the original); `scope`
    // is "global"/"project". The skill, its registry id and the `owner/repo` it
    // came from are not sent: they name a repository.
    let scope_ev = scope.clone();
    let res = blocking(move || store.install_skill(&GitHub, &source, &skill_id)).await;
    if res.is_ok() {
        app.state::<Arc<crate::telemetry::TelemetryClient>>()
            .capture("skill_downloaded", skill_downloaded_properties(&scope_ev));
    }
    res
}

/// List packs installed in this scope (manifest + provenance).
#[tauri::command]
pub async fn pack_list(
    scope: String,
    project_path: Option<String>,
) -> Result<Vec<InstalledPack>, String> {
    let store = store(&scope, project_path.as_deref())?;
    blocking(move || store.packs()).await
}

/// Cheaply check whether an installed pack is behind its source repo: compares
/// the remote HEAD SHA (`git ls-remote`, no clone) to the commit in the lock.
/// Read-only — applying the update is `pack_install_remote`.
#[tauri::command]
pub async fn pack_check_update(
    scope: String,
    pack: String,
    project_path: Option<String>,
) -> Result<PackUpdateCheck, String> {
    let store = store(&scope, project_path.as_deref())?;
    blocking(move || store.check_pack_update(&GitHub, &pack)).await
}

// ── Pack projection commands ──────────────────────────────────────────────────

/// Project an installed pack's components into a tool (optionally kind-filtered).
#[tauri::command]
pub async fn pack_project(
    scope: String,
    pack: String,
    tool: String,
    kinds: Option<Vec<String>>,
    force: Option<bool>,
    project_path: Option<String>,
) -> Result<Vec<PackProjectReport>, String> {
    let store = store(&scope, project_path.as_deref())?;
    let force = force.unwrap_or(false);
    blocking(move || store.project_pack(&pack, &tool, kinds.as_deref(), force)).await
}

/// Undo every projection of a pack into a tool.
#[tauri::command]
pub async fn pack_unproject(
    scope: String,
    pack: String,
    tool: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let store = store(&scope, project_path.as_deref())?;
    blocking(move || store.unproject_pack(&pack, &tool)).await
}

/// Fully remove an installed pack: unproject it from every tool it's recorded
/// in (clears the tool homes), delete its store dir, and drop its lock entry.
/// Idempotent — uninstalling a pack that isn't present is a no-op success.
#[tauri::command]
pub async fn pack_uninstall(
    scope: String,
    pack: String,
    project_path: Option<String>,
) -> Result<(), String> {
    let store = store(&scope, project_path.as_deref())?;
    blocking(move || store.uninstall_pack(&pack)).await
}

/// Read-only projection ledger view for one pack.
#[tauri::command]
pub async fn pack_projections(
    scope: String,
    pack: String,
    project_path: Option<String>,
) -> Result<Vec<PackProjectionView>, String> {
    let store = store(&scope, project_path.as_deref())?;
    blocking(move || store.pack_projections(&pack)).await
}

/// Every invokable component (command/agent/rule) across installed packs, for
/// the Skills list and the `#<kind>:` mention rail. Read-only.
#[tauri::command]
pub async fn pack_components_list(
    scope: String,
    project_path: Option<String>,
) -> Result<Vec<PackComponentMeta>, String> {
    let store = store(&scope, project_path.as_deref())?;
    blocking(move || Ok(store.pack_components())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The install events name no repository and no skill: the pack's
    /// `owner/repo` is a repository name, which TELEMETRY.md says is never
    /// sent, and a skill name (or an unsalted hash of one) can be read back.
    #[test]
    fn the_install_events_carry_no_repository_or_skill_name() {
        let pack = pack_installed_properties("project", 3);
        assert_eq!(
            pack,
            serde_json::json!({ "source_kind": "github", "scope": "project", "skill_count": 3 })
        );
        let skill = skill_downloaded_properties("global");
        assert_eq!(
            skill,
            serde_json::json!({ "source_kind": "github", "scope": "global" })
        );
    }

    /// A command's scope and path are refused before any thread is spawned,
    /// in the words the UI has always shown.
    #[test]
    fn a_bad_scope_or_project_path_is_refused_when_the_store_is_opened() {
        assert_eq!(store("nope", None).unwrap_err(), "invalid scope: nope");
        assert_eq!(
            store("project", None).unwrap_err(),
            "project scope requires a projectPath"
        );
        assert_eq!(
            store("project", Some("/tmp/a/../b")).unwrap_err(),
            "invalid projectPath: parent-directory segments are not allowed"
        );
    }

    /// A blocking operation's own error reaches the caller unchanged.
    #[tokio::test]
    async fn a_store_error_passes_through_the_blocking_hop_unchanged() {
        let err = blocking(|| Err::<(), _>("skill not found: ghost".to_string())).await;
        assert_eq!(err.unwrap_err(), "skill not found: ghost");
        assert_eq!(blocking(|| Ok(7)).await, Ok(7));
    }
}
