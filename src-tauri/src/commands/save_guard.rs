//! Guard for renderer-directed save destinations.
//!
//! A handful of commands (`comms_save_recording`, `comms_save_attachment`,
//! `usage_write_file`, `usage_export_markdown`) take an absolute `dest` from
//! the renderer
//! and write bytes there. The path comes from a native save dialog in the
//! honest case — but the command cannot see the dialog, only the string, so
//! a compromised renderer could name `~/.ssh/authorized_keys` or a shell
//! profile and turn "save a recording" into persistence.
//!
//! This is a DENY-list of catastrophic targets rather than an allow-list of
//! nice ones, on purpose: a save dialog can legitimately point anywhere the
//! user manages (external drives included), and enumerating "allowed"
//! locations would break real saves. What it refuses:
//!
//!   - relative paths (a dialog always answers absolute),
//!   - any dot-directory under `$HOME` (`~/.ssh`, `~/.aws`, `~/.zshrc`,
//!     `~/.atlas`, …) — user-visible saves live in visible folders,
//!   - `~/Library` (keychains, LaunchAgents, app containers),
//!   - system roots (`/etc`, `/usr`, `/bin`, `/sbin`, `/var`, `/System`,
//!     `/Library`, `/Applications`, `/private/etc`).

use std::path::{Component, Path};

pub fn guard_save_dest(dest: &str) -> Result<(), String> {
    let path = Path::new(dest);
    if !path.is_absolute() {
        return Err("save destination must be an absolute path".into());
    }
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("save destination must not contain '..'".into());
    }

    guard_path(
        path,
        dirs::home_dir().as_deref(),
        cfg!(any(target_os = "macos", target_os = "windows")),
    )
}

fn guard_path(path: &Path, home: Option<&Path>, case_insensitive: bool) -> Result<(), String> {
    let parts = |path: &Path| {
        path.components()
            .map(|c| {
                let value = c.as_os_str().to_string_lossy().into_owned();
                if case_insensitive {
                    value.to_lowercase()
                } else {
                    value
                }
            })
            .collect::<Vec<_>>()
    };
    let target = parts(path);
    if let Some(home) = home {
        let home = parts(home);
        if let Some(rel) = target.strip_prefix(home.as_slice()) {
            let first = rel
                .first()
                .ok_or("refusing to overwrite your home directory")?;
            if first.starts_with('.') {
                return Err("refusing to write into a hidden directory in your home".into());
            }
            if first.eq_ignore_ascii_case("Library") {
                return Err("refusing to write into ~/Library".into());
            }
            // Silverblue's home is /var/home; visible files there are user
            // destinations even though other /var trees remain protected.
            return Ok(());
        }
    }
    for root in [
        "/etc",
        "/usr",
        "/bin",
        "/sbin",
        "/var",
        "/System",
        "/Library",
        "/Applications",
        "/private/etc",
        "/private/var",
    ] {
        if target.starts_with(&parts(Path::new(root))) {
            return Err(format!("refusing to write under {root}"));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{guard_path, guard_save_dest};
    use std::path::Path;

    #[test]
    fn visible_home_saves_precede_system_roots_and_case_folding_protects_settings() {
        let home = Path::new("/var/home/me");
        assert!(guard_path(Path::new("/var/home/me/Downloads/a.pdf"), Some(home), false).is_ok());
        assert!(guard_path(Path::new("/var/home/me/.ssh/id"), Some(home), false).is_err());
        assert!(guard_path(Path::new("/var/lib/a"), Some(home), false).is_err());
        assert!(guard_path(
            Path::new("/users/me/library/LaunchAgents/a"),
            Some(Path::new("/Users/Me")),
            true
        )
        .is_err());
        assert!(guard_path(Path::new("/applications/a"), None, true).is_err());
    }

    #[test]
    fn ordinary_save_targets_pass() {
        let home = dirs::home_dir().unwrap();
        for p in ["Downloads/track.webm", "Desktop/a.png", "Documents/x/y.pdf"] {
            let dest = home.join(p);
            assert!(guard_save_dest(&dest.to_string_lossy()).is_ok(), "{p}");
        }
        assert!(guard_save_dest("/tmp/scratch.bin").is_ok());
    }

    #[test]
    fn persistence_targets_are_refused() {
        let home = dirs::home_dir().unwrap();
        for p in [
            ".ssh/authorized_keys",
            ".zshrc",
            ".aws/credentials",
            ".atlas/auth/atlas-session.json",
            "Library/LaunchAgents/evil.plist",
            "Library/Keychains/login.keychain-db",
        ] {
            let dest = home.join(p);
            assert!(guard_save_dest(&dest.to_string_lossy()).is_err(), "{p}");
        }
        for p in ["/etc/pam.d/sudo", "/usr/local/bin/git", "relative/path.txt"] {
            assert!(guard_save_dest(p).is_err(), "{p}");
        }
    }
}
