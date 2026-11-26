//! Pack install, update check, listing and uninstall against the store and lock.

use crate::disk::{copy_dir_all, hash_skill_dir};
use crate::model::Pack;
use crate::packs::lockfile::{
    pack_store_dir, packs_base, read_pack_lock, write_pack_lock, PackLockEntry,
};
use crate::packs::parse::{pack_parse, repo_name_from_source};
use crate::packs::projection::{read_pack_proj, unproject_pack};
use crate::packs::source::{parse_owner_repo, PackSource};
use crate::paths::sanitize_name;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;

// ── Pack install from registry (pack-install plan, Phase 2) ──────────────────────
//
// Discovery uses the public skills.sh search API; content comes from the GitHub
// source repo (skills.sh's content API is auth-gated). USER DECISION: one pack =
// one source repo — fetch the whole repo via `git clone --depth 1`, parse every
// component, store it under `<root>/.atlas/packs/<repo>/`. NOTHING is executed at
// install — scripts are only placed. Projection into tool homes is Phase 3.

pub(crate) const SKILLS_SEARCH_URL: &str = "https://www.skills.sh/api/search";

/// One hit from the skills.sh search index. `source` is a GitHub `owner/repo`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSearchHit {
    pub id: String,
    #[serde(default)]
    pub skill_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub installs: u64,
    pub source: String,
}

/// skills.sh `/api/search` envelope (only `skills` is consumed).
#[derive(Debug, Clone, Deserialize)]
pub struct PackSearchResponse {
    #[serde(default)]
    pub skills: Vec<PackSearchHit>,
}

/// Outcome of an install attempt against the existing store + lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PackInstallState {
    /// Not previously installed — freshly fetched.
    Fresh,
    /// Re-fetched and content changed; store + lock updated.
    Updated,
    /// Already present with identical content — no change.
    AlreadyInstalled,
    /// Store dir exists but is not Atlas-managed (no lock entry) — refused.
    Conflict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackInstallResult {
    pub state: PackInstallState,
    pub pack: Pack,
    pub content_hash: String,
}

/// Result of a cheap "is this pack behind its source?" check (no content fetch).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackUpdateCheck {
    /// `true` when the remote HEAD SHA differs from the installed commit.
    pub has_update: bool,
    /// The remote HEAD SHA.
    pub remote_commit: String,
}

/// An installed pack as surfaced to the UI (manifest + provenance).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPack {
    pub pack: Pack,
    pub source: String,
    pub commit: String,
    pub installed_at: u64,
    pub updated_at: u64,
}

pub(crate) fn now_unix_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Install an already-fetched pack tree (`src`, `.git` stripped) into the store,
/// applying dedup against the lock. Network-free, so unit-testable. `now` is
/// the clock the lock's timestamps are read from.
fn install_pack_at(
    root: &Path,
    src: &Path,
    source: &str,
    commit: &str,
    force: bool,
    now: &dyn Fn() -> u64,
) -> Result<PackInstallResult, String> {
    let parsed_src = pack_parse(src)?;
    // `pack_name` falls back to the source DIR basename when the manifest has no
    // `name` — but at install time `src` is a throwaway clone dir
    // (`atlas-pack-clone-<pid>-<ts>`), which would become the pack's name. Prefer
    // the manifest name, else the source repo name (`owner/repo` → `repo`).
    let name = parsed_src
        .manifest
        .as_ref()
        .and_then(|m| m.name.as_deref())
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| repo_name_from_source(source));
    let safe = sanitize_name(&name)?;
    let store = pack_store_dir(root, &safe)?;
    let new_hash = hash_skill_dir(src);

    let mut lock = read_pack_lock(root);
    let prior = lock.packs.get(&safe).cloned();

    if store.exists() {
        match &prior {
            // Present but unmanaged → refuse to clobber unless forced.
            None if !force => {
                let pack = pack_parse(&store).unwrap_or(parsed_src);
                return Ok(PackInstallResult {
                    state: PackInstallState::Conflict,
                    pack,
                    content_hash: new_hash,
                });
            }
            // Managed + identical content → no-op.
            Some(entry) if entry.content_hash == new_hash => {
                let pack = pack_parse(&store)?;
                return Ok(PackInstallResult {
                    state: PackInstallState::AlreadyInstalled,
                    pack,
                    content_hash: new_hash,
                });
            }
            _ => {}
        }
    }

    copy_dir_all(src, &store)?;

    let now = now();
    let (installed_at, state) = match &prior {
        Some(prev) => (prev.installed_at, PackInstallState::Updated),
        None => (now, PackInstallState::Fresh),
    };
    lock.packs.insert(
        safe,
        PackLockEntry {
            source: source.to_string(),
            commit: commit.to_string(),
            content_hash: new_hash.clone(),
            installed_at,
            updated_at: now,
        },
    );
    write_pack_lock(root, &lock)?;

    let pack = pack_parse(&store)?;
    Ok(PackInstallResult {
        state,
        pack,
        content_hash: new_hash,
    })
}

