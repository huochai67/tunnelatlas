use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use curve25519_dalek::montgomery::MontgomeryPoint;
use rand::{RngCore, rngs::OsRng};
use rcgen::generate_simple_self_signed;
use serde::{Deserialize, Serialize};

use crate::config::{Config, ProtocolKind, ProtocolSpec, write_private_atomic};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretStore {
    #[serde(default)]
    pub protocols: BTreeMap<String, ProtocolSecret>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProtocolSecret {
    Shadowsocks {
        password: String,
    },
    Hysteria2 {
        password: String,
    },
    Tuic {
        uuid: String,
        password: String,
    },
    VlessReality {
        uuid: String,
        private_key: String,
        public_key: String,
        short_id: String,
    },
    AnytlsReality {
        name: String,
        password: String,
        private_key: String,
        public_key: String,
        short_id: String,
    },
    VmessWs {
        uuid: String,
    },
}

impl SecretStore {
    pub fn load(path: &Path) -> Result<Self> {
        match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .with_context(|| format!("invalid secrets file {}", path.display())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error).with_context(|| format!("failed to read {}", path.display())),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        write_private_atomic(path, &serde_json::to_vec_pretty(self)?)
    }

    pub fn reconcile(&mut self, config: &Config) -> Result<bool> {
        let before = self.clone();
        self.protocols
            .retain(|tag, _| config.protocols.iter().any(|protocol| &protocol.tag == tag));
        for protocol in &config.protocols {
            if self
                .protocols
                .get(&protocol.tag)
                .is_none_or(|secret| !secret.matches(&protocol.kind))
            {
                self.protocols.insert(
                    protocol.tag.clone(),
                    ProtocolSecret::generate(&protocol.kind),
                );
            }
            ensure_certificate(config, protocol)?;
        }
        cleanup_certificates(config)?;
        Ok(*self != before)
    }

    pub fn rotate(&mut self, protocol: &ProtocolSpec) {
        self.protocols.insert(
            protocol.tag.clone(),
            ProtocolSecret::generate(&protocol.kind),
        );
    }

    pub fn get(&self, protocol: &ProtocolSpec) -> Result<&ProtocolSecret> {
        self.protocols
            .get(&protocol.tag)
            .filter(|secret| secret.matches(&protocol.kind))
            .with_context(|| format!("missing secrets for protocol {}", protocol.tag))
    }
}

impl PartialEq for SecretStore {
    fn eq(&self, other: &Self) -> bool {
        self.protocols == other.protocols
    }
}

impl ProtocolSecret {
    fn generate(kind: &ProtocolKind) -> Self {
        match kind {
            ProtocolKind::Shadowsocks { method } => {
                let bytes = if method.contains("aes-128") { 16 } else { 32 };
                Self::Shadowsocks {
                    password: random_standard_base64(bytes),
                }
            }
            ProtocolKind::Hysteria2 { .. } => Self::Hysteria2 {
                password: random_base64(24),
            },
            ProtocolKind::Tuic { .. } => Self::Tuic {
                uuid: uuid::Uuid::new_v4().to_string(),
                password: random_base64(24),
            },
            ProtocolKind::VlessReality { .. } => {
                let (private_key, public_key) = reality_keypair();
                Self::VlessReality {
                    uuid: uuid::Uuid::new_v4().to_string(),
                    private_key,
                    public_key,
                    short_id: random_hex(8),
                }
            }
            ProtocolKind::AnytlsReality { .. } => {
                let (private_key, public_key) = reality_keypair();
                Self::AnytlsReality {
                    name: "tunnelatlas".to_owned(),
                    password: random_base64(24),
                    private_key,
                    public_key,
                    short_id: random_hex(8),
                }
            }
            ProtocolKind::VmessWs { .. } => Self::VmessWs {
                uuid: uuid::Uuid::new_v4().to_string(),
            },
        }
    }

    fn matches(&self, kind: &ProtocolKind) -> bool {
        matches!(
            (self, kind),
            (Self::Shadowsocks { .. }, ProtocolKind::Shadowsocks { .. })
                | (Self::Hysteria2 { .. }, ProtocolKind::Hysteria2 { .. })
                | (Self::Tuic { .. }, ProtocolKind::Tuic { .. })
                | (Self::VlessReality { .. }, ProtocolKind::VlessReality { .. })
                | (
                    Self::AnytlsReality { .. },
                    ProtocolKind::AnytlsReality { .. }
                )
                | (Self::VmessWs { .. }, ProtocolKind::VmessWs { .. })
        )
    }
}

pub fn certificate_paths(config: &Config, protocol: &ProtocolSpec) -> Result<(PathBuf, PathBuf)> {
    match &protocol.kind {
        ProtocolKind::Hysteria2 {
            certificate_path: Some(cert),
            key_path: Some(key),
            ..
        }
        | ProtocolKind::Tuic {
            certificate_path: Some(cert),
            key_path: Some(key),
            ..
        } => Ok((PathBuf::from(cert), PathBuf::from(key))),
        ProtocolKind::Hysteria2 { .. } | ProtocolKind::Tuic { .. } => {
            let directory = Path::new(&config.sing_box.certificates_directory);
            Ok((
                directory.join(format!("{}.pem", protocol.tag)),
                directory.join(format!("{}.key", protocol.tag)),
            ))
        }
        _ => bail!("protocol {} does not use a certificate", protocol.tag),
    }
}

fn ensure_certificate(config: &Config, protocol: &ProtocolSpec) -> Result<()> {
    let server_name = match &protocol.kind {
        ProtocolKind::Hysteria2 {
            server_name,
            certificate_path,
            ..
        }
        | ProtocolKind::Tuic {
            server_name,
            certificate_path,
            ..
        } => {
            if certificate_path.is_some() {
                return Ok(());
            }
            server_name
        }
        _ => return Ok(()),
    };
    let (cert_path, key_path) = certificate_paths(config, protocol)?;
    if cert_path.exists() && key_path.exists() {
        return Ok(());
    }
    if let Some(parent) = cert_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let generated = generate_simple_self_signed(vec![server_name.clone()])?;
    write_private_atomic(&cert_path, generated.cert.pem().as_bytes())?;
    write_private_atomic(&key_path, generated.key_pair.serialize_pem().as_bytes())?;
    Ok(())
}

fn cleanup_certificates(config: &Config) -> Result<()> {
    let directory = Path::new(&config.sing_box.certificates_directory);
    if !directory.exists() {
        return Ok(());
    }
    let mut allowed = BTreeSet::new();
    for protocol in &config.protocols {
        if matches!(
            &protocol.kind,
            ProtocolKind::Hysteria2 { .. } | ProtocolKind::Tuic { .. }
        ) {
            let (certificate, key) = certificate_paths(config, protocol)?;
            if let Some(name) = certificate.file_name() {
                allowed.insert(name.to_owned());
            }
            if let Some(name) = key.file_name() {
                allowed.insert(name.to_owned());
            }
        }
    }
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        if entry.file_type()?.is_file() && !allowed.contains(&entry.file_name()) {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

fn random_base64(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    OsRng.fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn random_standard_base64(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    OsRng.fill_bytes(&mut value);
    STANDARD.encode(value)
}

fn random_hex(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    OsRng.fill_bytes(&mut value);
    hex::encode(value)
}

fn reality_keypair() -> (String, String) {
    let mut private = [0u8; 32];
    OsRng.fill_bytes(&mut private);
    let public = MontgomeryPoint::mul_base_clamped(private).to_bytes();
    (
        URL_SAFE_NO_PAD.encode(private),
        URL_SAFE_NO_PAD.encode(public),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SingBoxSettings;

    fn config(directory: &Path) -> Config {
        Config {
            server_url: "https://example.com".into(),
            enrollment_token: None,
            report_interval_seconds: 60,
            labels: BTreeMap::new(),
            public_host: None,
            runtime_path: directory.join("runtime.json").to_string_lossy().into(),
            sing_box: SingBoxSettings {
                binary_path: "/bin/true".into(),
                managed_config_path: directory.join("sing-box.json").to_string_lossy().into(),
                secrets_path: directory.join("secrets.json").to_string_lossy().into(),
                certificates_directory: directory.join("certs").to_string_lossy().into(),
                working_directory: None,
                restart_delay_seconds: 1,
                shutdown_timeout_seconds: 1,
            },
            protocols: vec![ProtocolSpec {
                tag: "ss".into(),
                listen: "::".into(),
                port: 8388,
                kind: ProtocolKind::Shadowsocks {
                    method: "2022-blake3-aes-128-gcm".into(),
                },
            }],
        }
    }

    #[test]
    fn secrets_are_stable_until_rotated() {
        let directory = tempfile::tempdir().unwrap();
        let config = config(directory.path());
        let mut secrets = SecretStore::default();
        assert!(secrets.reconcile(&config).unwrap());
        let first = secrets.clone();
        assert!(!secrets.reconcile(&config).unwrap());
        assert_eq!(secrets, first);
        secrets.rotate(&config.protocols[0]);
        assert_ne!(secrets, first);
    }
}
