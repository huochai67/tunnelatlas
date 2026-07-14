use std::{collections::BTreeMap, fs, path::Path};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

fn default_report_interval() -> u64 {
    60
}

fn default_reconcile_interval() -> u64 {
    5
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub server_url: String,
    pub agent_name: String,
    pub site_id: String,
    pub enrollment_token: Option<String>,
    #[serde(default = "default_report_interval")]
    pub report_interval_seconds: u64,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    pub sing_box: SingBoxSettings,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SingBoxSettings {
    #[serde(default = "default_binary")]
    pub binary_path: String,
    pub source_config_path: String,
    pub managed_config_path: String,
    pub working_directory: Option<String>,
    #[serde(default = "default_reconcile_interval")]
    pub reconcile_interval_seconds: u64,
    #[serde(default = "default_restart_delay")]
    pub restart_delay_seconds: u64,
    #[serde(default = "default_shutdown_timeout")]
    pub shutdown_timeout_seconds: u64,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self> {
        let content = fs::read_to_string(path)
            .with_context(|| format!("failed to read config {}", path.display()))?;
        let config: Self = serde_yaml::from_str(&content)
            .with_context(|| format!("invalid YAML in {}", path.display()))?;
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<()> {
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
        if self.agent_name.trim().is_empty() || self.site_id.trim().is_empty() {
            bail!("agentName and siteId cannot be empty");
        }
        let sing_box = &self.sing_box;
        if sing_box.binary_path.is_empty()
            || sing_box.source_config_path.is_empty()
            || sing_box.managed_config_path.is_empty()
        {
            bail!("singBox binaryPath, sourceConfigPath and managedConfigPath are required");
        }
        if sing_box.source_config_path == sing_box.managed_config_path {
            bail!("singBox sourceConfigPath and managedConfigPath must be different");
        }
        if sing_box.reconcile_interval_seconds < 2 {
            bail!("singBox.reconcileIntervalSeconds must be at least 2");
        }
        if sing_box.shutdown_timeout_seconds == 0 {
            bail!("singBox.shutdownTimeoutSeconds must be greater than zero");
        }
        Ok(())
    }
}
