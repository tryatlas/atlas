//! Pack projection: an installed pack's components placed into a tool's homes,
//! recorded in the pack-projection ledger so they can be undone exactly.

use crate::disk::{atomic_write, clear_entry, copy_tree, replace_entry, symlink};
use crate::frontmatter::parse_frontmatter;
use crate::model::{ComponentKind, PackComponent};
use crate::packs::install::list_installed_packs;
use crate::packs::lockfile::{pack_store_dir, packs_base};
use crate::packs::parse::pack_parse;
use crate::paths::sanitize_name;
use crate::registry::{tool_def, tool_home, tool_skills_dir, HomeStyle};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

// ── Pack projection (pack-install plan, Phase 3) ─────────────────────────────────
//
// Project an INSTALLED pack's components from the store
// (`<root>/.atlas/packs/<pack>/<relPath>`) into a tool's homes, routed by
// `ComponentKind` via the Phase 0 `ToolDef.homes` table. Dir-style kinds are
// symlinked (copy fallback); hooks merge into `settings.json`; rules append to a
// flat file. Scripts are never projected. Every projection is recorded in a
// dedicated pack-projection ledger so unproject can undo precisely.

const ATLAS_PACK_TAG: &str = "_atlasPack";

/// One recorded pack-component projection (for precise un-projection).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackProjEntry {
    pub(crate) kind: ComponentKind,
    /// Component path relative to the pack store root (e.g. `agents/rev.md`).
    pub(crate) rel_path: String,
    /// Leaf in the tool home (e.g. `rev.md`, `foo`) or the rule/marker name.
    pub(crate) leaf: String,
    /// `"symlink" | "copy" | "settings-merge" | "append"`.
    pub(crate) mode: String,
    /// Target path relative to `<root>` that received the projection.
    pub(crate) target_rel: String,
}

/// `<root>/.atlas/packs/.pack-projections.json`: pack → toolId → entries.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct PackProj {
    pub(crate) version: u32,
    pub(crate) projections: BTreeMap<String, BTreeMap<String, Vec<PackProjEntry>>>,
}

impl Default for PackProj {
    fn default() -> Self {
        Self {
            version: 1,
            projections: BTreeMap::new(),
        }
    }
}

fn pack_proj_path(root: &Path) -> PathBuf {
    packs_base(root).join(".pack-projections.json")
}

/// Read the pack-projection ledger, tolerating a missing/garbage file.
pub(crate) fn read_pack_proj(root: &Path) -> PackProj {
    match fs::read_to_string(pack_proj_path(root)) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => PackProj::default(),
    }
}

fn write_pack_proj(root: &Path, proj: &PackProj) -> Result<(), String> {
    let payload = serde_json::to_string_pretty(proj).map_err(|e| e.to_string())?;
    atomic_write(&pack_proj_path(root), &payload)
}

/// Per-component outcome reported back to the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackProjectReport {
    pub kind: ComponentKind,
    pub name: String,
    pub mode: String,
    /// `"projected" | "skipped" | "conflict"`.
    pub status: String,
}

/// Read-only ledger row for a single pack (flattened across tools).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackProjectionView {
    pub tool: String,
    pub kind: ComponentKind,
    pub name: String,
    pub mode: String,
    pub target_rel: String,
}

/// Map a kind tag (`"agent"`, `"skill"`, …) to a `ComponentKind`.
fn kind_from_tag(s: &str) -> Option<ComponentKind> {
    match s.trim().to_lowercase().as_str() {
        "skill" => Some(ComponentKind::Skill),
        "agent" => Some(ComponentKind::Agent),
        "command" => Some(ComponentKind::Command),
        "hook" => Some(ComponentKind::Hook),
        "rule" => Some(ComponentKind::Rule),
        "script" => Some(ComponentKind::Script),
        _ => None,
    }
}

/// Projection leaf for a file component: the component name plus the original
/// extension from its `rel_path` (`rev` + `agents/rev.md` → `rev.md`).
fn comp_leaf(rel_path: &str, name: &str) -> String {
    match Path::new(rel_path).extension().and_then(|e| e.to_str()) {
        Some(ext) => format!("{name}.{ext}"),
        None => name.to_string(),
    }
}

/// `p` relative to `root` as a `/`-joined string (for ledger storage).
pub(crate) fn rel_to_root(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| p.to_string_lossy().to_string())
}

