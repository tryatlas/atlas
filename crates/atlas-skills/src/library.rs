//! The skill library: list, read, adopt, enable, delete, promote and install
//! a single skill, over the canonical store and the tools' own directories.

use crate::disk::{copy_dir_all, remove_symlink};
use crate::frontmatter::parse_frontmatter;
use crate::ledger::{read_ledger, write_ledger};
use crate::model::{AgentTarget, ComponentKind, SkillContent, SkillMeta};
use crate::packs::install::list_installed_packs;
use crate::packs::parse::pack_parse;
use crate::packs::source::{parse_owner_repo, PackSource};
use crate::paths::{canonical_skill_dir, migrate_legacy_skills, sanitize_name, skills_base};
use crate::projection::{project, unproject};
use crate::registry::{
    tool_def, tool_detected, tool_has_entry, tool_link_path, tool_skills_dir, TOOL_REGISTRY,
};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

// ── Core (testable, no Tauri) ──────────────────────────────────────────────────

pub(crate) fn list_skills(root: &Path, scope: &str) -> Result<Vec<SkillMeta>, String> {
    // One-time move of anything left in the pre-convergence `.atlas/skills`
    // store into the new canonical `.agents/skills` store. No-op once migrated.
    migrate_legacy_skills(root);

    // Keyed by the sanitized skill name so canonical + external entries dedupe.
    let mut by_name: BTreeMap<String, SkillMeta> = BTreeMap::new();

    // ── 1. Canonical (managed) skills under `<root>/.agents/skills/*`. ─────────
    let base = skills_base(root);
    if let Ok(entries) = fs::read_dir(&base) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Some(raw_name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            // Sanitize the on-disk dir name before using it to build tool link
            // paths; skip entries whose name can't be made safe.
            let Ok(safe_name) = sanitize_name(&raw_name) else {
                continue;
            };
            let skill_md = entry.path().join("SKILL.md");
            let Ok(raw) = fs::read_to_string(&skill_md) else {
                continue; // dir without a SKILL.md isn't a skill
            };
            let (fm, _body) = parse_frontmatter(&raw);
            let enabled_agents: Vec<String> = TOOL_REGISTRY
                .iter()
                .filter(|def| tool_has_entry(root, def, scope, &safe_name))
                .map(|def| def.id.to_string())
                .collect();

            by_name.insert(
                safe_name.clone(),
                SkillMeta {
                    name: fm.name.unwrap_or_else(|| safe_name.clone()),
                    description: fm.description.unwrap_or_default(),
                    scope: scope.to_string(),
                    enabled_agents,
                    path: skill_md.to_string_lossy().to_string(),
                    delivery: "native-dir".to_string(),
                    managed: true,
                    pack: None,
                },
            );
        }
    }

    // ── 2. External (unmanaged) skills living directly in each tool dir. ───────
    // A top-level entry — real directory OR symlink to one — with its own
    // `SKILL.md` and NOT one of our canonical skills is an external tool skill.
    // Symlinks are followed rather than rejected (ADR 0005): most of them are
    // exactly the `.agents/skills` projections skills.sh/Zed/Atlas itself write,
    // and those resolving into our own canonical store are already accounted for
    // above (the `by_name.contains_key` check below skips them). Container dirs
    // without a top-level `SKILL.md` (e.g. `~/.claude/skills/ecc/`) are skipped —
    // no recursion (v1).
    for def in TOOL_REGISTRY.iter() {
        let dir = tool_skills_dir(def, scope, root);
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            // Follow symlinks: only reject non-directories (files, broken links).
            if !entry.path().is_dir() {
                continue;
            }
            let skill_md = entry.path().join("SKILL.md");
            if !skill_md.is_file() {
                continue; // container dir without a top-level SKILL.md → skip
            }
            let Some(raw_name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Ok(safe_name) = sanitize_name(&raw_name) else {
                continue;
            };
            // A managed skill of the same name wins; don't downgrade it.
            if by_name.contains_key(&safe_name) {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&skill_md) else {
                continue;
            };
            let (fm, _body) = parse_frontmatter(&raw);

            let meta = by_name
                .entry(safe_name.clone())
                .or_insert_with(|| SkillMeta {
                    name: fm.name.clone().unwrap_or_else(|| safe_name.clone()),
                    description: fm.description.clone().unwrap_or_default(),
                    scope: scope.to_string(),
                    enabled_agents: Vec::new(),
                    path: skill_md.to_string_lossy().to_string(),
                    delivery: "native-dir".to_string(),
                    managed: false,
                    pack: None,
                });
            if !meta.enabled_agents.iter().any(|a| a == def.id) {
                meta.enabled_agents.push(def.id.to_string());
            }
        }
    }

    // ── 3. Pack-provided skills (installed packs' `Skill` components). ─────────
    // A skill shipped by an installed pack is a first-class skill even before
    // it is projected into a tool. Surface it here (badged with its pack) so
    // My Skills sees it. An authored or external skill of the same name
    // wins — don't downgrade it.
    for (pack_name, safe_name, skill_md) in pack_provided_skills(root) {
        if by_name.contains_key(&safe_name) {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&skill_md) else {
            continue;
        };
        let (fm, _body) = parse_frontmatter(&raw);
        // Which tools currently host this pack's skill projection at this scope.
        let enabled_agents: Vec<String> = TOOL_REGISTRY
            .iter()
            .filter(|def| tool_has_entry(root, def, scope, &safe_name))
            .map(|def| def.id.to_string())
            .collect();
        by_name.insert(
            safe_name.clone(),
            SkillMeta {
                name: fm.name.unwrap_or_else(|| safe_name.clone()),
                description: fm.description.unwrap_or_default(),
                scope: scope.to_string(),
                enabled_agents,
                path: skill_md.to_string_lossy().to_string(),
                delivery: "native-dir".to_string(),
                managed: false,
                pack: Some(pack_name),
            },
        );
    }

    let mut out: Vec<SkillMeta> = by_name.into_values().collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

