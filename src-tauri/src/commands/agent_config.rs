//! What the user sets per agent in Settings → Agents: whether it is on, the
//! name it goes by, how it launches, its environment, and how its models show
//! in the picker (hidden, ordered, and any the user added by id).
//!
//! A variable marked sensitive keeps only its name in the installed map; its
//! value goes to the OS keychain ([`super::agent_secrets`]) and never comes
//! back to the webview.
//!
//! An external agent keeps these in its installed-map entry, beside the rest
//! of what the user configured about it, so a hand edit of `installed.json`
//! and the settings page agree. The native agent has no entry there — the map
//! is the list of external agents, and an entry *is* an install — so its two
//! applicable fields live in a small file of their own in Atlas's config
//! directory.
//!
//! One command writes them all, [`agents_configure`], and answers with the
//! agent's catalog entry as it now stands.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use atlas_native_agent::ATLAS_AGENT_ID;

use super::agent_host::AgentHost;
use super::catalog::{self, AgentCatalogEntry};

/// The native agent's share of the per-agent settings. It cannot be turned
/// off and has no command, arguments or environment of its own.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NativeAgentPrefs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden_models: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub model_order: Vec<String>,
}

fn native_prefs_path(config_dir: &Path) -> PathBuf {
    config_dir.join("native-agent.json")
}

fn read_native_prefs(config_dir: &Path) -> std::io::Result<NativeAgentPrefs> {
    let path = native_prefs_path(config_dir);
    match std::fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "repair {} before changing Atlas Agent settings: {e}",
                    path.display()
                ),
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Default::default()),
        Err(e) => Err(e),
    }
}

/// Catalog rendering can use defaults; writes always use the strict reader.
pub fn load_native_prefs(config_dir: &Path) -> NativeAgentPrefs {
    read_native_prefs(config_dir).unwrap_or_else(|e| {
        tracing::warn!(target: "atlas::agents", "native agent settings are unavailable: {e}");
        Default::default()
    })
}

fn save_native_prefs(config_dir: &Path, prefs: &NativeAgentPrefs) -> std::io::Result<()> {
    read_native_prefs(config_dir)?;
    let json = serde_json::to_string_pretty(prefs)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    atlas_fs::replace_file(native_prefs_path(config_dir), json)
}

/// How an external agent launches, as the catalog reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunch {
    /// A custom entry's executable. `None` for a registry install, whose
    /// command the registry names.
    pub command: Option<String>,
    pub args: Vec<String>,
    /// Plain variables, then sensitive ones, each sorted by name.
    pub variables: Vec<AgentVariable>,
}

/// One environment variable, as the catalog reports it and a patch sets it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentVariable {
    pub name: String,
    /// Always `None` for a sensitive variable in the catalog. In a patch,
    /// `None` on a sensitive variable keeps the value already stored.
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub sensitive: bool,
}

impl AgentLaunch {
    /// The launch settings of an installed-map entry, without a secret value.
    pub fn of(entry: &atlas_agent_store::AgentServerSettings) -> Self {
        let mut plain = entry
            .env()
            .iter()
            .map(|(name, value)| AgentVariable {
                name: name.clone(),
                value: Some(value.clone()),
                sensitive: false,
            })
            .collect::<Vec<_>>();
        plain.sort_by(|a, b| a.name.cmp(&b.name));
        let mut secret = entry
            .secret_env()
            .iter()
            .map(|name| AgentVariable {
                name: name.clone(),
                value: None,
                sensitive: true,
            })
            .collect::<Vec<_>>();
        secret.sort_by(|a, b| a.name.cmp(&b.name));
        plain.extend(secret);
        Self {
            command: entry.command().map(|c| c.path.display().to_string()),
            args: entry.args().to_vec(),
            variables: plain,
        }
    }
}