/// List installed packs (lock ∩ on-disk store dirs).
pub(crate) fn list_installed_packs(root: &Path) -> Result<Vec<InstalledPack>, String> {
    let lock = read_pack_lock(root);
    let base = packs_base(root);
    let mut out = Vec::new();
    for (name, entry) in &lock.packs {
        let dir = base.join(name);
        if !dir.is_dir() {
            continue;
        }
        if let Ok(pack) = pack_parse(&dir) {
            out.push(InstalledPack {
                pack,
                source: entry.source.clone(),
                commit: entry.commit.clone(),
                installed_at: entry.installed_at,
                updated_at: entry.updated_at,
            });
        }
    }
    Ok(out)
}

/// [`install_pack_at`] on the system clock, as the tests call it.
#[cfg(test)]
pub(crate) fn install_pack_from_dir(
    root: &Path,
    src: &Path,
    source: &str,
    commit: &str,
    force: bool,
) -> Result<PackInstallResult, String> {
    install_pack_at(root, src, source, commit, force, &now_unix_secs)
}

/// Fetch a pack's source and parse it WITHOUT installing — for the
/// install-preview UI (shows every component the pack ships).
pub(crate) fn preview_pack(from: &dyn PackSource, source: &str) -> Result<Pack, String> {
    let (owner, repo) = parse_owner_repo(source)?;
    let (tmp, _commit) = from.fetch(&owner, &repo)?;
    let result = pack_parse(&tmp);
    let _ = fs::remove_dir_all(&tmp);
    result
}

/// Install a pack from its source into the store. Fetches the whole repo,
/// dedups against the lock, writes `skills-lock.json`. No projection and no
/// script execution.
pub(crate) fn install_pack_from_source(
    root: &Path,
    from: &dyn PackSource,
    source: &str,
    force: bool,
    now: &dyn Fn() -> u64,
) -> Result<PackInstallResult, String> {
    let (owner, repo) = parse_owner_repo(source)?;
    let (tmp, commit) = from.fetch(&owner, &repo)?;
    let result = install_pack_at(root, &tmp, source, &commit, force, now);
    let _ = fs::remove_dir_all(&tmp);
    result
}

/// Cheaply check whether an installed pack is behind its source: compares the
/// source's HEAD commit (no content fetch) to the commit in the lock.
/// Read-only — applying the update is an install.
pub(crate) fn check_pack_update(
    root: &Path,
    from: &dyn PackSource,
    pack: &str,
) -> Result<PackUpdateCheck, String> {
    let safe = sanitize_name(pack)?;
    let lock = read_pack_lock(root);
    let entry = lock
        .packs
        .get(&safe)
        .ok_or_else(|| format!("pack not installed: {pack}"))?;
    let (owner, repo) = parse_owner_repo(&entry.source)?;
    let remote = from.head_commit(&owner, &repo)?;
    Ok(PackUpdateCheck {
        has_update: remote != entry.commit,
        remote_commit: remote,
    })
}

