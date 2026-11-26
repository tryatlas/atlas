//! One rule for every child Atlas spawns: **no console window**.
//!
//! Atlas is a GUI process. On Windows a child of a GUI process that is not
//! itself a GUI program gets a fresh console (a `conhost.exe` and a window
//! that flashes on screen) unless it is created with `CREATE_NO_WINDOW`.
//! Opening one project in the release build spawned 30 `git` processes in
//! 40 seconds and put 25 console windows on the user's screen. Every spawn
//! site routes through [`NoWindow::no_window`], which is a no-op off Windows.
//!
//! This is only for children whose stdio Atlas owns (piped or null). A child
//! that is meant to have a console — the integrated terminal's shell — runs
//! under ConPTY and never comes through here.

/// Windows `CREATE_NO_WINDOW` process creation flag.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Suppress the console window a Windows GUI process would otherwise give a
/// child. Chainable, like the builder methods on both `Command` types.
pub trait NoWindow {
    fn no_window(&mut self) -> &mut Self;
}

impl NoWindow for std::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl NoWindow for tokio::process::Command {
    fn no_window(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

/// A `std` command that already carries [`NoWindow::no_window`].
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    cmd.env_clear().envs(host_environment());
    cmd.no_window();
    cmd
}

/// A `tokio` command that already carries [`NoWindow::no_window`].
pub fn async_command(program: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(program);
    cmd.env_clear().envs(host_environment());
    cmd.no_window();
    cmd
}

/// Environment for programs installed on the host. An AppImage's private
/// loader/GTK paths belong to Atlas itself; passing them to host binaries can
/// load incompatible libc/GTK modules. Explicit per-command values may be
/// added after this snapshot (for example an agent's managed Node PATH).
pub fn host_environment() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    sanitize_environment(std::env::vars_os().collect())
        .into_iter()
        .collect()
}

fn sanitize_environment(
    mut env: std::collections::BTreeMap<std::ffi::OsString, std::ffi::OsString>,
) -> std::collections::BTreeMap<std::ffi::OsString, std::ffi::OsString> {
    use std::ffi::OsStr;
    use std::path::Path;
    let Some(app_dir) = env.get(OsStr::new("APPDIR")).cloned() else {
        return env;
    };
    let app_dir = Path::new(&app_dir);
    if !app_dir.is_absolute() {
        return env;
    }
    for key in [
        "LD_LIBRARY_PATH",
        "LD_PRELOAD",
        "GTK_PATH",
        "GIO_EXTRA_MODULES",
        "GIO_MODULE_DIR",
        "GI_TYPELIB_PATH",
        "GSETTINGS_SCHEMA_DIR",
    ] {
        let Some(value) = env.get(OsStr::new(key)).cloned() else {
            continue;
        };
        let kept: Vec<_> = loader_paths(key, &value)
            .into_iter()
            .filter(|p| !p.starts_with(app_dir))
            .collect();
        if kept.is_empty() {
            env.remove(OsStr::new(key));
        } else if let Ok(value) = std::env::join_paths(kept) {
            env.insert(key.into(), value);
        }
    }
    // A launcher can preserve an explicit user override before choosing the
    // bundled app's theme. Without one, let each host application choose its
    // own desktop theme instead of forcing the AppImage's Adwaita choice.
    match env.remove(OsStr::new("ATLAS_HOST_GTK_THEME")) {
        Some(value) if !value.is_empty() => {
            env.insert("GTK_THEME".into(), value);
        }
        _ => {
            env.remove(OsStr::new("GTK_THEME"));
        }
    }
    env
}

fn loader_paths(key: &str, value: &std::ffi::OsStr) -> Vec<std::path::PathBuf> {
    #[cfg(unix)]
    if matches!(key, "LD_LIBRARY_PATH" | "LD_PRELOAD") {
        use std::os::unix::ffi::{OsStrExt, OsStringExt};
        return value
            .as_bytes()
            .split(|byte| {
                *byte == b':'
                    || (key == "LD_LIBRARY_PATH" && *byte == b';')
                    || (key == "LD_PRELOAD" && *byte == b' ')
            })
            .map(|bytes| std::ffi::OsString::from_vec(bytes.to_vec()).into())
            .collect();
    }
    #[cfg(not(unix))]
    let _ = key;
    std::env::split_paths(value).collect()
}

#[cfg(all(test, unix))]
mod environment_tests {
    #[test]
    fn host_paths_survive_but_appimage_paths_do_not() {
        let input = [
            ("APPDIR", "/tmp/.mount_atlas"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_atlas/usr/lib:/opt/host/lib"),
            ("GTK_PATH", "/tmp/.mount_atlas/usr/lib/gtk"),
            ("GTK_THEME", "Adwaita:dark"),
            ("PATH", "/home/me/bin:/usr/bin"),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
        let clean = super::sanitize_environment(input);
        assert_eq!(
            clean.get(std::ffi::OsStr::new("LD_LIBRARY_PATH")).unwrap(),
            "/opt/host/lib"
        );
        assert!(!clean.contains_key(std::ffi::OsStr::new("GTK_PATH")));
        assert!(!clean.contains_key(std::ffi::OsStr::new("GTK_THEME")));
        assert_eq!(
            clean.get(std::ffi::OsStr::new("PATH")).unwrap(),
            "/home/me/bin:/usr/bin"
        );
    }

    #[test]
    fn loader_specific_separators_preserve_host_entries() {
        let input = [
            ("APPDIR", "/tmp/.mount_atlas"),
            ("LD_LIBRARY_PATH", "/tmp/.mount_atlas/usr/lib;/opt/host/lib"),
            (
                "LD_PRELOAD",
                "/tmp/.mount_atlas/libhack.so /opt/host/a.so:/opt/host/b.so",
            ),
        ]
        .into_iter()
        .map(|(key, value)| (key.into(), value.into()))
        .collect();
        let clean = super::sanitize_environment(input);
        assert_eq!(
            clean.get(std::ffi::OsStr::new("LD_LIBRARY_PATH")).unwrap(),
            "/opt/host/lib"
        );
        assert_eq!(
            clean.get(std::ffi::OsStr::new("LD_PRELOAD")).unwrap(),
            "/opt/host/a.so:/opt/host/b.so"
        );
    }
}