/// One `agents_configure` call: only what changes.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigPatch {
    pub enabled: Option<bool>,
    /// `Some(None)` (JSON `null`) and a blank name both go back to the
    /// agent's own name.
    #[serde(default, deserialize_with = "explicit_null")]
    pub display_name: Option<Option<String>>,
    pub hidden_models: Option<Vec<String>>,
    pub model_order: Option<Vec<String>>,
    pub custom_models: Option<Vec<atlas_agent_store::CustomModel>>,
    pub launch: Option<LaunchPatch>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPatch {
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    /// The whole list: a variable left out is removed.
    pub variables: Option<Vec<AgentVariable>>,
}

/// What a patch asks of the keychain, done by the caller after the pure
/// [`apply_to_entry`].
#[derive(Debug, Default, PartialEq, Eq)]
pub struct KeychainWrites {
    pub set: Vec<(String, String)>,
    pub delete: Vec<String>,
}

/// Tell "absent" (keep it) from `null` (clear it): serde reads both as `None`
/// for a plain `Option`.
fn explicit_null<'de, D>(deserializer: D) -> Result<Option<Option<String>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer).map(Some)
}

/// A name the user typed, or `None` for "use the agent's own".
fn clean_name(name: Option<String>) -> Option<String> {
    name.map(|n| n.trim().to_string()).filter(|n| !n.is_empty())
}

/// A variable name a process environment can carry.
fn valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Apply a patch to an installed-map entry. Pure, so the rules are tested
/// without a host.
pub fn apply_to_entry(
    entry: &mut atlas_agent_store::AgentServerSettings,
    patch: AgentConfigPatch,
) -> Result<KeychainWrites, String> {
    let mut keychain = KeychainWrites::default();
    let user = entry.user_settings_mut();
    if let Some(enabled) = patch.enabled {
        *user.enabled = enabled;
    }
    if let Some(name) = patch.display_name {
        *user.display_name = clean_name(name);
    }
    if let Some(hidden) = patch.hidden_models {
        *user.hidden_models = hidden;
    }
    if let Some(order) = patch.model_order {
        *user.model_order = order;
    }
    if let Some(custom) = patch.custom_models {
        let mut seen = std::collections::HashSet::new();
        let mut cleaned = Vec::with_capacity(custom.len());
        for model in custom {
            let id = model.id.trim().to_string();
            if id.is_empty() {
                return Err("a custom model needs an id".into());
            }
            if seen.insert(id.clone()) {
                cleaned.push(atlas_agent_store::CustomModel {
                    id,
                    name: clean_name(model.name),
                });
            }
        }
        *user.custom_models = cleaned;
    }
    if let Some(launch) = patch.launch {
        if let Some(command) = launch.command {
            let command = command.trim();
            let Some(path) = user.command else {
                return Err("a registry agent's command comes from the registry".into());
            };
            if command.is_empty() {
                return Err("the command can't be empty".into());
            }
            *path = PathBuf::from(command);
        }
        if let Some(args) = launch.args {
            *user.args = args;
        }
        if let Some(variables) = launch.variables {
            let mut env = HashMap::new();
            let mut secret = Vec::new();
            for variable in variables {
                let name = variable.name.trim().to_string();
                if !valid_env_name(&name) {
                    return Err(format!("`{name}` isn't a valid variable name"));
                }
                if env.contains_key(&name) || secret.contains(&name) {
                    return Err(format!("{name} is set twice"));
                }
                if variable.sensitive {
                    match variable.value {
                        Some(value) => keychain.set.push((name.clone(), value)),
                        None if user.secret_env.contains(&name) => {}
                        None => return Err(format!("{name} needs a value")),
                    }
                    secret.push(name);
                } else {
                    env.insert(name, variable.value.unwrap_or_default());
                }
            }
            keychain.delete = user
                .secret_env
                .iter()
                .filter(|name| !secret.contains(name))
                .cloned()
                .collect();
            secret.sort();
            *user.env = env;
            *user.secret_env = secret;
        }
    }
    Ok(keychain)
}

