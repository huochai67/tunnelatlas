use std::{fs, io::Write, path::Path};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use ed25519_dalek::{SigningKey, VerifyingKey};
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub agent_id: String,
    pub private_key: String,
    pub next_sequence: u64,
}

impl Identity {
    pub fn generate_pending() -> (SigningKey, String) {
        let mut bytes = [0_u8; 32];
        OsRng.fill_bytes(&mut bytes);
        let key = SigningKey::from_bytes(&bytes);
        let public_key = URL_SAFE_NO_PAD.encode(VerifyingKey::from(&key).as_bytes());
        (key, public_key)
    }

    pub fn from_enrollment(agent_id: String, key: &SigningKey) -> Self {
        Self {
            agent_id,
            private_key: URL_SAFE_NO_PAD.encode(key.to_bytes()),
            next_sequence: 1,
        }
    }

    pub fn signing_key(&self) -> Result<SigningKey> {
        let bytes = URL_SAFE_NO_PAD
            .decode(&self.private_key)
            .context("identity contains invalid private key encoding")?;
        let bytes: [u8; 32] = bytes
            .try_into()
            .map_err(|_| anyhow::anyhow!("identity private key must be 32 bytes"))?;
        Ok(SigningKey::from_bytes(&bytes))
    }

    pub fn load(path: &Path) -> Result<Self> {
        let bytes = fs::read(path)
            .with_context(|| format!("failed to read identity {}", path.display()))?;
        serde_json::from_slice(&bytes).context("invalid identity file")
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
        let temporary = path.with_extension("tmp");
        let bytes = serde_json::to_vec_pretty(self)?;

        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
        }
        #[cfg(not(unix))]
        fs::write(&temporary, &bytes)?;

        fs::rename(&temporary, path)?;
        Ok(())
    }

    pub fn take_sequence(&mut self, path: &Path) -> Result<u64> {
        let sequence = self.next_sequence;
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("sequence exhausted"))?;
        self.save(path)?;
        if sequence == 0 {
            bail!("sequence zero is reserved");
        }
        Ok(sequence)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_sequence_before_use() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("identity.json");
        let (key, _) = Identity::generate_pending();
        let mut identity = Identity::from_enrollment("agent-test".into(), &key);
        identity.save(&path).unwrap();
        assert_eq!(identity.take_sequence(&path).unwrap(), 1);
        assert_eq!(Identity::load(&path).unwrap().next_sequence, 2);
    }
}