/// Relative path from `link`'s parent dir to `dest` (both absolute). `None` when
/// they share no common base (caller falls back to an absolute target).
fn relative_link_target(link: &Path, dest: &Path) -> Option<PathBuf> {
    let base = link.parent()?;
    let base_comps = base.components().collect::<Vec<_>>();
    let dest_comps = dest.components().collect::<Vec<_>>();
    let mut i = 0;
    while i < base_comps.len() && i < dest_comps.len() && base_comps[i] == dest_comps[i] {
        i += 1;
    }
    if i == 0 {
        return None; // no shared prefix (e.g. different roots)
    }
    let mut out = PathBuf::new();
    for _ in i..base_comps.len() {
        out.push("..");
    }
    for c in &dest_comps[i..] {
        out.push(c.as_os_str());
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Symlink (or copy-fallback) `src_abs` → `target_abs`. Returns the mode used
/// (`"symlink"`/`"copy"`). Stages the replacement before moving the existing entry.
fn link_or_copy_into(
    src_abs: &Path,
    target_abs: &Path,
    supports_symlink: bool,
) -> Result<String, String> {
    if let Some(parent) = target_abs.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut mode = "copy".to_string();
    replace_entry(target_abs, |staging| {
        if supports_symlink {
            let link_target =
                relative_link_target(target_abs, src_abs).unwrap_or_else(|| src_abs.to_path_buf());
            // The target is relative to the final location, not staging.
            if symlink(&link_target, staging).is_ok() {
                mode = "symlink".to_string();
                return Ok(());
            }
        }
        if src_abs.is_dir() {
            copy_tree(src_abs, staging)
        } else {
            fs::copy(src_abs, staging)
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
    })?;
    Ok(mode)
}

/// The `_atlasPack` tag on a hook entry, if any.
fn entry_pack_tag(entry: &serde_json::Value) -> Option<&str> {
    entry.get(ATLAS_PACK_TAG).and_then(|v| v.as_str())
}

/// Merge a pack's hooks JSON into a tool settings file, tagging each injected
/// top-level entry with `_atlasPack=<pack>`. Idempotent: prior entries for this
/// pack are dropped first. Preserves all other settings keys.
/// Single-quote a string for safe use in a POSIX shell command.
fn sh_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Resolve a pack's plugin root in every hook `command` so bundled scripts load
/// once the hooks are merged into a plain `settings.json`.
///
/// Claude Code only defines `CLAUDE_PLUGIN_ROOT` for *real* plugin hooks; a
/// merged settings.json hook runs without it, so two breakage shapes appear:
///   1. literal `${CLAUDE_PLUGIN_ROOT}/foo.js` paths expand to nothing, and
///   2. self-bootstrapping hooks (e.g. ECC) read `process.env.CLAUDE_PLUGIN_ROOT`
///      at runtime, fall back to `~/.claude`, and `require` a missing script
///      (`cjs/loader` throws on every fire).
///
/// We fix both: substitute the literal placeholder with the absolute store path,
/// then prepend `CLAUDE_PLUGIN_ROOT=<store>` as a leading shell assignment so the
/// runtime lookup resolves too. Recurses through the nested `hooks` arrays Claude
/// Code uses; only touches `type:"command"` leaves (the default when unset).
fn rewrite_hook_commands(value: &mut serde_json::Value, plugin_root: &str) {
    match value {
        serde_json::Value::Object(map) => {
            let is_command = map
                .get("type")
                .and_then(|t| t.as_str())
                .map(|t| t == "command")
                .unwrap_or(true);
            if is_command {
                if let Some(serde_json::Value::String(cmd)) = map.get_mut("command") {
                    let resolved = cmd
                        .replace("${CLAUDE_PLUGIN_ROOT}", plugin_root)
                        .replace("$CLAUDE_PLUGIN_ROOT", plugin_root);
                    // Skip only if the command *opens* with the assignment already
                    // (an inner `process.env.CLAUDE_PLUGIN_ROOT=` must not count).
                    *cmd = if resolved.trim_start().starts_with("CLAUDE_PLUGIN_ROOT=") {
                        resolved
                    } else {
                        format!(
                            "CLAUDE_PLUGIN_ROOT={} {}",
                            sh_single_quote(plugin_root),
                            resolved
                        )
                    };
                }
            }
            for v in map.values_mut() {
                rewrite_hook_commands(v, plugin_root);
            }
        }
        serde_json::Value::Array(arr) => {
            for v in arr.iter_mut() {
                rewrite_hook_commands(v, plugin_root);
            }
        }
        _ => {}
    }
}

fn merge_hooks_into_settings(
    settings_path: &Path,
    hooks_src: &Path,
    pack: &str,
    plugin_root: &Path,
) -> Result<(), String> {
    let incoming: serde_json::Value = {
        let raw = fs::read_to_string(hooks_src).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| format!("invalid hooks json: {e}"))?
    };
    let Some(incoming_hooks) = incoming.get("hooks").and_then(|h| h.as_object()) else {
        return Ok(());
    };

    let mut settings: serde_json::Value = match fs::read_to_string(settings_path) {
        Ok(raw) if !raw.trim().is_empty() => {
            serde_json::from_str(&raw).map_err(|e| format!("invalid settings json: {e}"))?
        }
        _ => serde_json::json!({}),
    };
    if !settings.is_object() {
        settings = serde_json::json!({});
    }

    {
        let obj = settings.as_object_mut().unwrap();
        let hooks_entry = obj
            .entry("hooks".to_string())
            .or_insert_with(|| serde_json::json!({}));
        if !hooks_entry.is_object() {
            *hooks_entry = serde_json::json!({});
        }
        let hooks_obj = hooks_entry.as_object_mut().unwrap();
        for (event, arr) in incoming_hooks {
            let Some(arr) = arr.as_array() else {
                continue;
            };
            let dst = hooks_obj
                .entry(event.clone())
                .or_insert_with(|| serde_json::json!([]));
            if !dst.is_array() {
                *dst = serde_json::json!([]);
            }
            let dst_arr = dst.as_array_mut().unwrap();
            dst_arr.retain(|e| entry_pack_tag(e) != Some(pack));
            for entry in arr {
                let mut tagged = entry.clone();
                rewrite_hook_commands(&mut tagged, &plugin_root.to_string_lossy());
                if let Some(o) = tagged.as_object_mut() {
                    o.insert(
                        ATLAS_PACK_TAG.to_string(),
                        serde_json::Value::String(pack.to_string()),
                    );
                }
                dst_arr.push(tagged);
            }
        }
    }

    let payload = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    atomic_write(settings_path, &payload)
}

/// Strip every hook entry tagged for `pack` from a settings file. Best-effort.
fn remove_pack_hooks_from_settings(settings_path: &Path, pack: &str) -> Result<(), String> {
    let Ok(raw) = fs::read_to_string(settings_path) else {
        return Ok(());
    };
    if raw.trim().is_empty() {
        return Ok(());
    }
    let mut settings: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return Ok(()),
    };
    if let Some(hooks) = settings.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for (_event, arr) in hooks.iter_mut() {
            if let Some(a) = arr.as_array_mut() {
                a.retain(|e| entry_pack_tag(e) != Some(pack));
            }
        }
    }
    let payload = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    atomic_write(settings_path, &payload)
}