/// Apply a patch to the native agent's settings.
pub fn apply_to_native(
    prefs: &mut NativeAgentPrefs,
    patch: AgentConfigPatch,
) -> Result<(), String> {
    if patch.enabled == Some(false) {
        return Err("Atlas Agent can't be turned off".into());
    }
    if patch.launch.is_some() {
        return Err("Atlas Agent runs inside Atlas; it has no launch settings".into());
    }
    if patch.custom_models.is_some() {
        return Err("Atlas Agent's models come from its gateway; it takes no custom ones".into());
    }
    if let Some(name) = patch.display_name {
        prefs.display_name = clean_name(name);
    }
    if let Some(hidden) = patch.hidden_models {
        prefs.hidden_models = hidden;
    }
    if let Some(order) = patch.model_order {
        prefs.model_order = order;
    }
    Ok(())
}

/// Change what the user set for one agent, and answer with its catalog entry
/// as it now stands. Emits `atlas:agent-catalog:changed`, so every other
/// agent surface (the picker, labels) follows.
#[tauri::command]
pub async fn agents_configure(
    agent_id: String,
    patch: AgentConfigPatch,
    host: State<'_, Arc<AgentHost>>,
    app: AppHandle,
) -> Result<AgentCatalogEntry, String> {
    let host = host.inner().clone();
    // Keep read, disk publication, store publication and keychain effects in
    // one transaction shared with install/uninstall and the boot loader.
    let _write = super::registry::settings_write().await;
    if agent_id == ATLAS_AGENT_ID {
        let config_dir = host.config_dir().to_path_buf();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            let mut prefs = read_native_prefs(&config_dir).map_err(|e| e.to_string())?;
            apply_to_native(&mut prefs, patch)?;
            save_native_prefs(&config_dir, &prefs).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("writing Atlas Agent's settings: {e}"))?;
    } else {
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let mut settings = super::registry::installed_settings(&data_dir).await?;
        let entry = settings
            .0
            .get_mut(&agent_id)
            .ok_or_else(|| format!("{agent_id} is not installed"))?;
        let turning_off = patch.enabled == Some(false);
        // How it launches is read once, at spawn: a running agent keeps the
        // old command, arguments and environment until it restarts.
        let relaunches = patch.launch.is_some();
        let keychain = apply_to_entry(entry, patch)?;
        // New values before the map that names them: a name the map lists
        // with no stored value would launch the agent without it. Deletes
        // after it, so a failed save can't lose a value the map still names;
        // a failed delete only leaves an item nothing reads.
        let agent = agent_id.clone();
        let set = keychain.set;
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            for (name, value) in &set {
                super::agent_secrets::write(&agent, name, value)?;
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;
        super::registry::persist(&host, &data_dir, settings).await?;
        let agent = agent_id.clone();
        let delete = keychain.delete;
        tauri::async_runtime::spawn_blocking(move || {
            for name in &delete {
                if let Err(e) = super::agent_secrets::delete(&agent, name) {
                    tracing::warn!("couldn't remove {agent}/{name} from the keychain: {e}");
                }
            }
        })
        .await
        .map_err(|e| e.to_string())?;
        // Off means not running, not just not started next time.
        if turning_off {
            host.turn_off(&agent_id).map_err(|e| e.to_string())?;
        } else if relaunches {
            mark_stale(&host, &agent_id);
        }
    }
    catalog::emit_catalog_changed(&app, "settings");
    catalog::entry_for(&host, &agent_id).ok_or_else(|| format!("{agent_id} is not in the catalog"))
}

// ── Restart to apply (audit #65) ────────────────────────────────────────────
//
// An agent reads its command, arguments and environment once, when it
// starts. A change in Settings → Agents, or a provider key edited in the
// shell profile, reached the next start and not the agent already running —
// and nothing said so, or offered to restart a healthy agent.

