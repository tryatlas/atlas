//! Write fresh generations first and publish one manifest last. A failed write
//! leaves the previous value readable. All chunks remain in the OS keychain.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

// CRED_MAX_CREDENTIAL_BLOB_SIZE is 5 * 512 bytes. Leave room below the bound;
// binary chunks avoid Windows' UTF-16 password encoding doubling ASCII values.
const CHUNK_BYTES: usize = 2400;
const MAX_BYTES: usize = 16 * 1024 * 1024;

pub(super) trait Store {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String>;
    fn put(&self, key: &str, bytes: &[u8]) -> Result<(), String>;
    fn remove(&self, key: &str) -> Result<(), String>;
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    version: u8,
    generation: String,
    chunks: usize,
    bytes: usize,
    sha256: String,
}

fn manifest(store: &impl Store, key: &str) -> Result<Option<Manifest>, String> {
    let Some(bytes) = store.get(&format!("value/{key}"))? else {
        return Ok(None);
    };
    let manifest: Manifest = serde_json::from_slice(&bytes)
        .map_err(|_| "Invalid sensitive-variable manifest".to_string())?;
    if manifest.version != 1
        || uuid::Uuid::parse_str(&manifest.generation).is_err()
        || manifest.bytes > MAX_BYTES
        || manifest.chunks != manifest.bytes.div_ceil(CHUNK_BYTES)
    {
        return Err("Invalid sensitive-variable manifest".into());
    }
    Ok(Some(manifest))
}

fn chunk_key(manifest: &Manifest, index: usize) -> String {
    format!("chunk/{}/{index}", manifest.generation)
}

pub(super) fn read(store: &impl Store, key: &str) -> Result<Option<String>, String> {
    let Some(manifest) = manifest(store, key)? else {
        return Ok(None);
    };
    let mut bytes = Vec::with_capacity(manifest.bytes);
    for index in 0..manifest.chunks {
        let chunk = store
            .get(&chunk_key(&manifest, index))?
            .ok_or_else(|| "A sensitive-variable chunk is missing".to_string())?;
        if chunk.len() > CHUNK_BYTES || bytes.len() + chunk.len() > manifest.bytes {
            return Err("Invalid sensitive-variable chunk".into());
        }
        bytes.extend(chunk);
    }
    if bytes.len() != manifest.bytes || format!("{:x}", Sha256::digest(&bytes)) != manifest.sha256 {
        return Err("Sensitive-variable integrity check failed".into());
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "Invalid sensitive-variable encoding".into())
}

fn remove_chunks(store: &impl Store, manifest: &Manifest) {
    for index in 0..manifest.chunks {
        let _ = store.remove(&chunk_key(manifest, index));
    }
}

pub(super) fn write(store: &impl Store, key: &str, value: &str) -> Result<(), String> {
    if value.len() > MAX_BYTES {
        return Err("Sensitive variable exceeds 16 MiB".into());
    }
    let old = manifest(store, key)?;
    let next = Manifest {
        version: 1,
        generation: uuid::Uuid::new_v4().to_string(),
        chunks: value.len().div_ceil(CHUNK_BYTES),
        bytes: value.len(),
        sha256: format!("{:x}", Sha256::digest(value.as_bytes())),
    };
    let result = (|| {
        for (index, chunk) in value.as_bytes().chunks(CHUNK_BYTES).enumerate() {
            store.put(&chunk_key(&next, index), chunk)?;
        }
        let bytes = serde_json::to_vec(&next).map_err(|e| e.to_string())?;
        store.put(&format!("value/{key}"), &bytes)
    })();
    if result.is_err() {
        remove_chunks(store, &next);
    } else if let Some(old) = old {
        remove_chunks(store, &old);
    }
    result
}

pub(super) fn delete(store: &impl Store, key: &str) -> Result<(), String> {
    let old = manifest(store, key)?;
    store.remove(&format!("value/{key}"))?;
    if let Some(old) = old {
        remove_chunks(store, &old);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryStore {
        values: RefCell<HashMap<String, Vec<u8>>>,
        fail_after: Cell<Option<usize>>,
    }

    impl Store for MemoryStore {
        fn get(&self, key: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self.values.borrow().get(key).cloned())
        }
        fn put(&self, key: &str, bytes: &[u8]) -> Result<(), String> {
            assert!(bytes.len() <= 2560, "Windows credential blob limit");
            if let Some(left) = self.fail_after.get() {
                if left == 0 {
                    return Err("injected keychain failure".into());
                }
                self.fail_after.set(Some(left - 1));
            }
            self.values.borrow_mut().insert(key.into(), bytes.into());
            Ok(())
        }
        fn remove(&self, key: &str) -> Result<(), String> {
            self.values.borrow_mut().remove(key);
            Ok(())
        }
    }

    #[test]
    fn long_unicode_and_empty_values_round_trip_and_delete() {
        let store = MemoryStore::default();
        let value = "🔐 credential\n".repeat(1000);
        write(&store, "agent/KEY", &value).unwrap();
        assert_eq!(read(&store, "agent/KEY").unwrap(), Some(value));
        write(&store, "agent/KEY", "").unwrap();
        assert_eq!(read(&store, "agent/KEY").unwrap(), Some(String::new()));
        assert_eq!(store.values.borrow().len(), 1);
        delete(&store, "agent/KEY").unwrap();
        assert_eq!(read(&store, "agent/KEY").unwrap(), None);
        assert!(store.values.borrow().is_empty());
    }

    #[test]
    fn failed_chunk_or_manifest_write_preserves_previous_value() {
        for fail_after in 0..=3 {
            let store = MemoryStore::default();
            write(&store, "agent/KEY", "previous").unwrap();
            store.fail_after.set(Some(fail_after));
            assert!(write(&store, "agent/KEY", &"x".repeat(6000)).is_err());
            assert_eq!(
                read(&store, "agent/KEY").unwrap().as_deref(),
                Some("previous")
            );
            assert_eq!(store.values.borrow().len(), 2);
        }
    }

    #[test]
    fn missing_chunk_never_returns_a_partial_secret() {
        let store = MemoryStore::default();
        write(&store, "agent/KEY", &"x".repeat(6000)).unwrap();
        let manifest = manifest(&store, "agent/KEY").unwrap().unwrap();
        store.remove(&chunk_key(&manifest, 1)).unwrap();
        assert!(read(&store, "agent/KEY").is_err());
    }
}
