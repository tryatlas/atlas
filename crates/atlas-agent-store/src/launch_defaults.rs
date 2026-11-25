//! The Variables an agent starts with, written into its installed entry.
//!
//! Some agents need a variable set to behave well inside Atlas: Claude bills
//! the API instead of the user's subscription when an `ANTHROPIC_API_KEY` is
//! in its environment, and Claude's and Codex's own memories compete with
//! Atlas's. These used to be spawn-time branches on agent ids in the launcher,
//! which ADR-0002 rules out and which keyed on ids no install ever had.
//!
//! Instead they are data (`launch_defaults.json`, keyed by ACP registry id,
//! like the settings profiles of ADR-0023), and they are *written into the
//! entry's Variables* when the agent is installed, where the user sees them in
//! Settings → Agents and can change or delete them. The launcher applies
//! Variables like any other; it knows nothing about any agent.
//!
//! Each default is seeded once per entry: its marker goes into
//! `seeded_defaults`, so a variable the user deletes stays deleted, and an
//! entry installed before a default existed gets it on the next start
//! ([`seed_all`] is run over the installed map at boot).

use std::collections::HashMap;
use std::sync::LazyLock;

use serde::Deserialize;

use crate::settings::{AgentServerSettings, AllAgentServersSettings};

/// Where a default lives: a whole variable, or one key inside a variable
/// that holds a JSON object (Codex's `CODEX_CONFIG`).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
enum Target {
    Json { json: String, key: String },
    Env { env: String },
}

/// What a default is conditional on: an Atlas setting, by its config key.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
enum Condition {
    #[serde(rename = "atlasOnlyMemory")]
    AtlasOnlyMemory,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
struct LaunchDefault {
    #[serde(flatten)]
    target: Target,
    /// A string for an `env` target; any JSON value for a `json` one.
    value: serde_json::Value,
    #[serde(default)]
    when: Option<Condition>,
}

impl LaunchDefault {
    /// The name recorded in `seeded_defaults`: the variable, or
    /// `VARIABLE.key` for a key inside a JSON one.
    fn marker(&self) -> String {
        match &self.target {
            Target::Env { env } => env.clone(),
            Target::Json { json, key } => format!("{json}.{key}"),
        }
    }
}

static DEFAULTS: LazyLock<HashMap<String, Vec<LaunchDefault>>> = LazyLock::new(|| {
    serde_json::from_str(include_str!("launch_defaults.json"))
        .expect("launch_defaults.json is checked by this module's tests")
});

/// The Atlas settings a default can depend on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeedConditions {
    /// `atlasOnlyMemory`: an agent's own memory starts off.
    pub atlas_only_memory: bool,
}

impl SeedConditions {
    fn holds(self, condition: Option<Condition>) -> bool {
        match condition {
            None => true,
            Some(Condition::AtlasOnlyMemory) => self.atlas_only_memory,
        }
    }
}

/// Write the launch defaults for `agent_id` into `entry` that it hasn't
/// had yet. Returns whether the entry changed.
///
/// A default whose condition doesn't hold is left unseeded, so it can be
/// seeded on a later start once it does. One whose variable the user already
/// set is marked seeded without touching their value.
pub fn seed(agent_id: &str, entry: &mut AgentServerSettings, conditions: SeedConditions) -> bool {
    let Some(defaults) = DEFAULTS.get(agent_id) else {
        return false;
    };
    let (env, secret_env, seeded) = entry.seeding_mut();
    let mut changed = false;
    for default in defaults {
        let marker = default.marker();
        if seeded.contains(&marker) || !conditions.holds(default.when) {
            continue;
        }
        match &default.target {
            Target::Env { env: name } => {
                if !env.contains_key(name) && !secret_env.contains(name) {
                    let value = match &default.value {
                        serde_json::Value::String(text) => text.clone(),
                        other => other.to_string(),
                    };
                    env.insert(name.clone(), value);
                }
            }
            Target::Json { json, key } => {
                if !secret_env.contains(json) {
                    let current = env.get(json).map(String::as_str).unwrap_or("");
                    let object = if current.trim().is_empty() {
                        Some(serde_json::Map::new())
                    } else {
                        // A value the user wrote that isn't an object is
                        // theirs to fix; it is never overwritten.
                        serde_json::from_str::<serde_json::Value>(current)
                            .ok()
                            .and_then(|v| v.as_object().cloned())
                    };
                    if let Some(mut object) = object {
                        if !object.contains_key(key) {
                            object.insert(key.clone(), default.value.clone());
                            env.insert(json.clone(), serde_json::Value::Object(object).to_string());
                        }
                    }
                }
            }
        }
        seeded.push(marker);
        changed = true;
    }
    changed
}