/// The connection each agent had when a change to how it launches was saved,
/// held weakly: the agent is "running the old settings" exactly while that
/// same connection is still the one it has. A restart, a crash and respawn,
/// or a kill all replace or drop it, and the mark lapses by itself without
/// any of those paths having to clear it.
#[derive(Default)]
struct StaleLaunches(
    parking_lot::Mutex<HashMap<String, std::sync::Weak<dyn atlas_acp_thread::AgentConnection>>>,
);

impl StaleLaunches {
    fn mark(&self, plugin_id: &str, running: &Arc<dyn atlas_acp_thread::AgentConnection>) {
        self.0
            .lock()
            .insert(plugin_id.to_string(), Arc::downgrade(running));
    }

    fn is_stale(
        &self,
        plugin_id: &str,
        running: Option<&Arc<dyn atlas_acp_thread::AgentConnection>>,
    ) -> bool {
        let mut marks = self.0.lock();
        let Some(marked) = marks.get(plugin_id) else {
            return false;
        };
        match (running, marked.upgrade()) {
            (Some(running), Some(marked)) if Arc::ptr_eq(running, &marked) => true,
            _ => {
                marks.remove(plugin_id);
                false
            }
        }
    }

    fn forget(&self, plugin_id: &str) {
        self.0.lock().remove(plugin_id);
    }
}

fn stale_launches() -> &'static StaleLaunches {
    static STALE: std::sync::LazyLock<StaleLaunches> = std::sync::LazyLock::new(Default::default);
    &STALE
}

fn running_connection(
    host: &AgentHost,
    plugin_id: &str,
) -> Option<Arc<dyn atlas_acp_thread::AgentConnection>> {
    if plugin_id == ATLAS_AGENT_ID {
        return None;
    }
    host.manager()
        .connected(&atlas_agent_manager::Agent::Custom {
            id: atlas_acp_thread::AgentId::new(plugin_id),
        })
}

/// Note that `plugin_id`'s running process predates a change to how it
/// launches. Nothing to note when it is not running: its next start reads
/// the change.
pub(crate) fn mark_stale(host: &AgentHost, plugin_id: &str) {
    if let Some(running) = running_connection(host, plugin_id) {
        stale_launches().mark(plugin_id, &running);
    }
}

/// [`mark_stale`] for every running external agent — a provider key changed,
/// and every agent is handed the keys when it starts.
pub(crate) fn mark_all_stale(host: &AgentHost) {
    for (agent, running) in host.manager().connections() {
        if let atlas_agent_manager::Agent::Custom { id } = agent {
            stale_launches().mark(id.as_str(), &running);
        }
    }
}

/// Whether `plugin_id` is running with settings older than what is saved:
/// the catalog's `restartToApply`, which Settings → Agents offers a restart
/// for.
pub(crate) fn restart_to_apply(host: &AgentHost, plugin_id: &str) -> bool {
    stale_launches().is_stale(plugin_id, running_connection(host, plugin_id).as_ref())
}

/// Stop `plugin_id` and start it again, so it runs what is saved now. Open
/// chats are told, and reconnect on their next message; a running turn
/// blocks it, as it blocks a model refresh, rather than being cut off.
async fn restart_agent(host: &Arc<AgentHost>, plugin_id: &str) -> Result<(), String> {
    if host.agent_turn_running(plugin_id) {
        return Err(format!(
            "{} is replying. Stop the reply or let it finish, then restart.",
            host.display_name(plugin_id)
        ));
    }
    host.kill_plugin(plugin_id).map_err(|e| e.to_string())?;
    stale_launches().forget(plugin_id);
    host.spawn(plugin_id).await.map_err(|e| e.to_string())?;
    Ok(())
}