pub(crate) fn read_skill(root: &Path, name: &str) -> Result<SkillContent, String> {
    let safe = sanitize_name(name)?;
    let dir = canonical_skill_dir(&skills_base(root), &safe)?;
    let skill_md = dir.join("SKILL.md");
    let raw = match fs::read_to_string(&skill_md) {
        Ok(raw) => raw,
        // Not in the canonical store — fall back to an installed pack that ships
        // a skill of this name, so pack-provided skills are readable too.
        Err(_) => pack_skill_md(root, &safe)
            .and_then(|p| fs::read_to_string(&p).ok())
            .ok_or_else(|| format!("skill not found: {safe}"))?,
    };
    let (fm, body) = parse_frontmatter(&raw);
    Ok(SkillContent {
        name: fm.name.unwrap_or(safe),
        description: fm.description.unwrap_or_default(),
        body,
        raw,
    })
}

// ── Cross-ledger: pack awareness (Skills-side, read-only) ────────────────────────
//
// Packs own their own projection ledger (`.atlas/packs/.pack-projections.json`).
// The Skills subsystem reads it one-directionally — never writes it — so that a
// pack-delivered skill is a first-class skill in every listing and so the
// Skills side never silently clobbers a projection a pack owns.

/// Every skill shipped by an installed pack, as `(pack_name, safe_skill_name,
/// abs_skill_md_path)`. Reused by `list_skills`, `read_skill`, and `reconcile`.
pub(crate) fn pack_provided_skills(root: &Path) -> Vec<(String, String, PathBuf)> {
    let mut out = Vec::new();
    for installed in list_installed_packs(root).unwrap_or_default() {
        for comp in &installed.pack.components {
            if comp.kind != ComponentKind::Skill {
                continue;
            }
            let Ok(safe) = sanitize_name(&comp.name) else {
                continue;
            };
            let md = Path::new(&installed.pack.root)
                .join(&comp.rel_path)
                .join("SKILL.md");
            out.push((installed.pack.name.clone(), safe, md));
        }
    }
    out
}

