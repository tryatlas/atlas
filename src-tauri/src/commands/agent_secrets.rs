//! The OS keychain behind agent variables marked sensitive in Settings →
//! Agents. The installed map keeps only a sensitive variable's name; its value
//! is written here, read back only when the agent starts
//! ([`atlas_agent_store::SecretEnv`]), and never sent to the webview.
//!
//! The legacy item is service [`SERVICE`], account `<agent id>/<NAME>`.
//! Windows values use a committed manifest and bounded binary chunks, because
//! Credential Manager limits each blob to 2560 bytes.

use atlas_agent_store::SecretSource;

const SERVICE: &str = "Atlas agent variables";

#[cfg(any(windows, test))]
mod chunked;

static TRANSACTION: parking_lot::Mutex<()> = parking_lot::Mutex::new(());

fn entry(agent: &str, name: &str) -> keyring_core::Result<keyring_core::Entry> {
    // keyring-core has no store until one is installed; this is the same idempotent
    // installer the engine's keychain access calls, so both see one default store.
    atlas_native_agent::ensure_credential_store()?;
    keyring_core::Entry::new(SERVICE, &format!("{agent}/{name}"))
}

/// The store's view of the keychain.
pub struct Keychain;

impl SecretSource for Keychain {
    fn read(&self, agent: &str, name: &str) -> Option<String> {
        let _guard = TRANSACTION.lock();
        #[cfg(windows)]
        match chunked::read(&WindowsChunks, &format!("{agent}/{name}")) {
            Ok(Some(value)) => return Some(value),
            Ok(None) => {}
            Err(e) => {
                tracing::warn!(target: "atlas::agents", agent, name, "couldn't read a sensitive variable: {e}");
                return None;
            }
        }
        match entry(agent, name).and_then(|e| e.get_password()) {
            Ok(value) => Some(value),
            Err(keyring_core::Error::NoEntry) => None,
            Err(e) => {
                tracing::warn!(
                    target: "atlas::agents",
                    agent, name, "couldn't read a sensitive variable from the keychain: {e}"
                );
                None
            }
        }
    }
}

/// Store a value. Blocking: call it from `spawn_blocking`.
pub fn write(agent: &str, name: &str, value: &str) -> Result<(), String> {
    let _guard = TRANSACTION.lock();
    #[cfg(windows)]
    {
        chunked::write(&WindowsChunks, &format!("{agent}/{name}"), value)?;
        // The new manifest is already durable. A leftover legacy value is
        // ignored by readers, and delete() also removes it.
        let _ = entry(agent, name).and_then(|e| e.delete_credential());
        Ok(())
    }
    #[cfg(not(windows))]
    entry(agent, name)
        .and_then(|e| e.set_password(value))
        .map_err(|e| format!("saving {name} to the keychain: {e}"))
}

/// Forget a value; one that was never stored is already forgotten.
/// Blocking: call it from `spawn_blocking`.
pub fn delete(agent: &str, name: &str) -> Result<(), String> {
    let _guard = TRANSACTION.lock();
    match entry(agent, name).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring_core::Error::NoEntry) => {
            #[cfg(windows)]
            chunked::delete(&WindowsChunks, &format!("{agent}/{name}"))?;
            Ok(())
        }
        Err(e) => Err(format!("removing {name} from the keychain: {e}")),
    }
}

#[cfg(windows)]
struct WindowsChunks;

#[cfg(windows)]
impl WindowsChunks {
    fn entry(account: &str) -> keyring_core::Result<keyring_core::Entry> {
        atlas_native_agent::ensure_credential_store()?;
        keyring_core::Entry::new("Atlas agent variables chunks v1", account)
    }
}

#[cfg(windows)]
impl chunked::Store for WindowsChunks {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
        match Self::entry(key).and_then(|e| e.get_secret()) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(keyring_core::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn put(&self, key: &str, bytes: &[u8]) -> Result<(), String> {
        Self::entry(key)
            .and_then(|e| e.set_secret(bytes))
            .map_err(|e| e.to_string())
    }

    fn remove(&self, key: &str) -> Result<(), String> {
        match Self::entry(key).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}