fn rule_marker_start(pack: &str, rule: &str) -> String {
    format!("<!-- atlas-pack:{pack}:{rule} START -->")
}

fn rule_marker_end(pack: &str, rule: &str) -> String {
    format!("<!-- atlas-pack:{pack}:{rule} END -->")
}

/// Append (or replace in place) a marked rule block in a flat text file.
fn append_rule_block(target: &Path, pack: &str, rule: &str, content: &str) -> Result<(), String> {
    let start = rule_marker_start(pack, rule);
    let end = rule_marker_end(pack, rule);
    let block = format!("{start}\n{}\n{end}", content.trim_end());

    let existing = fs::read_to_string(target).unwrap_or_default();
    let new_body = match (existing.find(&start), existing.find(&end)) {
        (Some(s), Some(e)) if e > s => {
            let e_end = e + end.len();
            let mut out = String::with_capacity(existing.len());
            out.push_str(&existing[..s]);
            out.push_str(&block);
            out.push_str(&existing[e_end..]);
            out
        }
        _ => {
            let mut out = existing;
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&block);
            out.push('\n');
            out
        }
    };
    atomic_write(target, &new_body)
}

/// Remove a marked rule block (best-effort).
fn remove_rule_block(target: &Path, pack: &str, rule: &str) -> Result<(), String> {
    let Ok(existing) = fs::read_to_string(target) else {
        return Ok(());
    };
    let start = rule_marker_start(pack, rule);
    let end = rule_marker_end(pack, rule);
    if let (Some(s), Some(e)) = (existing.find(&start), existing.find(&end)) {
        if e > s {
            let e_end = e + end.len();
            let mut out = String::with_capacity(existing.len());
            out.push_str(existing[..s].trim_end());
            out.push_str(&existing[e_end..]);
            return atomic_write(target, &out);
        }
    }
    Ok(())
}

/// Is `target` an existing entry we do NOT own (not recorded for this pack+tool)?
/// `force` always returns false (overwrite allowed).
fn is_foreign_conflict(
    root: &Path,
    target: &Path,
    safe_pack: &str,
    tool_id: &str,
    proj: &PackProj,
    force: bool,
) -> bool {
    if force || target.symlink_metadata().is_err() {
        return false;
    }
    let target_rel = rel_to_root(root, target);
    let owned = proj
        .projections
        .get(safe_pack)
        .and_then(|m| m.get(tool_id))
        .map(|entries| entries.iter().any(|e| e.target_rel == target_rel))
        .unwrap_or(false);
    !owned
}

