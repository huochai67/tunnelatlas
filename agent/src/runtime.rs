use std::{fs, path::Path};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use crate::{config::write_private_atomic, desired::DesiredConfig, protocol::ConfigApplyErrorCode};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub observed_address: Option<String>,
    #[serde(default)]
    pub process_healthy: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_desired_config: Option<DesiredConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_apply_error: Option<ConfigApplyErrorCode>,
}

impl RuntimeState {
    pub fn load(path: &Path) -> Result<Self> {
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .with_context(|| format!("invalid runtime state {}", path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error).with_context(|| format!("failed to read {}", path.display())),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        write_private_atomic(path, &serde_json::to_vec_pretty(self)?)
    }
}