/// The `SKILL.md` of an installed pack's skill named `safe_name`, if any.
fn pack_skill_md(root: &Path, safe_name: &str) -> Option<PathBuf> {
    pack_provided_skills(root)
        .into_iter()
        .find(|(_, name, _)| name == safe_name)
        .map(|(_, _, md)| md)
}

/// "Make for all agents": adopt an external/single-agent skill into the
/// canonical store and fan it out to every detected tool as a projection.
pub(crate) fn adopt_skill(root: &Path, scope: &str, name: &str) -> Result<SkillMeta, String> {
    let safe = sanitize_name(name)?;
    let canonical = canonical_skill_dir(&skills_base(root), &safe)?;
    let canonical_md = canonical.join("SKILL.md");

    // 1. Locate the source. Prefer the canonical copy if it already exists;
    //    otherwise the first registry tool dir that holds a real skill dir.
    if !canonical_md.is_file() {
        let mut source: Option<PathBuf> = None;
        for def in TOOL_REGISTRY.iter() {
            let link = tool_link_path(root, def, scope, &safe);
            // Only adopt from a real directory with its own SKILL.md (an
            // external skill). A symlink would already point at canonical.
            let Ok(meta) = link.symlink_metadata() else {
                continue;
            };
            if meta.file_type().is_symlink() {
                continue;
            }
            if link.is_dir() && link.join("SKILL.md").is_file() {
                source = Some(link);
                break;
            }
        }
        let source = source.ok_or_else(|| format!("skill not found to adopt: {safe}"))?;
        // 2. Copy the entire source dir into canonical (never delete the original).
        copy_dir_all(&source, &canonical)?;
    }

    // 3. For each DETECTED tool: project (symlink/copy) from canonical. The
    //    original external dir, if present, hashes equal to the just-copied
    //    canonical, so the non-destructive guard lets `project` replace it.
    let mut enabled_agents = Vec::new();
    for def in TOOL_REGISTRY.iter() {
        if !tool_detected(root, def) || def.delivery == "inject-only" {
            continue;
        }
        project(root, def, scope, &safe, false)?;
        enabled_agents.push(def.id.to_string());
    }
    enabled_agents.sort();
    enabled_agents.dedup();

    let raw = fs::read_to_string(&canonical_md).map_err(|e| e.to_string())?;
    let (fm, _body) = parse_frontmatter(&raw);
    Ok(SkillMeta {
        name: fm.name.unwrap_or_else(|| safe.clone()),
        description: fm.description.unwrap_or_default(),
        scope: scope.to_string(),
        enabled_agents,
        path: canonical_md.to_string_lossy().to_string(),
        delivery: "native-dir".to_string(),
        managed: true,
        pack: None,
    })
}

pub(crate) fn set_enabled(
    root: &Path,
    scope: &str,
    name: &str,
    agent: &str,
    enabled: bool,
) -> Result<(), String> {
    let safe = sanitize_name(name)?;
    // Ensure the canonical skill exists before toggling a projection.
    let dir = canonical_skill_dir(&skills_base(root), &safe)?;
    if !dir.join("SKILL.md").is_file() {
        return Err(format!("skill not found: {safe}"));
    }
    let def = tool_def(agent).ok_or_else(|| format!("unknown agent: {agent}"))?;
    if enabled {
        project(root, def, scope, &safe, false)
    } else {
        unproject(root, def, scope, &safe)
    }
}

pub(crate) fn delete_skill(root: &Path, scope: &str, name: &str) -> Result<(), String> {
    let safe = sanitize_name(name)?;
    let dir = canonical_skill_dir(&skills_base(root), &safe)?;
    // Remove every registry tool's projection first, then the canonical dir.
    for def in TOOL_REGISTRY.iter() {
        remove_symlink(root, def, scope, &safe)?;
    }
    let mut ledger = read_ledger(root);
    ledger.projections.remove(&safe);
    write_ledger(root, &ledger).ok();
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("remove {}: {e}", dir.display()))?;
    }
    Ok(())
}

pub(crate) fn skill_path(root: &Path, name: &str) -> Result<String, String> {
    let safe = sanitize_name(name)?;
    let dir = canonical_skill_dir(&skills_base(root), &safe)?;
    let skill_md = dir.join("SKILL.md");
    if !skill_md.is_file() {
        return Err(format!("skill not found: {safe}"));
    }
    Ok(skill_md.to_string_lossy().to_string())
}