/// Project all (or a kind-filtered subset of) an installed pack's components into
/// `tool_id`. Records each projection in the pack-projection ledger.
pub(crate) fn project_pack(
    root: &Path,
    scope: &str,
    pack: &str,
    tool_id: &str,
    kinds: Option<&[ComponentKind]>,
    force: bool,
) -> Result<Vec<PackProjectReport>, String> {
    let safe_pack = sanitize_name(pack)?;
    let store = pack_store_dir(root, &safe_pack)?;
    if !store.is_dir() {
        return Err(format!("pack not installed: {pack}"));
    }
    let def = tool_def(tool_id).ok_or_else(|| format!("unknown tool: {tool_id}"))?;
    let parsed = pack_parse(&store)?;

    let mut proj = read_pack_proj(root);
    let mut new_entries: Vec<PackProjEntry> = Vec::new();
    let mut report: Vec<PackProjectReport> = Vec::new();

    let projected = (|| -> Result<(), String> {
        for comp in &parsed.components {
            if let Some(filter) = kinds {
                if !filter.contains(&comp.kind) {
                    continue;
                }
            }
            let src_abs = store.join(&comp.rel_path);

            // Scripts are placed in the store but never projected.
            if comp.kind == ComponentKind::Script {
                report.push(PackProjectReport {
                    kind: comp.kind,
                    name: comp.name.clone(),
                    mode: "skip".to_string(),
                    status: "skipped".to_string(),
                });
                continue;
            }

            // Skills use the tool skills dir (not represented in `homes`).
            if comp.kind == ComponentKind::Skill {
                let safe_leaf = sanitize_name(&comp.name)?;
                let target = tool_skills_dir(def, scope, root).join(&safe_leaf);
                if is_foreign_conflict(root, &target, &safe_pack, tool_id, &proj, force) {
                    report.push(conflict_report(comp));
                    continue;
                }
                let mode = link_or_copy_into(&src_abs, &target, def.supports_symlink)?;
                new_entries.push(PackProjEntry {
                    kind: comp.kind,
                    rel_path: comp.rel_path.clone(),
                    leaf: safe_leaf,
                    mode: mode.clone(),
                    target_rel: rel_to_root(root, &target),
                });
                report.push(projected_report(comp, &mode));
                continue;
            }

            // Everything else routes through the tool home for its kind/scope.
            let Some(home) = tool_home(def, comp.kind, scope) else {
                report.push(PackProjectReport {
                    kind: comp.kind,
                    name: comp.name.clone(),
                    mode: "unsupported".to_string(),
                    status: "skipped".to_string(),
                });
                continue;
            };
            match home.style {
                HomeStyle::Dir => {
                    let leaf = comp_leaf(&comp.rel_path, &comp.name);
                    let target = root.join(home.rel).join(&leaf);
                    if is_foreign_conflict(root, &target, &safe_pack, tool_id, &proj, force) {
                        report.push(conflict_report(comp));
                        continue;
                    }
                    let mode = link_or_copy_into(&src_abs, &target, def.supports_symlink)?;
                    new_entries.push(PackProjEntry {
                        kind: comp.kind,
                        rel_path: comp.rel_path.clone(),
                        leaf,
                        mode: mode.clone(),
                        target_rel: rel_to_root(root, &target),
                    });
                    report.push(projected_report(comp, &mode));
                }
                HomeStyle::SettingsMerge => {
                    let target = root.join(home.rel);
                    merge_hooks_into_settings(&target, &src_abs, &safe_pack, &store)?;
                    new_entries.push(PackProjEntry {
                        kind: comp.kind,
                        rel_path: comp.rel_path.clone(),
                        leaf: comp.name.clone(),
                        mode: "settings-merge".to_string(),
                        target_rel: home.rel.to_string(),
                    });
                    report.push(projected_report(comp, "settings-merge"));
                }
                HomeStyle::AppendFile => {
                    let target = root.join(home.rel);
                    let content = fs::read_to_string(&src_abs).map_err(|e| e.to_string())?;
                    let rule = sanitize_name(&comp.name)?;
                    append_rule_block(&target, &safe_pack, &rule, &content)?;
                    new_entries.push(PackProjEntry {
                        kind: comp.kind,
                        rel_path: comp.rel_path.clone(),
                        leaf: rule,
                        mode: "append".to_string(),
                        target_rel: home.rel.to_string(),
                    });
                    report.push(projected_report(comp, "append"));
                }
            }
        }

        Ok(())
    })();

    let tool_entries = proj
        .projections
        .entry(safe_pack.clone())
        .or_default()
        .entry(tool_id.to_string())
        .or_default();
    // Replace only successful components. Conflicts and a later failure must
    // not orphan previous or newly created projections.
    for entry in &new_entries {
        tool_entries.retain(|old| old != entry);
    }
    tool_entries.extend(new_entries.iter().cloned());
    write_pack_proj(root, &proj)?;
    projected?;

    let stale = proj
        .projections
        .get(&safe_pack)
        .and_then(|p| p.get(tool_id))
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|old| {
            kinds.is_none_or(|filter| filter.contains(&old.kind))
                && (!parsed
                    .components
                    .iter()
                    .any(|comp| comp.kind == old.kind && comp.rel_path == old.rel_path)
                    || (!new_entries.contains(old)
                        && new_entries
                            .iter()
                            .any(|new| new.kind == old.kind && new.rel_path == old.rel_path)))
        })
        .collect::<Vec<_>>();
    for old in stale {
        // A renamed component can replace the same target. Removing it would
        // delete the successful replacement (or all newly merged pack hooks).
        let shared_replacement = new_entries.iter().any(|new| {
            new.target_rel == old.target_rel && (old.mode != "append" || new.leaf == old.leaf)
        });
        if !shared_replacement {
            unproject_entry(root, tool_id, &safe_pack, &old)?;
        }
        if let Some(entries) = proj
            .projections
            .get_mut(&safe_pack)
            .and_then(|p| p.get_mut(tool_id))
        {
            entries.retain(|entry| entry != &old);
        }
        write_pack_proj(root, &proj)?;
    }

    Ok(report)
}

fn projected_report(comp: &PackComponent, mode: &str) -> PackProjectReport {
    PackProjectReport {
        kind: comp.kind,
        name: comp.name.clone(),
        mode: mode.to_string(),
        status: "projected".to_string(),
    }
}

fn conflict_report(comp: &PackComponent) -> PackProjectReport {
    PackProjectReport {
        kind: comp.kind,
        name: comp.name.clone(),
        mode: "conflict".to_string(),
        status: "conflict".to_string(),
    }
}

