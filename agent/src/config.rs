use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::Path,
};

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
fn default_listen() -> String {
    "::".to_owned()
}
fn default_ss_method() -> String {
    "2022-blake3-aes-128-gcm".to_owned()
}
fn default_tls_name() -> String {
    "www.bing.com".to_owned()
}
fn default_reality_name() -> String {
    "addons.mozilla.org".to_owned()
}
fn default_congestion_control() -> String {
    "bbr".to_owned()
}
fn default_ws_path() -> String {
    "/vmess".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub server_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enrollment_token: Option<String>,
    #[serde(default = "default_report_interval")]
    pub report_interval_seconds: u64,
    #[serde(default)]
    pub labels: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_host: Option<String>,
    #[serde(default = "default_runtime")]
    pub runtime_path: String,
    pub sing_box: SingBoxSettings,
    #[serde(default)]
    pub protocols: Vec<ProtocolSpec>,
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolSpec {
    pub tag: String,
    #[serde(default = "default_listen")]
    pub listen: String,
    pub port: u16,
    #[serde(flatten)]
    pub kind: ProtocolKind,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProtocolKind {
    Shadowsocks {
        #[serde(default = "default_ss_method")]
        method: String,
    },
    Hysteria2 {
        #[serde(default = "default_tls_name")]
        server_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        certificate_path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key_path: Option<String>,
    },
    Tuic {
        #[serde(default = "default_tls_name")]
        server_name: String,
        #[serde(default = "default_congestion_control")]
        congestion_control: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        certificate_path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        key_path: Option<String>,
    },
    VlessReality {
        #[serde(default = "default_reality_name")]
        server_name: String,
    },
    AnytlsReality {
        #[serde(default = "default_reality_name")]
        server_name: String,
    },
    VmessWs {
        #[serde(default = "default_ws_path")]
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        host: Option<String>,
    },
}

impl ProtocolKind {
    pub fn name(&self) -> &'static str {
        match self {
            Self::Shadowsocks { .. } => "shadowsocks",
            Self::Hysteria2 { .. } => "hysteria2",
            Self::Tuic { .. } => "tuic",
            Self::VlessReality { .. } => "vless-reality",
            Self::AnytlsReality { .. } => "anytls-reality",
            Self::VmessWs { .. } => "vmess-ws",
        }
    }
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
        if self.protocols.len() > 64 {
            bail!("protocols must contain at most 64 entries");
        }
        if self.public_host.as_deref().is_some_and(|host| {
            host.trim().is_empty() || host.chars().any(char::is_whitespace) || host.contains('/')
        }) {
            bail!("publicHost must be a hostname or IP address without a port");
        }
        if let Some(host) = self
            .public_host
            .as_deref()
            .filter(|host| host.contains(':'))
        {
            let unbracketed = host
                .strip_prefix('[')
                .and_then(|value| value.strip_suffix(']'))
                .unwrap_or(host);
            if unbracketed.parse::<std::net::Ipv6Addr>().is_err() {
                bail!("publicHost must not include a port");
            }
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
        let mut tags = BTreeSet::new();
        let mut ports = BTreeSet::new();
        for protocol in &self.protocols {
            if protocol.port == 0 {
                bail!("protocol {} port must be between 1 and 65535", protocol.tag);
            }
            if protocol.tag.trim().is_empty()
                || !protocol
                    .tag
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
            {
                bail!("protocol tag must contain only letters, numbers, '-' and '_'");
            }
            if !tags.insert(&protocol.tag) {
                bail!("duplicate protocol tag: {}", protocol.tag);
            }
            if !ports.insert(protocol.port) {
                bail!("duplicate protocol port: {}", protocol.port);
            }
            if protocol.listen.trim().is_empty() {
                bail!("protocol {} listen address cannot be empty", protocol.tag);
            }
            match &protocol.kind {
                ProtocolKind::Shadowsocks { method } if method.trim().is_empty() => {
                    bail!("Shadowsocks method cannot be empty")
                }
                ProtocolKind::Hysteria2 {
                    server_name,
                    certificate_path,
                    key_path,
                }
                | ProtocolKind::Tuic {
                    server_name,
                    certificate_path,
                    key_path,
                    ..
                } => {
                    if server_name.trim().is_empty() {
                        bail!("TLS serverName cannot be empty");
                    }
                    if certificate_path.is_some() != key_path.is_some() {
                        bail!("certificatePath and keyPath must be provided together");
                    }
                    if let (Some(certificate), Some(key)) = (certificate_path, key_path) {
                        let directory = Path::new(&self.sing_box.certificates_directory);
                        if !Path::new(certificate).starts_with(directory)
                            || !Path::new(key).starts_with(directory)
                        {
                            bail!(
                                "external certificates must be imported into singBox.certificatesDirectory"
                            );
                        }
                    }
                }
                ProtocolKind::VlessReality { server_name }
                | ProtocolKind::AnytlsReality { server_name }
                    if server_name.trim().is_empty() =>
                {
                    bail!("Reality serverName cannot be empty")
                }
                ProtocolKind::VmessWs { path, .. } if !path.starts_with('/') => {
                    bail!("VMess WebSocket path must start with '/'")
                }
                _ => {}
            }
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
    fn rejects_duplicate_tags_and_ports() {
        let yaml = r#"
serverUrl: https://example.com
singBox: {}
protocols:
  - { tag: one, port: 443, type: shadowsocks }
  - { tag: one, port: 444, type: vmess-ws }
"#;
        let config: Config = serde_yaml::from_str(yaml).unwrap();
        assert!(
            config
                .validate()
                .unwrap_err()
                .to_string()
                .contains("duplicate protocol tag")
        );
    }

    #[test]
    fn old_source_config_field_is_not_accepted() {
        let yaml = r#"
serverUrl: https://example.com
singBox:
  sourceConfigPath: /etc/sing-box/config.json
"#;
        assert!(serde_yaml::from_str::<Config>(yaml).is_err());
    }

    #[test]
    fn legacy_site_and_agent_names_are_not_accepted() {
        let yaml = r#"
serverUrl: https://example.com
agentName: edge
siteId: home
singBox: {}
"#;
        assert!(serde_yaml::from_str::<Config>(yaml).is_err());
    }

    #[test]
    fn protocol_options_use_camel_case() {
        let yaml = r#"
serverUrl: https://example.com
singBox: {}
protocols:
  - { tag: reality, port: 443, type: vless-reality, serverName: example.com }
"#;
        let config: Config = serde_yaml::from_str(yaml).unwrap();
        let encoded = serde_yaml::to_string(&config).unwrap();
        assert!(encoded.contains("serverName: example.com"));
        assert!(!encoded.contains("server_name"));
    }
}