pub(crate) fn list_targets(root: &Path, scope: &str) -> Vec<AgentTarget> {
    TOOL_REGISTRY
        .iter()
        .map(|def| AgentTarget {
            id: def.id.to_string(),
            display_name: def.display_name.to_string(),
            skills_dir: tool_skills_dir(def, scope, root)
                .to_string_lossy()
                .to_string(),
            delivery: def.delivery.to_string(),
            detected: tool_detected(root, def),
        })
        .collect()
}

// ── Promote (CP.4 scenario 4) ────────────────────────────────────────────────────

/// Promote a project skill to global: copy `<proj>/.agents/skills/<name>` →
/// `~/.agents/skills/<name>`, then re-project into every detected tool at global
/// scope. The project copy is kept (the repo still travels with it).
pub(crate) fn promote(project_root: &Path, home: &Path, name: &str) -> Result<SkillMeta, String> {
    let safe = sanitize_name(name)?;
    let src = canonical_skill_dir(&skills_base(project_root), &safe)?;
    if !src.join("SKILL.md").is_file() {
        return Err(format!("project skill not found: {safe}"));
    }
    let dst = canonical_skill_dir(&skills_base(home), &safe)?;
    // Copy project canonical → global canonical (overwrite global copy).
    copy_dir_all(&src, &dst)?;

    let mut enabled_agents = Vec::new();
    for def in TOOL_REGISTRY.iter() {
        if !tool_detected(home, def) || def.delivery == "inject-only" {
            continue;
        }
        project(home, def, "global", &safe, false)?;
        enabled_agents.push(def.id.to_string());
    }
    enabled_agents.sort();
    enabled_agents.dedup();

    let raw = fs::read_to_string(dst.join("SKILL.md")).map_err(|e| e.to_string())?;
    let (fm, _b) = parse_frontmatter(&raw);
    Ok(SkillMeta {
        name: fm.name.unwrap_or_else(|| safe.clone()),
        description: fm.description.unwrap_or_default(),
        scope: "global".to_string(),
        enabled_agents,
        path: dst.join("SKILL.md").to_string_lossy().to_string(),
        delivery: "native-dir".to_string(),
        managed: true,
        pack: None,
    })
}

/// Install ONE skill from a cloned repo into the canonical store — the granular
/// counterpart to `install_pack_from_dir`. The skills.sh registry lists
/// individual skills (one `source` repo holds many), so installing a Discover row
/// should add just THAT skill as a managed skill (individually projectable +
/// uninstallable), not the whole repo. Network-free → unit-testable.
fn install_skill_from_dir(
    root: &Path,
    scope: &str,
    repo: &Path,
    skill_id: &str,
) -> Result<SkillMeta, String> {
    let parsed = pack_parse(repo)?;
    let comp = parsed
        .components
        .iter()
        .find(|c| c.kind == ComponentKind::Skill && c.name == skill_id)
        .ok_or_else(|| format!("skill '{skill_id}' not found in this repo"))?;
    let src_dir = repo.join(&comp.rel_path);
    if !src_dir.join("SKILL.md").is_file() {
        return Err(format!("skill '{skill_id}' has no SKILL.md"));
    }

    let safe = sanitize_name(skill_id)?;
    let dst = canonical_skill_dir(&skills_base(root), &safe)?;
    if dst.symlink_metadata().is_ok() {
        return Err(format!(
            "skill '{safe}' is already installed; its local copy has been kept"
        ));
    }
    copy_dir_all(&src_dir, &dst)?;

    // Project immediately into every currently-detected agent, the way
    // `npx skills add` does (ADR 0005) — a freshly installed skill must be
    // visible right away, not stuck until the user finds the per-agent toggles
    // in another tab. Same fan-out `adopt_skill`/`promote` use; the per-agent
    // toggles remain for changing your mind later.
    let mut enabled_agents = Vec::new();
    for def in TOOL_REGISTRY.iter() {
        if !tool_detected(root, def) || def.delivery == "inject-only" {
            continue;
        }
        project(root, def, scope, &safe, false)?;
        enabled_agents.push(def.id.to_string());
    }
    enabled_agents.sort();
    enabled_agents.dedup();

    let raw = fs::read_to_string(dst.join("SKILL.md")).map_err(|e| e.to_string())?;
    let (fm, _b) = parse_frontmatter(&raw);
    Ok(SkillMeta {
        name: fm.name.unwrap_or_else(|| safe.clone()),
        description: fm.description.unwrap_or_default(),
        scope: scope.to_string(),
        enabled_agents,
        path: dst.join("SKILL.md").to_string_lossy().to_string(),
        delivery: "native-dir".to_string(),
        managed: true,
        pack: None,
    })
}