/// The destination `entry` may act on, or `None` when the ledger names a path
/// projection could never have written.
///
/// The ledger is a plain file inside the root, so it is untrusted: a forged
/// `targetRel` (`../victim`, an absolute path) must not choose what gets
/// deleted. Instead the destination is recomputed from the tool registry for
/// the entry's kind, mode and leaf, and accepted only when it is exactly the
/// path that `project_pack` records. The match is lexical on purpose: a
/// symlinked tool dir (`.claude -> ~/dotfiles/claude`) and a relocated global
/// skills dir (`env_override`, an absolute path) are the user's own layout and
/// stay valid, while the leaf — the only part un-projection removes — must be
/// a single plain path component.
fn trusted_target(root: &Path, tool_id: &str, entry: &PackProjEntry) -> Option<PathBuf> {
    let def = tool_def(tool_id)?;
    let single_component = |leaf: &str| {
        let mut comps = Path::new(leaf).components();
        matches!(comps.next(), Some(std::path::Component::Normal(_)))
            && comps.next().is_none()
            && !leaf.contains(['/', '\\'])
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    for scope in ["global", "project"] {
        if entry.kind == ComponentKind::Skill {
            if matches!(entry.mode.as_str(), "symlink" | "copy")
                && sanitize_name(&entry.leaf).is_ok_and(|safe| safe == entry.leaf)
            {
                candidates.push(tool_skills_dir(def, scope, root).join(&entry.leaf));
            }
            continue;
        }
        let Some(home) = tool_home(def, entry.kind, scope) else {
            continue;
        };
        match (home.style, entry.mode.as_str()) {
            (HomeStyle::Dir, "symlink" | "copy") if single_component(&entry.leaf) => {
                candidates.push(root.join(home.rel).join(&entry.leaf));
            }
            (HomeStyle::SettingsMerge, "settings-merge") | (HomeStyle::AppendFile, "append") => {
                candidates.push(root.join(home.rel));
            }
            _ => {}
        }
    }
    candidates
        .into_iter()
        .find(|candidate| rel_to_root(root, candidate) == entry.target_rel)
}

fn unproject_entry(
    root: &Path,
    tool_id: &str,
    pack: &str,
    entry: &PackProjEntry,
) -> Result<(), String> {
    // An entry no projection could have produced is dropped from the ledger
    // without touching the disk.
    let Some(target) = trusted_target(root, tool_id, entry) else {
        return Ok(());
    };
    match entry.mode.as_str() {
        "settings-merge" => remove_pack_hooks_from_settings(&target, pack),
        "append" => remove_rule_block(&target, pack, &entry.leaf),
        _ => clear_entry(&target),
    }
}

/// Undo every recorded projection for `(pack, tool)` and drop the ledger subtree.
pub(crate) fn unproject_pack(root: &Path, pack: &str, tool_id: &str) -> Result<(), String> {
    let safe_pack = sanitize_name(pack)?;
    let mut proj = read_pack_proj(root);
    let entries = proj
        .projections
        .get(&safe_pack)
        .and_then(|m| m.get(tool_id))
        .cloned()
        .unwrap_or_default();

    for e in &entries {
        unproject_entry(root, tool_id, &safe_pack, e)?;
        if let Some(recorded) = proj
            .projections
            .get_mut(&safe_pack)
            .and_then(|tools| tools.get_mut(tool_id))
        {
            recorded.retain(|entry| entry != e);
        }
        write_pack_proj(root, &proj)?;
    }

    if let Some(tools) = proj.projections.get_mut(&safe_pack) {
        tools.remove(tool_id);
        if tools.is_empty() {
            proj.projections.remove(&safe_pack);
        }
    }
    write_pack_proj(root, &proj)
}

/// Flatten the ledger for one pack into a UI view (across tools).
pub(crate) fn list_pack_projections(
    root: &Path,
    pack: &str,
) -> Result<Vec<PackProjectionView>, String> {
    let safe = sanitize_name(pack)?;
    let proj = read_pack_proj(root);
    let mut out = Vec::new();
    if let Some(tools) = proj.projections.get(&safe) {
        for (tool, entries) in tools {
            for e in entries {
                out.push(PackProjectionView {
                    tool: tool.clone(),
                    kind: e.kind,
                    name: e.leaf.clone(),
                    mode: e.mode.clone(),
                    target_rel: e.target_rel.clone(),
                });
            }
        }
    }
    Ok(out)
}

/// One invokable pack-delivered component (command/agent/rule) for the Skills
/// list and the `#<kind>:` mention rail. Skills already flow through
/// `list_skills`; hooks/scripts are not chat-invokable and are excluded.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackComponentMeta {
    pub pack: String,
    /// `"command" | "agent" | "rule"` (lowercase serde).
    pub kind: ComponentKind,
    pub name: String,
    /// Component path within the pack store (e.g. `commands/ship.md`).
    pub rel_path: String,
    /// Absolute path to the component's body file (the `.md`).
    pub path: String,
    pub description: String,
    /// Registry tool ids (agents) this component is currently projected to —
    /// i.e. enabled for. Empty = not projected anywhere. Lets the chat `#` rail
    /// hide components a pack has disabled for the active agent.
    pub enabled_agents: Vec<String>,
}

/// Pack component kinds that are chat-invokable — their body is a usable prompt
/// or context. Skills are handled separately; hooks (settings JSON) and scripts
/// (executables) are not invokable.
fn is_invokable_component(kind: ComponentKind) -> bool {
    matches!(
        kind,
        ComponentKind::Agent | ComponentKind::Command | ComponentKind::Rule
    )
}