/// "Restart to apply" in Settings → Agents.
#[tauri::command]
pub async fn agents_restart_to_apply(
    agent_id: String,
    host: State<'_, Arc<AgentHost>>,
    app: AppHandle,
) -> Result<(), String> {
    if agent_id == ATLAS_AGENT_ID {
        return Err("Atlas Agent runs inside Atlas; there is nothing to restart".into());
    }
    let host = host.inner().clone();
    let restarted = restart_agent(&host, &agent_id).await;
    catalog::emit_catalog_changed(&app, "restart");
    restarted
}

// ── Sign-in variables (audit #61) ───────────────────────────────────────────

/// One variable an `env_var` sign-in method asked for, as the user typed it.
#[derive(Debug, Clone, Deserialize)]
pub struct AuthEnvValue {
    pub name: String,
    pub value: String,
}

/// Add `values` to an entry as sensitive variables, keeping every other
/// variable as it is; one of the same name is replaced. Pure, like
/// [`apply_to_entry`], whose rules it goes through.
pub fn with_sensitive_variables(
    entry: &mut atlas_agent_store::AgentServerSettings,
    values: Vec<AuthEnvValue>,
) -> Result<KeychainWrites, String> {
    let mut variables: Vec<AgentVariable> = AgentLaunch::of(entry)
        .variables
        .into_iter()
        .filter(|kept| !values.iter().any(|new| new.name.trim() == kept.name))
        .collect();
    for AuthEnvValue { name, value } in values {
        if value.trim().is_empty() {
            return Err(format!("{} needs a value", name.trim()));
        }
        variables.push(AgentVariable {
            name,
            value: Some(value.trim().to_string()),
            sensitive: true,
        });
    }
    apply_to_entry(
        entry,
        AgentConfigPatch {
            launch: Some(LaunchPatch {
                variables: Some(variables),
                ..Default::default()
            }),
            ..Default::default()
        },
    )
}

/// Save the variables an `env_var` sign-in method asked for, and restart the
/// agent so it has them.
///
/// The sign-in dialog used to show a checklist and then call `authenticate`
/// on the process already running — which was started without the variable
/// and never got it (audit #61). The values go where any sensitive agent
/// variable goes (the keychain, ADR-0023); the installed map keeps only their
/// names, and the agent is restarted so its next start carries them. A turn
/// running on it holds the restart back: the variables are saved, and the
/// catalog offers "Restart to apply" once the turn ends.
#[tauri::command]
pub async fn agents_set_auth_env(
    agent_id: String,
    values: Vec<AuthEnvValue>,
    host: State<'_, Arc<AgentHost>>,
    app: AppHandle,
) -> Result<(), String> {
    if agent_id == ATLAS_AGENT_ID {
        return Err("Atlas Agent signs in with your Atlas account".into());
    }
    if values.is_empty() {
        return Ok(());
    }
    let host = host.inner().clone();
    {
        let _write = super::registry::settings_write().await;
        let data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let mut settings = super::registry::installed_settings(&data_dir).await?;
        let entry = settings
            .0
            .get_mut(&agent_id)
            .ok_or_else(|| format!("{agent_id} is not installed"))?;
        let keychain = with_sensitive_variables(entry, values)?;
        // Values before the map that names them, as in `agents_configure`.
        let agent = agent_id.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
            for (name, value) in &keychain.set {
                super::agent_secrets::write(&agent, name, value)?;
            }
            Ok(())
        })
        .await
        .map_err(|e| e.to_string())??;
        super::registry::persist(&host, &data_dir, settings).await?;
    }
    mark_stale(&host, &agent_id);
    if running_connection(&host, &agent_id).is_some() && !host.agent_turn_running(&agent_id) {
        restart_agent(&host, &agent_id).await?;
    }
    catalog::emit_catalog_changed(&app, "sign-in");
    Ok(())
}

/// `~/…` against the home directory; anything else as given.
fn expand_home(path: &str, home: Option<&Path>) -> PathBuf {
    match (
        path.strip_prefix("~/").or((path == "~").then_some("")),
        home,
    ) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(path),
    }
}