/// Fully remove an installed pack: unproject it from every tool it's recorded
/// in (clears the tool homes), delete its store dir, and drop its lock entry.
/// Idempotent — uninstalling a pack that isn't present is a no-op success.
pub(crate) fn uninstall_pack(root: &Path, pack: &str) -> Result<(), String> {
    let safe = sanitize_name(pack)?;
    // 1. Unproject from every tool it's recorded in.
    let tool_ids: Vec<String> = read_pack_proj(root)
        .projections
        .get(&safe)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    for tool_id in tool_ids {
        unproject_pack(root, pack, &tool_id)?;
    }
    // 2. Delete the canonical store dir.
    let store = pack_store_dir(root, &safe)?;
    if store.exists() {
        fs::remove_dir_all(&store).map_err(|e| format!("remove {}: {e}", store.display()))?;
    }
    // 3. Drop the lock entry.
    let mut lock = read_pack_lock(root);
    lock.packs.remove(&safe);
    write_pack_lock(root, &lock)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ComponentKind;
    use crate::test_support::{make_src_pack, tmp_pack_dir, write_file};

    #[test]
    fn install_pack_fresh_then_already_installed_then_updated() {
        let root = tmp_pack_dir();
        let src = make_src_pack("v1");

        // Fresh.
        let r1 = install_pack_from_dir(&root, &src, "o/r", "c1", false).unwrap();
        assert_eq!(r1.state, PackInstallState::Fresh);
        assert_eq!(r1.pack.name, "demo-pack");
        let store = pack_store_dir(&root, "demo-pack").unwrap();
        assert!(store.join("skills/foo/SKILL.md").is_file());
        assert!(store.join("agents/rev.md").is_file());
        // Lock written; .git never copied (none in src anyway).
        let lock = read_pack_lock(&root);
        assert_eq!(lock.packs.get("demo-pack").unwrap().commit, "c1");

        // Re-install identical content → AlreadyInstalled, installed_at preserved.
        let r2 = install_pack_from_dir(&root, &src, "o/r", "c1", false).unwrap();
        assert_eq!(r2.state, PackInstallState::AlreadyInstalled);

        // Mutate the source → Updated, installed_at preserved, updated content lands.
        write_file(
            &src.join("skills/foo/SKILL.md"),
            "---\nname: foo\n---\nCHANGED",
        );
        let before = read_pack_lock(&root)
            .packs
            .get("demo-pack")
            .unwrap()
            .installed_at;
        let r3 = install_pack_from_dir(&root, &src, "o/r", "c2", false).unwrap();
        assert_eq!(r3.state, PackInstallState::Updated);
        let entry = read_pack_lock(&root)
            .packs
            .get("demo-pack")
            .unwrap()
            .clone();
        assert_eq!(entry.installed_at, before); // preserved
        assert_eq!(entry.commit, "c2");
        let stored = fs::read_to_string(store.join("skills/foo/SKILL.md")).unwrap();
        assert!(stored.contains("CHANGED"));

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn install_pack_conflicts_with_unmanaged_dir_unless_forced() {
        let root = tmp_pack_dir();
        let src = make_src_pack("v1");
        // Pre-create an unmanaged store dir (no lock entry).
        let store = pack_store_dir(&root, "demo-pack").unwrap();
        write_file(&store.join("preexisting.txt"), "not ours");

        let conflict = install_pack_from_dir(&root, &src, "o/r", "c1", false).unwrap();
        assert_eq!(conflict.state, PackInstallState::Conflict);
        // Untouched: our file did not overwrite it.
        assert!(store.join("preexisting.txt").is_file());
        assert!(read_pack_lock(&root).packs.is_empty());

        // With force → installs over it as Fresh.
        let forced = install_pack_from_dir(&root, &src, "o/r", "c1", true).unwrap();
        assert_eq!(forced.state, PackInstallState::Fresh);
        assert!(store.join("skills/foo/SKILL.md").is_file());
        assert!(!store.join("preexisting.txt").exists()); // replaced
        assert!(read_pack_lock(&root).packs.contains_key("demo-pack"));

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn list_installed_packs_reflects_store_and_lock() {
        let root = tmp_pack_dir();
        let src = make_src_pack("v1");
        install_pack_from_dir(&root, &src, "owner/repo", "c1", false).unwrap();

        let listed = list_installed_packs(&root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].pack.name, "demo-pack");
        assert_eq!(listed[0].source, "owner/repo");
        // foo skill + rev agent both surface as components.
        assert!(listed[0]
            .pack
            .components
            .iter()
            .any(|c| c.kind == ComponentKind::Skill));
        assert!(listed[0]
            .pack
            .components
            .iter()
            .any(|c| c.kind == ComponentKind::Agent));

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }
}