// ── Plugin skills (read-only fourth discovery channel, ADR 0005) ─────────────────
//
// Claude Code plugin marketplaces ship their own bundled skills under
// `~/.claude/plugins/marketplaces/<marketplace>/skills/<name>/SKILL.md`. These
// are a genuinely foreign channel: never installable, projectable, or
// uninstallable through Atlas. They already reach the picker because the
// *agent* advertises them over ACP — Atlas only needs to find them so the
// Skills UI's browsing surface can show they exist. Not merged into
// `SkillMeta`/`list_skills`: that type's `managed`/`enabled_agents` fields
// describe things Atlas can toggle, which is exactly what these are not.

// TODO(codex plugin skills): Codex's plugin directory layout is unverified —
// `~/.codex/plugins/` exists on the maintainer's machine but contains only a
// `cache/` dir, not a `marketplaces/*/skills` tree like Claude Code's. Add a
// `list_codex_plugin_skills(home)` here (same read-only pattern, folded into
// `list_plugin_skills` below) once a real Codex plugin install reveals the
// actual layout — don't guess at a path that might be wrong.

/// Install a single skill (`skill_id`) from a `source` repo as a managed
/// skill. Granular alternative to installing the whole pack.
pub(crate) fn install_skill_from_source(
    root: &Path,
    scope: &str,
    from: &dyn PackSource,
    source: &str,
    skill_id: &str,
) -> Result<SkillMeta, String> {
    let (owner, repo) = parse_owner_repo(source)?;
    let (tmp, _commit) = from.fetch(&owner, &repo)?;
    let res = install_skill_from_dir(root, scope, &tmp, skill_id);
    let _ = fs::remove_dir_all(&tmp);
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::legacy_skills_base;
    use crate::test_support::{
        create_skill, make_src_pack, plant_external, plant_symlinked_external,
        root_with_installed_pack, tmp_root,
    };

    #[test]
    fn create_then_list_round_trip() {
        let root = tmp_root();
        let meta = create_skill(
            &root,
            "project",
            "PDF Extract",
            "Pull text out of PDFs",
            "Use pdftotext.",
            &["claude-code".to_string()],
        )
        .unwrap();
        assert_eq!(meta.name, "pdf-extract");
        assert_eq!(meta.enabled_agents, vec!["claude-code".to_string()]);

        let listed = list_skills(&root, "project").unwrap();
        assert_eq!(listed.len(), 1);
        let s = &listed[0];
        assert_eq!(s.name, "pdf-extract");
        assert_eq!(s.description, "Pull text out of PDFs");
        // codex is auto-included: its project-scope skills dir IS the canonical
        // store post-convergence (ADR 0005), so any canonical skill is already
        // there — no explicit projection needed.
        assert_eq!(
            s.enabled_agents,
            vec!["claude-code".to_string(), "codex".to_string()]
        );

        // Canonical SKILL.md exists, symlink exists for claude-code.
        assert!(root.join(".agents/skills/pdf-extract/SKILL.md").is_file());
        assert!(root
            .join(".claude/skills/pdf-extract")
            .symlink_metadata()
            .is_ok());
        // `.agents/skills/pdf-extract` IS the canonical dir above, not a separate
        // codex projection — same path, no symlink involved.

        // Round-trip the body via read_skill.
        let content = read_skill(&root, "pdf-extract").unwrap();
        assert_eq!(content.description, "Pull text out of PDFs");
        assert_eq!(content.body.trim(), "Use pdftotext.");

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn symlink_target_resolves_to_canonical() {
        let root = tmp_root();
        create_skill(
            &root,
            "project",
            "demo",
            "d",
            "body",
            &["claude-code".to_string()],
        )
        .unwrap();
        let link = root.join(".claude/skills/demo");
        // Following the link reaches the canonical SKILL.md.
        let resolved = fs::canonicalize(link.join("SKILL.md")).unwrap();
        let expected = fs::canonicalize(root.join(".agents/skills/demo/SKILL.md")).unwrap();
        assert_eq!(resolved, expected);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn set_enabled_toggles_symlink() {
        let root = tmp_root();
        create_skill(&root, "project", "demo", "d", "b", &[]).unwrap();

        // claude-code has its own dir — a real toggleable symlink projection.
        let claude_link = root.join(".claude/skills/demo");
        assert!(claude_link.symlink_metadata().is_err());
        set_enabled(&root, "project", "demo", "claude-code", true).unwrap();
        assert!(claude_link.symlink_metadata().is_ok());
        set_enabled(&root, "project", "demo", "claude-code", false).unwrap();
        assert!(claude_link.symlink_metadata().is_err());

        // codex's project-scope skills dir IS the canonical store post-
        // convergence (ADR 0005): already "enabled" the moment the skill
        // exists, enabling again is a no-op, and disabling is refused rather
        // than deleting the canonical skill.
        let codex_path = root.join(".agents/skills/demo");
        assert!(codex_path.symlink_metadata().is_ok());
        set_enabled(&root, "project", "demo", "codex", true).unwrap();
        assert!(set_enabled(&root, "project", "demo", "codex", false).is_err());
        assert!(
            codex_path.join("SKILL.md").is_file(),
            "disabling codex must not delete the canonical skill"
        );

        // Toggling for an unknown agent errors.
        assert!(set_enabled(&root, "project", "demo", "nope", true).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn delete_removes_canonical_and_symlinks() {
        let root = tmp_root();
        create_skill(
            &root,
            "project",
            "demo",
            "d",
            "b",
            &["claude-code".to_string(), "codex".to_string()],
        )
        .unwrap();
        // `.agents/skills/demo` is both the canonical dir AND codex's project
        // skills dir post-convergence (ADR 0005) — same path.
        assert!(root.join(".agents/skills/demo").is_dir());
        assert!(root.join(".claude/skills/demo").symlink_metadata().is_ok());

        delete_skill(&root, "project", "demo").unwrap();
        assert!(!root.join(".agents/skills/demo").exists());
        assert!(root.join(".claude/skills/demo").symlink_metadata().is_err());

        // Listing is now empty.
        assert!(list_skills(&root, "project").unwrap().is_empty());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_targets_reports_detection() {
        let root = tmp_root();
        // Registry is claude-code + codex. tmp_root creates .claude and .codex,
        // so both are detected.
        let targets = list_targets(&root, "global");
        assert_eq!(targets.len(), 3); // claude-code, codex, atlas
        assert!(targets.iter().any(|t| t.id == "claude-code" && t.detected));
        assert!(targets.iter().any(|t| t.id == "codex" && t.detected));
        // The native Atlas agent is in-process → always detected.
        assert!(targets.iter().any(|t| t.id == "atlas" && t.detected));

        // Remove codex's config dir → not detected.
        fs::remove_dir_all(root.join(".codex")).unwrap();
        let targets = list_targets(&root, "global");
        let codex = targets.iter().find(|t| t.id == "codex").unwrap();
        assert!(!codex.detected);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn promote_copies_project_skill_to_global() {
        let home = tmp_root();
        let proj = tmp_root();
        create_skill(&proj, "project", "pr", "Promote me", "b", &[]).unwrap();

        let meta = promote(&proj, &home, "pr").unwrap();
        assert_eq!(meta.name, "pr");
        assert!(home.join(".agents/skills/pr/SKILL.md").is_file());
        fs::remove_dir_all(&home).ok();
        fs::remove_dir_all(&proj).ok();
    }

    #[test]
    fn skill_path_errors_when_missing() {
        let root = tmp_root();
        assert!(skill_path(&root, "ghost").is_err());
        create_skill(&root, "project", "ghost", "d", "b", &[]).unwrap();
        assert!(skill_path(&root, "ghost")
            .unwrap()
            .ends_with("ghost/SKILL.md"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn canonical_base_is_under_dot_agents() {
        let root = tmp_root();
        assert_eq!(skills_base(&root), root.join(".agents/skills"));
        let meta = create_skill(&root, "project", "demo", "d", "b", &[]).unwrap();
        assert!(meta.path.contains("/.agents/skills/demo/"));
        assert!(meta.managed);
        assert!(root.join(".agents/skills/demo/SKILL.md").is_file());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn external_skill_is_listed_as_unmanaged() {
        let root = tmp_root();
        plant_external(&root, ".claude/skills", "foo", "External foo");

        let listed = list_skills(&root, "global").unwrap();
        assert_eq!(listed.len(), 1);
        let s = &listed[0];
        assert_eq!(s.name, "foo");
        assert!(!s.managed);
        assert_eq!(s.description, "External foo");
        assert_eq!(s.enabled_agents, vec!["claude-code".to_string()]);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn container_dir_without_skill_md_is_not_listed() {
        let root = tmp_root();
        // `~/.claude/skills/ecc/` nests skills one level deeper → no top-level
        // SKILL.md. Must be skipped (no recursion in v1).
        fs::create_dir_all(root.join(".claude/skills/ecc/nested")).unwrap();
        fs::write(
            root.join(".claude/skills/ecc/nested/SKILL.md"),
            "---\nname: nested\n---\nbody\n",
        )
        .unwrap();

        let listed = list_skills(&root, "global").unwrap();
        assert!(
            listed.is_empty(),
            "container dir must not be listed: {listed:?}"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn adopt_external_skill_makes_it_managed_for_all_agents() {
        let root = tmp_root(); // both .claude and .codex detected
        plant_external(&root, ".claude/skills", "foo", "External foo");
        // Sanity: pre-adopt it's unmanaged and claude-only.
        let pre = list_skills(&root, "global").unwrap();
        assert_eq!(pre.len(), 1);
        assert!(!pre[0].managed);

        let meta = adopt_skill(&root, "global", "foo").unwrap();
        assert!(meta.managed);
        assert_eq!(meta.description, "External foo");
        // "Make for all agents" now includes the always-present native Atlas agent
        // (enabled_agents is sorted alphabetically).
        assert_eq!(
            meta.enabled_agents,
            vec![
                "atlas".to_string(),
                "claude-code".to_string(),
                "codex".to_string()
            ]
        );

        // Canonical copy now exists.
        assert!(root.join(".agents/skills/foo/SKILL.md").is_file());
        // The original real dir was replaced by a symlink into canonical.
        let claude_link = root.join(".claude/skills/foo");
        assert!(claude_link
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        // And the other detected tool (codex, global dir) got a symlink too.
        let codex_link = root.join(".codex/skills/foo");
        assert!(codex_link
            .symlink_metadata()
            .unwrap()
            .file_type()
            .is_symlink());
        // Both resolve to the canonical SKILL.md.
        let expected = fs::canonicalize(root.join(".agents/skills/foo/SKILL.md")).unwrap();
        assert_eq!(
            fs::canonicalize(claude_link.join("SKILL.md")).unwrap(),
            expected
        );
        assert_eq!(
            fs::canonicalize(codex_link.join("SKILL.md")).unwrap(),
            expected
        );

        // Now listed once, managed=true.
        let post = list_skills(&root, "global").unwrap();
        assert_eq!(post.len(), 1);
        assert!(post[0].managed);
        assert_eq!(
            post[0].enabled_agents,
            vec![
                "claude-code".to_string(),
                "codex".to_string(),
                "atlas".to_string()
            ]
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn external_scan_follows_symlinked_skill_dirs() {
        let root = tmp_root();
        // A skill dir that lives outside both the canonical store and any
        // registry tool dir, symlinked into claude-code's skills dir — e.g. a
        // skills.sh/Zed-style projection Atlas didn't create itself.
        plant_symlinked_external(&root, "elsewhere", ".claude/skills", "linked");

        let listed = list_skills(&root, "global").unwrap();
        let s = listed.iter().find(|s| s.name == "linked").expect(
            "symlinked external skill dir must be discovered, not skipped as a managed marker",
        );
        assert!(!s.managed);
        assert_eq!(s.enabled_agents, vec!["claude-code".to_string()]);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn migrate_legacy_skills_moves_pre_convergence_store_content() {
        let root = tmp_root();
        // Simulate a pre-convergence Atlas install: a skill sitting in the old
        // `.atlas/skills` store, never touched by the new `.agents/skills` one.
        let legacy_dir = legacy_skills_base(&root).join("legacy-demo");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join("SKILL.md"),
            "---\nname: legacy-demo\ndescription: from before convergence\n---\n\nbody\n",
        )
        .unwrap();

        let listed = list_skills(&root, "global").unwrap();
        let s = listed
            .iter()
            .find(|s| s.name == "legacy-demo")
            .expect("legacy skill must be migrated and then discovered");
        assert!(s.managed);
        assert_eq!(s.description, "from before convergence");
        assert!(root.join(".agents/skills/legacy-demo/SKILL.md").is_file());
        assert!(
            !legacy_dir.exists(),
            "legacy copy should be moved, not left behind, when the rename succeeds"
        );

        // Idempotent: a second discovery pass is a no-op (nothing left to migrate).
        let listed_again = list_skills(&root, "global").unwrap();
        assert_eq!(listed_again.len(), 1);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn migrate_legacy_skills_does_not_clobber_existing_new_store_entry() {
        let root = tmp_root();
        // New store already has `demo`, with different content than the legacy
        // copy — the legacy copy must be left alone, not overwrite it.
        create_skill(&root, "global", "demo", "new content wins", "b", &[]).unwrap();
        let legacy_dir = legacy_skills_base(&root).join("demo");
        fs::create_dir_all(&legacy_dir).unwrap();
        fs::write(
            legacy_dir.join("SKILL.md"),
            "---\nname: demo\ndescription: stale legacy content\n---\n\nbody\n",
        )
        .unwrap();

        let listed = list_skills(&root, "global").unwrap();
        let s = listed.iter().find(|s| s.name == "demo").unwrap();
        assert_eq!(s.description, "new content wins");
        assert!(
            legacy_dir.exists(),
            "legacy copy is left in place, not deleted"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn install_skill_projects_to_detected_agents_immediately() {
        let root = tmp_root(); // both .claude and .codex detected
        let src = make_src_pack("v1");
        let meta = install_skill_from_dir(&root, "project", &src, "foo").unwrap();
        fs::remove_dir_all(&src).ok();

        // Installed skill is immediately visible to every detected agent, not
        // left with empty `enabled_agents` until a separate per-agent toggle.
        assert!(meta.enabled_agents.contains(&"claude-code".to_string()));
        assert!(meta.enabled_agents.contains(&"codex".to_string()));
        assert!(root.join(".claude/skills/foo").symlink_metadata().is_ok());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn pack_skill_appears_in_list_skills_badged() {
        let root = root_with_installed_pack();
        let listed = list_skills(&root, "global").unwrap();
        let foo = listed
            .iter()
            .find(|s| s.name == "foo")
            .expect("pack-provided skill is listed");
        assert_eq!(foo.pack.as_deref(), Some("demo-pack"));
        assert!(!foo.managed, "pack skill is not canonical-managed");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn read_skill_resolves_pack_provided_skill() {
        let root = root_with_installed_pack();
        // `foo` lives only in the pack store, not the canonical store.
        assert!(!root.join(".agents/skills/foo").exists());
        let content = read_skill(&root, "foo").unwrap();
        assert_eq!(content.body.trim(), "body");
        fs::remove_dir_all(&root).ok();
    }
}