/// [`seed`] over every entry of the installed map: the migration for agents
/// installed before their defaults were written at install. Idempotent.
pub fn seed_all(settings: &mut AllAgentServersSettings, conditions: SeedConditions) -> bool {
    let mut changed = false;
    for (id, entry) in settings.0.iter_mut() {
        changed |= seed(id, entry, conditions);
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    const ON: SeedConditions = SeedConditions {
        atlas_only_memory: true,
    };
    const OFF: SeedConditions = SeedConditions {
        atlas_only_memory: false,
    };

    fn env(entry: &AgentServerSettings) -> &HashMap<String, String> {
        entry.env()
    }

    #[test]
    fn the_data_file_parses_and_every_env_default_is_a_string() {
        assert!(!DEFAULTS.is_empty());
        for (id, defaults) in DEFAULTS.iter() {
            for default in defaults {
                if matches!(default.target, Target::Env { .. }) {
                    assert!(default.value.is_string(), "{id}: {}", default.marker());
                }
            }
        }
    }

    /// The ids are the ones installs actually have — the launcher's old
    /// branches keyed on `claude-code` and `codex`, which none did.
    #[test]
    fn defaults_are_keyed_on_installed_registry_ids() {
        assert!(DEFAULTS.contains_key("claude-acp"));
        assert!(DEFAULTS.contains_key("codex-acp"));
        assert!(!DEFAULTS.contains_key("claude-code"));
        assert!(!DEFAULTS.contains_key("codex"));
    }

    #[test]
    fn installing_claude_writes_its_api_key_blank_and_its_memory_off() {
        let mut entry = AgentServerSettings::registry();
        assert!(seed("claude-acp", &mut entry, ON));
        assert_eq!(
            env(&entry).get("ANTHROPIC_API_KEY").map(String::as_str),
            Some("")
        );
        assert_eq!(
            env(&entry)
                .get("CLAUDE_CODE_DISABLE_AUTO_MEMORY")
                .map(String::as_str),
            Some("1")
        );
    }

    #[test]
    fn codex_memory_goes_into_its_config_json_beside_the_users_keys() {
        let mut entry = AgentServerSettings::registry();
        entry.seeding_mut().0.insert(
            "CODEX_CONFIG".into(),
            r#"{"model_reasoning_effort":"high"}"#.into(),
        );
        assert!(seed("codex-acp", &mut entry, ON));
        let config: serde_json::Value = serde_json::from_str(&env(&entry)["CODEX_CONFIG"]).unwrap();
        assert_eq!(
            config,
            serde_json::json!({
                "model_reasoning_effort": "high",
                "memories.use_memories": false,
                "memories.generate_memories": false,
            })
        );
    }

    #[test]
    fn seeding_twice_changes_nothing() {
        let mut settings = AllAgentServersSettings(HashMap::from([
            ("claude-acp".to_string(), AgentServerSettings::registry()),
            ("codex-acp".to_string(), AgentServerSettings::registry()),
            ("gemini".to_string(), AgentServerSettings::registry()),
            ("unknown".to_string(), AgentServerSettings::registry()),
        ]));
        assert!(seed_all(&mut settings, ON));
        let once = settings.clone();
        assert!(!seed_all(&mut settings, ON));
        assert_eq!(settings, once);
        assert_eq!(settings["unknown"], AgentServerSettings::registry());
    }

    #[test]
    fn a_default_the_user_deleted_stays_deleted() {
        let mut entry = AgentServerSettings::registry();
        seed("claude-acp", &mut entry, ON);
        entry.seeding_mut().0.remove("ANTHROPIC_API_KEY");
        // Through a disk round trip, as the boot migration sees it.
        let mut entry: AgentServerSettings =
            serde_json::from_str(&serde_json::to_string(&entry).unwrap()).unwrap();
        assert!(!seed("claude-acp", &mut entry, ON));
        assert!(!env(&entry).contains_key("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn a_value_the_user_set_is_kept() {
        let mut entry = AgentServerSettings::registry();
        entry
            .seeding_mut()
            .0
            .insert("CLAUDE_CODE_DISABLE_AUTO_MEMORY".into(), "0".into());
        seed("claude-acp", &mut entry, ON);
        assert_eq!(env(&entry)["CLAUDE_CODE_DISABLE_AUTO_MEMORY"], "0");
    }

    #[test]
    fn a_sensitive_variable_is_not_shadowed_by_a_plain_default() {
        let mut entry = AgentServerSettings::registry();
        if let AgentServerSettings::Registry { secret_env, .. } = &mut entry {
            secret_env.push("ANTHROPIC_API_KEY".into());
        }
        seed("claude-acp", &mut entry, ON);
        assert!(!env(&entry).contains_key("ANTHROPIC_API_KEY"));
    }

    #[test]
    fn memory_defaults_wait_for_atlas_only_memory() {
        let mut entry = AgentServerSettings::registry();
        seed("claude-acp", &mut entry, OFF);
        assert!(env(&entry).contains_key("ANTHROPIC_API_KEY"));
        assert!(!env(&entry).contains_key("CLAUDE_CODE_DISABLE_AUTO_MEMORY"));
        assert!(seed("claude-acp", &mut entry, ON));
        assert!(env(&entry).contains_key("CLAUDE_CODE_DISABLE_AUTO_MEMORY"));
    }
}