/// Every invokable component (command/agent/rule) shipped by an installed pack,
/// read-only from the pack store. Reused by the Skills list and the `#` picker.
pub(crate) fn pack_components(root: &Path) -> Vec<PackComponentMeta> {
    let mut out = Vec::new();
    // Per-agent gating data: the pack projection ledger records which tools
    // (agents) each pack component is projected to. Read once for the whole scan.
    let proj = read_pack_proj(root);
    for installed in list_installed_packs(root).unwrap_or_default() {
        let pack_safe = sanitize_name(&installed.pack.name).ok();
        for comp in &installed.pack.components {
            if !is_invokable_component(comp.kind) {
                continue;
            }
            let path = Path::new(&installed.pack.root).join(&comp.rel_path);
            let description = fs::read_to_string(&path)
                .ok()
                .and_then(|raw| parse_frontmatter(&raw).0.description)
                .unwrap_or_default();
            // Tools this component is currently projected to (= enabled for that
            // agent), matched by (kind, rel_path) in the pack projection ledger.
            let enabled_agents: Vec<String> = pack_safe
                .as_ref()
                .and_then(|safe| proj.projections.get(safe))
                .map(|tools| {
                    tools
                        .iter()
                        .filter(|(_tool, entries)| {
                            entries
                                .iter()
                                .any(|e| e.kind == comp.kind && e.rel_path == comp.rel_path)
                        })
                        .map(|(tool, _)| tool.clone())
                        .collect()
                })
                .unwrap_or_default();
            out.push(PackComponentMeta {
                pack: installed.pack.name.clone(),
                kind: comp.kind,
                name: comp.name.clone(),
                rel_path: comp.rel_path.clone(),
                path: path.to_string_lossy().to_string(),
                description,
                enabled_agents,
            });
        }
    }
    out.sort_by(|a, b| (a.kind.as_str(), &a.name).cmp(&(b.kind.as_str(), &b.name)));
    out
}