/// Where an agent's own config file is, made to exist so it can open as a
/// tab: `empty` is written to it when it is missing, along with any missing
/// folders. Settings → Agents uses it for "Open settings.json" and the like;
/// what the file says is the agent's business, read by the agent at launch.
#[tauri::command]
pub async fn agents_open_config_file(path: String, empty: String) -> Result<String, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let path = expand_home(path.trim(), home.as_deref());
    if !path.is_absolute() {
        return Err(format!("{} isn't an absolute path", path.display()));
    }
    tauri::async_runtime::spawn_blocking(move || {
        if !path.exists() {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&path, empty)?;
        }
        Ok::<_, std::io::Error>(path.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("opening the config file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use atlas_agent_store::AgentServerSettings;

    fn patch(json: serde_json::Value) -> AgentConfigPatch {
        serde_json::from_value(json).expect("a well-formed patch")
    }

    #[test]
    fn a_patch_changes_only_what_it_names() {
        let mut entry = AgentServerSettings::custom("/opt/agent", vec!["--acp".into()]);
        apply_to_entry(&mut entry, patch(serde_json::json!({ "enabled": false }))).unwrap();
        assert!(!entry.enabled());
        assert_eq!(entry.args(), ["--acp"]);

        apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "variables": [{ "name": "REGION", "value": "eu" }] } })),
        )
        .unwrap();
        assert_eq!(entry.env().get("REGION").map(String::as_str), Some("eu"));
        assert_eq!(entry.args(), ["--acp"], "env alone leaves the arguments");
    }

    /// `null` and a blank name both mean "use the agent's own name"; a field
    /// left out keeps what was there.
    #[test]
    fn a_display_name_clears_on_null_or_blank() {
        let mut entry = AgentServerSettings::registry();
        apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "displayName": " Work " })),
        )
        .unwrap();
        assert_eq!(entry.display_name(), Some("Work"));
        apply_to_entry(&mut entry, patch(serde_json::json!({ "enabled": true }))).unwrap();
        assert_eq!(entry.display_name(), Some("Work"));
        apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "displayName": null })),
        )
        .unwrap();
        assert_eq!(entry.display_name(), None);
        apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "displayName": "  " })),
        )
        .unwrap();
        assert_eq!(entry.display_name(), None);
    }

    #[test]
    fn a_registry_agents_command_is_not_the_users_to_set() {
        let mut entry = AgentServerSettings::registry();
        let err = apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "command": "/bin/sh" } })),
        )
        .unwrap_err();
        assert!(err.contains("registry"), "{err}");
    }

    #[test]
    fn a_custom_command_can_be_replaced_but_not_emptied() {
        let mut entry = AgentServerSettings::custom("/opt/agent", vec![]);
        apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "command": "/opt/other" } })),
        )
        .unwrap();
        assert_eq!(
            entry.command().map(|c| c.path),
            Some(PathBuf::from("/opt/other"))
        );
        assert!(apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "command": " " } })),
        )
        .is_err());
    }

    #[test]
    fn an_invalid_variable_name_is_refused() {
        let mut entry = AgentServerSettings::registry();
        let err = apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "variables": [{ "name": "1BAD", "value": "x" }] } })),
        )
        .unwrap_err();
        assert!(err.contains("1BAD"), "{err}");
        assert!(entry.env().is_empty(), "nothing is half-written");
    }

    /// A sensitive value goes to the keychain and only its name to the map;
    /// sending it back without a value keeps what is stored, and making it
    /// plain again or dropping it deletes the stored one.
    #[test]
    fn sensitive_variables_keep_only_their_name_in_the_map() {
        let mut entry = AgentServerSettings::registry();
        let writes = apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "variables": [
                { "name": "REGION", "value": "eu" },
                { "name": "API_TOKEN", "value": "s3cret", "sensitive": true },
            ] } })),
        )
        .unwrap();
        assert_eq!(
            writes.set,
            [("API_TOKEN".to_string(), "s3cret".to_string())]
        );
        assert!(writes.delete.is_empty());
        assert_eq!(entry.secret_env(), ["API_TOKEN"]);
        assert!(!entry.env().contains_key("API_TOKEN"));
        let json = serde_json::to_string(&entry).unwrap();
        assert!(
            !json.contains("s3cret"),
            "the value never reaches the file: {json}"
        );

        let launch = AgentLaunch::of(&entry);
        assert_eq!(launch.variables[1].name, "API_TOKEN");
        assert_eq!(launch.variables[1].value, None, "nor the webview");

        let writes = apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "variables": [
                { "name": "REGION", "value": "eu" },
                { "name": "API_TOKEN", "sensitive": true },
            ] } })),
        )
        .unwrap();
        assert_eq!(
            writes,
            KeychainWrites::default(),
            "an unchanged secret is left alone"
        );

        let writes = apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "variables": [
                { "name": "REGION", "value": "eu" },
            ] } })),
        )
        .unwrap();
        assert_eq!(writes.delete, ["API_TOKEN"]);
        assert!(entry.secret_env().is_empty());
    }

    #[test]
    fn a_new_sensitive_variable_needs_a_value_and_names_are_unique() {
        let mut entry = AgentServerSettings::registry();
        assert!(apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "variables": [
                { "name": "TOKEN", "sensitive": true },
            ] } })),
        )
        .is_err());
        assert!(apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "variables": [
                { "name": "A", "value": "1" },
                { "name": "A", "value": "2", "sensitive": true },
            ] } })),
        )
        .is_err());
    }

    #[test]
    fn custom_models_are_trimmed_and_deduplicated() {
        let mut entry = AgentServerSettings::registry();
        apply_to_entry(
            &mut entry,
            patch(serde_json::json!({
                "customModels": [{ "id": " m1 " }, { "id": "m1", "name": "Again" }, { "id": "m2", "name": " " }],
                "modelOrder": ["m2", "m1"],
            })),
        )
        .unwrap();
        assert_eq!(
            entry.custom_models(),
            [
                atlas_agent_store::CustomModel {
                    id: "m1".into(),
                    name: None
                },
                atlas_agent_store::CustomModel {
                    id: "m2".into(),
                    name: None
                },
            ]
        );
        assert_eq!(entry.model_order(), ["m2", "m1"]);
        assert!(apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "customModels": [{ "id": "  " }] })),
        )
        .is_err());
    }

    #[test]
    fn the_native_agent_can_be_renamed_but_not_turned_off() {
        let mut prefs = NativeAgentPrefs::default();
        apply_to_native(
            &mut prefs,
            patch(serde_json::json!({ "displayName": "Atlas", "hiddenModels": ["m"] })),
        )
        .unwrap();
        assert_eq!(prefs.display_name.as_deref(), Some("Atlas"));
        assert_eq!(prefs.hidden_models, ["m"]);
        assert!(
            apply_to_native(&mut prefs, patch(serde_json::json!({ "enabled": false }))).is_err()
        );
        assert!(apply_to_native(
            &mut prefs,
            patch(serde_json::json!({ "launch": { "args": [] } })),
        )
        .is_err());
    }

    #[test]
    fn a_config_path_expands_home_only_at_the_start() {
        let home = Path::new("/home/u");
        assert_eq!(
            expand_home("~/.claude/settings.json", Some(home)),
            home.join(".claude/settings.json")
        );
        assert_eq!(expand_home("~", Some(home)), home.join(""));
        assert_eq!(expand_home("/etc/x", Some(home)), PathBuf::from("/etc/x"));
        assert_eq!(expand_home("~/x", None), PathBuf::from("~/x"));
    }

    #[test]
    fn native_prefs_round_trip_through_disk() {
        let dir = std::env::temp_dir().join(format!("atlas-native-prefs-{}", uuid::Uuid::new_v4()));
        assert_eq!(load_native_prefs(&dir), NativeAgentPrefs::default());
        let prefs = NativeAgentPrefs {
            display_name: Some("Atlas".into()),
            hidden_models: vec!["m".into()],
            model_order: vec!["b".into(), "a".into()],
        };
        save_native_prefs(&dir, &prefs).unwrap();
        assert_eq!(load_native_prefs(&dir), prefs);
        std::fs::write(native_prefs_path(&dir), "{broken").unwrap();
        assert!(save_native_prefs(&dir, &prefs).is_err());
        assert_eq!(
            std::fs::read_to_string(native_prefs_path(&dir)).unwrap(),
            "{broken"
        );
        std::fs::write(native_prefs_path(&dir), "{}").unwrap();
        save_native_prefs(&dir, &prefs).unwrap();
        assert_eq!(read_native_prefs(&dir).unwrap(), prefs);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Audit #61: the value an `env_var` sign-in method asked for is saved
    /// for the agent as a sensitive variable — the keychain gets the value,
    /// the map only the name — and every variable already set stays.
    #[test]
    fn a_sign_in_variable_is_saved_as_a_sensitive_one_beside_the_rest() {
        let mut entry = AgentServerSettings::registry();
        apply_to_entry(
            &mut entry,
            patch(serde_json::json!({ "launch": { "variables": [
                { "name": "REGION", "value": "eu" },
                { "name": "OLD_TOKEN", "value": "kept", "sensitive": true },
                { "name": "GEMINI_API_KEY", "value": "plain" },
            ] } })),
        )
        .unwrap();

        let writes = with_sensitive_variables(
            &mut entry,
            vec![AuthEnvValue {
                name: "GEMINI_API_KEY".into(),
                value: " k3y ".into(),
            }],
        )
        .unwrap();

        assert_eq!(
            writes.set,
            [("GEMINI_API_KEY".to_string(), "k3y".to_string())]
        );
        assert!(writes.delete.is_empty(), "the other secret is kept");
        assert_eq!(entry.secret_env(), ["GEMINI_API_KEY", "OLD_TOKEN"]);
        assert_eq!(entry.env().get("REGION").map(String::as_str), Some("eu"));
        assert!(
            !entry.env().contains_key("GEMINI_API_KEY"),
            "the plain copy is replaced, not left beside it"
        );

        let blank = with_sensitive_variables(
            &mut entry,
            vec![AuthEnvValue {
                name: "OTHER".into(),
                value: "  ".into(),
            }],
        );
        assert!(blank.is_err());
    }

    /// Audit #65: a launch change is "waiting for a restart" exactly while
    /// the connection that was running when it was saved is still the one
    /// running. A restart replaces it, and the mark lapses by itself.
    #[test]
    fn a_launch_change_is_stale_only_while_the_same_process_runs() {
        use atlas_acp_thread::test_support::FakeConnection;
        use atlas_acp_thread::AgentConnection;

        let stale = StaleLaunches::default();
        let (first, _) = FakeConnection::builder().agent("a").build();
        let first: Arc<dyn AgentConnection> = first;
        assert!(!stale.is_stale("a", Some(&first)), "nothing changed yet");

        stale.mark("a", &first);
        assert!(stale.is_stale("a", Some(&first)));
        assert!(!stale.is_stale("b", Some(&first)), "per agent");

        let (second, _) = FakeConnection::builder().agent("a").build();
        let second: Arc<dyn AgentConnection> = second;
        assert!(!stale.is_stale("a", Some(&second)), "restarted: applied");
        assert!(
            !stale.is_stale("a", Some(&first)),
            "and the mark is gone for good"
        );

        stale.mark("a", &second);
        assert!(
            !stale.is_stale("a", None),
            "stopped: the next start applies it"
        );
    }
}
