use std::{collections::BTreeMap, fs, path::Path};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

fn default_report_interval() -> u64 {
    60
}
fn default_restart_delay() -> u64 {
    5
}
fn default_shutdown_timeout() -> u64 {
    10
}
fn default_binary() -> String {
    "/usr/local/bin/sing-box".to_owned()
}
fn default_managed_config() -> String {
    "/var/lib/tunnelatlas/sing-box.json".to_owned()
}
fn default_secrets() -> String {
    "/var/lib/tunnelatlas/secrets.json".to_owned()
}
fn default_runtime() -> String {
    "/var/lib/tunnelatlas/runtime.json".to_owned()
}
fn default_certificates() -> String {
    "/var/lib/tunnelatlas/certificates".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub server_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enrollment_token: Option<String>,
    #[serde(default = "default_report_interval")]
    pub report_interval_seconds: u64,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    #[serde(default = "default_runtime")]
    pub runtime_path: String,
    pub sing_box: SingBoxSettings,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) public_host: Option<serde_yaml::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) protocols: Option<serde_yaml::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SingBoxSettings {
    #[serde(default = "default_binary")]
    pub binary_path: String,
    #[serde(default = "default_managed_config")]
    pub managed_config_path: String,
    #[serde(default = "default_secrets")]
    pub secrets_path: String,
    #[serde(default = "default_certificates")]
    pub certificates_directory: String,
    pub working_directory: Option<String>,
    #[serde(default = "default_restart_delay")]
    pub restart_delay_seconds: u64,
    #[serde(default = "default_shutdown_timeout")]
    pub shutdown_timeout_seconds: u64,
}

impl Default for SingBoxSettings {
    fn default() -> Self {
        Self {
            binary_path: default_binary(),
            managed_config_path: default_managed_config(),
            secrets_path: default_secrets(),
            certificates_directory: default_certificates(),
            working_directory: None,
            restart_delay_seconds: default_restart_delay(),
            shutdown_timeout_seconds: default_shutdown_timeout(),
        }
    }
}

impl Config {
    pub fn has_legacy_tunnels(&self) -> bool {
        self.public_host.is_some() || self.protocols.is_some()
    }

    pub fn clear_legacy_tunnels(&mut self) -> bool {
        let had = self.has_legacy_tunnels();
        self.public_host = None;
        self.protocols = None;
        had
    }

    pub fn load(path: &Path) -> Result<Self> {
        let content = fs::read_to_string(path)
            .with_context(|| format!("failed to read config {}", path.display()))?;
        let config: Self = serde_yaml::from_str(&content)
            .with_context(|| format!("invalid YAML in {}", path.display()))?;
        config.validate()?;
        Ok(config)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        self.validate()?;
        let content = serde_yaml::to_string(self)?;
        write_private_atomic(path, content.as_bytes())
    }

    pub fn validate(&self) -> Result<()> {
        let url = url::Url::parse(&self.server_url).context("serverUrl must be a valid URL")?;
        if url.scheme() != "https"
            && url.host_str() != Some("127.0.0.1")
            && url.host_str() != Some("localhost")
        {
            bail!("serverUrl must use HTTPS outside localhost");
        }
        if self.report_interval_seconds < 15 {
            bail!("reportIntervalSeconds must be at least 15");
        }
        if self.sing_box.binary_path.is_empty()
            || self.sing_box.managed_config_path.is_empty()
            || self.sing_box.secrets_path.is_empty()
            || self.sing_box.certificates_directory.is_empty()
        {
            bail!(
                "singBox binaryPath, managedConfigPath, secretsPath and certificatesDirectory are required"
            );
        }
        if self.sing_box.shutdown_timeout_seconds == 0 {
            bail!("singBox.shutdownTimeoutSeconds must be greater than zero");
        }
        Ok(())
    }
}

pub fn write_private_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    let candidate = path.with_extension(format!("{}.tmp", std::process::id()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&candidate)
            .with_context(|| format!("failed to create {}", candidate.display()))?;
        use std::io::Write;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    #[cfg(not(unix))]
    fs::write(&candidate, bytes)?;
    fs::rename(&candidate, path)
        .with_context(|| format!("failed to replace {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_legacy_fields_until_cleared() {
        let yaml = r#"
serverUrl: https://example.com
publicHost: 203.0.113.1
singBox: {}
protocols:
  - tag: one
    port: 443
    type: shadowsocks
"#;
        let mut config: Config = serde_yaml::from_str(yaml).unwrap();
        assert!(config.has_legacy_tunnels());

        // Serializing without clearing preserves the fields
        let serialized = serde_yaml::to_string(&config).unwrap();
        assert!(serialized.contains("publicHost"));
        assert!(serialized.contains("protocols"));

        // Clear legacy fields
        assert!(config.clear_legacy_tunnels());
        assert!(!config.has_legacy_tunnels());

        // Serializing after clearing omits them
        let cleared = serde_yaml::to_string(&config).unwrap();
        assert!(!cleared.contains("publicHost"));
        assert!(!cleared.contains("protocols"));
    }

    #[test]
    fn validates_url_and_report_interval() {
        let yaml = r#"
serverUrl: http://example.com
singBox: {}
"#;
        let config: Config = serde_yaml::from_str(yaml).unwrap();
        assert!(config.validate().is_err());

        let short_interval = r#"
serverUrl: https://example.com
reportIntervalSeconds: 5
singBox: {}
"#;
        let config: Config = serde_yaml::from_str(short_interval).unwrap();
        assert!(config.validate().is_err());
    }
}