/// [`project_pack`] with the kind filter as the tags the UI sends (`"agent"`,
/// `"skill"`, …). An unknown tag is dropped, as it always was.
pub(crate) fn project_pack_tagged(
    root: &Path,
    scope: &str,
    pack: &str,
    tool_id: &str,
    kinds: Option<&[String]>,
    force: bool,
) -> Result<Vec<PackProjectReport>, String> {
    let kind_filter: Option<Vec<ComponentKind>> =
        kinds.map(|v| v.iter().filter_map(|s| kind_from_tag(s)).collect());
    project_pack(root, scope, pack, tool_id, kind_filter.as_deref(), force)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packs::install::install_pack_from_dir;
    use crate::test_support::{
        installed_root, make_full_src_pack, tmp_pack_dir, tmp_root, write_file,
    };

    #[test]
    fn a_pack_update_removes_components_that_disappeared() {
        let src = make_full_src_pack();
        let root = installed_root(&src);
        project_pack(&root, "global", "demo-pack", "claude-code", None, false).unwrap();
        let store = pack_store_dir(&root, "demo-pack").unwrap();
        fs::remove_file(store.join("agents/rev.md")).unwrap();
        project_pack(&root, "global", "demo-pack", "claude-code", None, false).unwrap();
        assert!(root
            .join(".claude/agents/rev.md")
            .symlink_metadata()
            .is_err());
        assert!(
            !read_pack_proj(&root).projections["demo-pack"]["claude-code"]
                .iter()
                .any(|entry| entry.rel_path == "agents/rev.md")
        );
        assert!(root.join(".claude/skills/foo/SKILL.md").exists());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(src).unwrap();
    }

    #[test]
    fn a_mid_projection_error_keeps_completed_components_in_the_ledger() {
        let src = make_full_src_pack();
        let root = installed_root(&src);
        // Agents and skills precede hooks. A malformed existing settings file
        // causes a later merge to fail after those projections were written.
        write_file(&root.join(".claude/settings.json"), "{ invalid json");
        assert!(project_pack(&root, "global", "demo-pack", "claude-code", None, false).is_err());
        let ledger = read_pack_proj(&root);
        let entries = &ledger.projections["demo-pack"]["claude-code"];
        assert!(!entries.is_empty());
        assert!(entries
            .iter()
            .any(|entry| entry.kind == ComponentKind::Agent));
        for entry in entries {
            assert!(root.join(&entry.target_rel).symlink_metadata().is_ok());
        }
        // The failed hook merge was never recorded, so cleanup can remove the
        // successful projections without trying to parse the malformed file.
        unproject_pack(&root, "demo-pack", "claude-code").unwrap();
        assert!(root
            .join(".claude/agents/rev.md")
            .symlink_metadata()
            .is_err());
        assert_eq!(
            fs::read_to_string(root.join(".claude/settings.json")).unwrap(),
            "{ invalid json"
        );
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(src).unwrap();
    }

    #[test]
    fn pack_project_claude_links_agent_and_skill_and_records_ledger() {
        let src = make_full_src_pack();
        let root = installed_root(&src);

        let report =
            project_pack(&root, "global", "demo-pack", "claude-code", None, false).unwrap();

        // Agent file is a symlink in .claude/agents.
        let agent_link = root.join(".claude/agents/rev.md");
        assert!(agent_link
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        // Skill projected into .claude/skills/foo and resolves through the link.
        let skill_link = root.join(".claude/skills/foo");
        assert!(skill_link.symlink_metadata().is_ok());
        assert!(skill_link.join("SKILL.md").is_file());
        // Command + rule also landed (dir-style for claude).
        assert!(root
            .join(".claude/commands/ship.md")
            .symlink_metadata()
            .is_ok());
        assert!(root
            .join(".claude/rules/style.md")
            .symlink_metadata()
            .is_ok());
        // Hook merged into settings.json.
        assert!(root.join(".claude/settings.json").is_file());

        // Script is skipped, others projected.
        assert!(report
            .iter()
            .any(|r| r.kind == ComponentKind::Script && r.status == "skipped"));
        assert!(report
            .iter()
            .any(|r| r.kind == ComponentKind::Agent && r.status == "projected"));

        // Ledger recorded the agent + skill entries.
        let proj = read_pack_proj(&root);
        let entries = proj
            .projections
            .get("demo-pack")
            .unwrap()
            .get("claude-code")
            .unwrap();
        assert!(entries
            .iter()
            .any(|e| e.kind == ComponentKind::Agent && e.target_rel == ".claude/agents/rev.md"));
        assert!(entries.iter().any(|e| e.kind == ComponentKind::Skill));

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn pack_project_hook_merge_is_idempotent_and_preserves_keys() {
        let src = make_full_src_pack();
        let root = installed_root(&src);
        // Pre-existing settings: unrelated top-level key + an unrelated hook entry.
        write_file(
            &root.join(".claude/settings.json"),
            r#"{"model":"opus","hooks":{"PreToolUse":[{"matcher":"X","hooks":[]}]}}"#,
        );

        let kinds = [ComponentKind::Hook];
        project_pack(
            &root,
            "global",
            "demo-pack",
            "claude-code",
            Some(&kinds),
            false,
        )
        .unwrap();

        let read = |root: &Path| -> serde_json::Value {
            serde_json::from_str(&fs::read_to_string(root.join(".claude/settings.json")).unwrap())
                .unwrap()
        };
        let v = read(&root);
        assert_eq!(v["model"], "opus"); // unrelated key preserved
        let arr = v["hooks"]["PreToolUse"].as_array().unwrap();
        assert!(arr.iter().any(|e| e["matcher"] == "X")); // foreign hook preserved
        let tagged = arr
            .iter()
            .filter(|e| e.get("_atlasPack").and_then(|t| t.as_str()) == Some("demo-pack"))
            .count();
        assert_eq!(tagged, 1);

        // Re-project → still exactly one tagged entry (no dupes), X still there.
        project_pack(
            &root,
            "global",
            "demo-pack",
            "claude-code",
            Some(&kinds),
            false,
        )
        .unwrap();
        let v2 = read(&root);
        let arr2 = v2["hooks"]["PreToolUse"].as_array().unwrap();
        let tagged2 = arr2
            .iter()
            .filter(|e| e.get("_atlasPack").and_then(|t| t.as_str()) == Some("demo-pack"))
            .count();
        assert_eq!(tagged2, 1);
        assert!(arr2.iter().any(|e| e["matcher"] == "X"));

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn pack_project_hook_rewrites_plugin_root_to_store_dir() {
        let src = make_full_src_pack();
        let root = installed_root(&src);

        project_pack(
            &root,
            "global",
            "demo-pack",
            "claude-code",
            Some(&[ComponentKind::Hook]),
            false,
        )
        .unwrap();

        let settings: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join(".claude/settings.json")).unwrap())
                .unwrap();
        let cmd = settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();

        let store = root.join(".atlas/packs/demo-pack");
        let store_str = store.to_string_lossy().to_string();
        // The unresolved `${...}` placeholder is gone, replaced by the store dir.
        assert!(
            !cmd.contains("${CLAUDE_PLUGIN_ROOT}"),
            "placeholder not rewritten: {cmd}"
        );
        assert!(
            cmd.contains(&store_str),
            "command should point at store dir: {cmd}"
        );
        assert!(cmd.ends_with("/scripts/setup.js"));
        // …and the root is exported so runtime env lookups resolve too.
        assert!(
            cmd.starts_with(&format!(
                "CLAUDE_PLUGIN_ROOT={} ",
                sh_single_quote(&store_str)
            )),
            "command should export plugin root: {cmd}"
        );

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn pack_project_hook_exports_root_for_runtime_env_bootstrap() {
        // ECC-style hook: no literal `${...}` — it reads process.env at runtime
        // (note the inner `process.env.CLAUDE_PLUGIN_ROOT=r` must NOT be mistaken
        // for a leading shell assignment).
        let src = tmp_pack_dir();
        write_file(
            &src.join(".claude-plugin/plugin.json"),
            r#"{"name":"boot-pack"}"#,
        );
        write_file(
            &src.join("hooks/hooks.json"),
            r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"node -e \"var r=process.env.CLAUDE_PLUGIN_ROOT;process.env.CLAUDE_PLUGIN_ROOT=r;require(r)\""}]}]}}"#,
        );
        let root = installed_root(&src);

        project_pack(
            &root,
            "global",
            "boot-pack",
            "claude-code",
            Some(&[ComponentKind::Hook]),
            false,
        )
        .unwrap();

        let settings: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join(".claude/settings.json")).unwrap())
                .unwrap();
        let cmd = settings["hooks"]["PreToolUse"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap();
        let store_str = root
            .join(".atlas/packs/boot-pack")
            .to_string_lossy()
            .to_string();
        assert!(
            cmd.starts_with(&format!(
                "CLAUDE_PLUGIN_ROOT={} node -e",
                sh_single_quote(&store_str)
            )),
            "runtime-env hook should be prefixed with the root: {cmd}"
        );

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn pack_project_codex_appends_rule_block_idempotently() {
        let src = make_full_src_pack();
        let root = installed_root(&src);
        let kinds = [ComponentKind::Rule];

        project_pack(&root, "global", "demo-pack", "codex", Some(&kinds), false).unwrap();
        let agents_md = root.join("AGENTS.md");
        let start = "<!-- atlas-pack:demo-pack:style START -->";
        let body = fs::read_to_string(&agents_md).unwrap();
        assert_eq!(body.matches(start).count(), 1);
        assert!(body.contains("rule body"));

        // Re-project → block replaced in place (still exactly one).
        project_pack(&root, "global", "demo-pack", "codex", Some(&kinds), false).unwrap();
        let body2 = fs::read_to_string(&agents_md).unwrap();
        assert_eq!(body2.matches(start).count(), 1);

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn pack_unproject_removes_links_hooks_and_rule_blocks() {
        let src = make_full_src_pack();
        let root = installed_root(&src);
        project_pack(&root, "global", "demo-pack", "claude-code", None, false).unwrap();
        project_pack(&root, "global", "demo-pack", "codex", None, false).unwrap();
        assert!(root
            .join(".claude/agents/rev.md")
            .symlink_metadata()
            .is_ok());
        assert!(root.join("AGENTS.md").is_file());

        // Unproject claude-code: agent link gone, our hook entry stripped.
        unproject_pack(&root, "demo-pack", "claude-code").unwrap();
        assert!(root
            .join(".claude/agents/rev.md")
            .symlink_metadata()
            .is_err());
        let v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(root.join(".claude/settings.json")).unwrap())
                .unwrap();
        if let Some(arr) = v["hooks"]["PreToolUse"].as_array() {
            assert!(!arr
                .iter()
                .any(|e| e.get("_atlasPack").and_then(|t| t.as_str()) == Some("demo-pack")));
        }
        // claude-code subtree gone; codex remains.
        let proj = read_pack_proj(&root);
        let tools = proj.projections.get("demo-pack").unwrap();
        assert!(!tools.contains_key("claude-code"));
        assert!(tools.contains_key("codex"));

        // Unproject codex: AGENTS.md block removed, pack subtree empties out.
        unproject_pack(&root, "demo-pack", "codex").unwrap();
        let body = fs::read_to_string(root.join("AGENTS.md")).unwrap_or_default();
        assert!(!body.contains("atlas-pack:demo-pack:style"));
        assert!(!read_pack_proj(&root).projections.contains_key("demo-pack"));

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn pack_project_unproject_round_trip() {
        let src = make_full_src_pack();
        let root = installed_root(&src);

        project_pack(&root, "global", "demo-pack", "claude-code", None, false).unwrap();
        unproject_pack(&root, "demo-pack", "claude-code").unwrap();
        assert!(root
            .join(".claude/agents/rev.md")
            .symlink_metadata()
            .is_err());

        // Re-project after unproject works again.
        let report =
            project_pack(&root, "global", "demo-pack", "claude-code", None, false).unwrap();
        assert!(root
            .join(".claude/agents/rev.md")
            .symlink_metadata()
            .is_ok());
        assert!(report
            .iter()
            .any(|r| r.kind == ComponentKind::Agent && r.status == "projected"));

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn pack_project_skips_foreign_dir_conflict_unless_forced() {
        let src = make_full_src_pack();
        let root = installed_root(&src);
        // A foreign file already sits at the agent target.
        write_file(&root.join(".claude/agents/rev.md"), "FOREIGN");

        let kinds = [ComponentKind::Agent];
        let report = project_pack(
            &root,
            "global",
            "demo-pack",
            "claude-code",
            Some(&kinds),
            false,
        )
        .unwrap();
        assert!(report
            .iter()
            .any(|r| r.kind == ComponentKind::Agent && r.status == "conflict"));
        assert_eq!(
            fs::read_to_string(root.join(".claude/agents/rev.md")).unwrap(),
            "FOREIGN"
        );

        // Force overwrites with our symlink.
        project_pack(
            &root,
            "global",
            "demo-pack",
            "claude-code",
            Some(&kinds),
            true,
        )
        .unwrap();
        assert!(root
            .join(".claude/agents/rev.md")
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&src).ok();
    }

    #[test]
    fn pack_components_list_returns_command_agent_rule_only() {
        let root = tmp_root();
        let src = make_full_src_pack();
        install_pack_from_dir(&root, &src, "o/r", "c1", false).unwrap();
        fs::remove_dir_all(&src).ok();

        let comps = pack_components(&root);
        assert!(comps
            .iter()
            .any(|c| c.kind == ComponentKind::Agent && c.name == "rev"));
        assert!(comps
            .iter()
            .any(|c| c.kind == ComponentKind::Command && c.name == "ship"));
        assert!(comps
            .iter()
            .any(|c| c.kind == ComponentKind::Rule && c.name == "style"));
        // Skills, hooks, and scripts are not chat-invokable components.
        assert!(!comps.iter().any(|c| c.kind == ComponentKind::Skill));
        assert!(!comps.iter().any(|c| c.kind == ComponentKind::Hook));
        assert!(!comps.iter().any(|c| c.kind == ComponentKind::Script));
        // The body path points at the component's `.md` and exists on disk.
        let ship = comps.iter().find(|c| c.name == "ship").unwrap();
        assert!(ship.path.ends_with("commands/ship.md"));
        assert!(Path::new(&ship.path).is_file());

        fs::remove_dir_all(&root).ok();
    }

    /// `atlas-instruction-sync` re-derives these to find a pack's rule in
    /// `AGENTS.md` (it sits below `src-tauri` and cannot call them). If they
    /// drift, a pack rule is mirrored a second time.
    #[test]
    fn instruction_sync_derives_pack_rule_markers_the_same_way() {
        for name in [
            "Style Guide",
            "a__b..c",
            "-x!!y-",
            "  Ask Before  Paid Runs ",
        ] {
            let ours = sanitize_name(name).unwrap();
            assert_eq!(atlas_instruction_sync::pack_rule_name(name), ours);
            assert_eq!(
                atlas_instruction_sync::pack_rule_marker("pack", &ours),
                rule_marker_start("pack", &ours)
            );
        }
    }
}
