use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use curve25519_dalek::montgomery::MontgomeryPoint;
use rand::{RngCore, rngs::OsRng};
use rcgen::generate_simple_self_signed;
use serde::{Deserialize, Serialize};

use crate::{config::write_private_atomic, desired::{DesiredTunnel, TunnelCredentials}};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretStore {
    #[serde(default)]
    pub protocols: BTreeMap<String, ProtocolSecret>,
    #[serde(default)]
    pub generations: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
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

    pub fn reconcile_desired(
        &mut self,
        tunnels: &[DesiredTunnel],
        certs_dir: &Path,
    ) -> Result<bool> {
        let before = self.clone();
        let active_ids: BTreeSet<&str> = tunnels.iter().map(|t| t.id()).collect();
        self.protocols
            .retain(|id, _| active_ids.contains(id.as_str()));
        self.generations
            .retain(|id, _| active_ids.contains(id.as_str()));

        for tunnel in tunnels {
            let next_secret = if let Some(credentials) = tunnel.credentials() {
                ProtocolSecret::from_credentials(tunnel, credentials)?
            } else {
                match (
                    self.protocols.get(tunnel.id()),
                    self.generations.get(tunnel.id()),
                ) {
                    (Some(secret), Some(&generation))
                        if secret.matches_desired(tunnel)
                            && generation == tunnel.credential_generation() =>
                    {
                        secret.clone()
                    }
                    _ => ProtocolSecret::generate_for_desired(tunnel),
                }
            };
            self.protocols.insert(tunnel.id().to_owned(), next_secret);
            self.generations
                .insert(tunnel.id().to_owned(), tunnel.credential_generation());
            ensure_desired_certificate(certs_dir, tunnel)?;
        }
        cleanup_desired_certificates(certs_dir, tunnels)?;
        Ok(*self != before)
    }

    pub fn get_desired(&self, tunnel: &DesiredTunnel) -> Result<&ProtocolSecret> {
        self.protocols
            .get(tunnel.id())
            .filter(|secret| secret.matches_desired(tunnel))
            .with_context(|| format!("missing secrets for desired tunnel {}", tunnel.id()))
    }
}

impl ProtocolSecret {
    pub fn generate_for_desired(tunnel: &DesiredTunnel) -> Self {
        match tunnel {
            DesiredTunnel::Shadowsocks { method, .. } => {
                let bytes = if method.contains("aes-128") { 16 } else { 32 };
                Self::Shadowsocks {
                    password: random_standard_base64(bytes),
                }
            }
            DesiredTunnel::Hysteria2 { .. } => Self::Hysteria2 {
                password: random_base64(24),
            },
            DesiredTunnel::Tuic { .. } => Self::Tuic {
                uuid: uuid::Uuid::new_v4().to_string(),
                password: random_base64(24),
            },
            DesiredTunnel::VlessReality { .. } => {
                let (private_key, public_key) = reality_keypair();
                Self::VlessReality {
                    uuid: uuid::Uuid::new_v4().to_string(),
                    private_key,
                    public_key,
                    short_id: random_hex(8),
                }
            }
            DesiredTunnel::AnytlsReality { .. } => {
                let (private_key, public_key) = reality_keypair();
                Self::AnytlsReality {
                    name: "tunnelatlas".to_owned(),
                    password: random_base64(24),
                    private_key,
                    public_key,
                    short_id: random_hex(8),
                }
            }
            DesiredTunnel::VmessWs { .. } => Self::VmessWs {
                uuid: uuid::Uuid::new_v4().to_string(),
            },
        }
    }

    pub fn from_credentials(tunnel: &DesiredTunnel, credentials: &TunnelCredentials) -> Result<Self> {
        match tunnel {
            DesiredTunnel::Shadowsocks { .. } => Ok(Self::Shadowsocks {
                password: credentials
                    .password
                    .clone()
                    .filter(|value| !value.is_empty())
                    .with_context(|| format!("missing password for {}", tunnel.id()))?,
            }),
            DesiredTunnel::Hysteria2 { .. } => Ok(Self::Hysteria2 {
                password: credentials
                    .password
                    .clone()
                    .filter(|value| !value.is_empty())
                    .with_context(|| format!("missing password for {}", tunnel.id()))?,
            }),
            DesiredTunnel::Tuic { .. } => Ok(Self::Tuic {
                uuid: credentials
                    .uuid
                    .clone()
                    .filter(|value| !value.is_empty())
                    .with_context(|| format!("missing uuid for {}", tunnel.id()))?,
                password: credentials
                    .password
                    .clone()
                    .filter(|value| !value.is_empty())
                    .with_context(|| format!("missing password for {}", tunnel.id()))?,
            }),
            DesiredTunnel::VlessReality { .. } => Ok(Self::VlessReality {
                uuid: credentials
                    .uuid
                    .clone()
                    .filter(|value| !value.is_empty())
                    .with_context(|| format!("missing uuid for {}", tunnel.id()))?,
                private_key: credentials
                    .private_key
                    .clone()
                    .filter(|value| !value.is_empty())
                    .with_context(|| format!("missing private key for {}", tunnel.id()))?,
                public_key: credentials
                    .public_key
                    .clone()
                    .filter(|value| !value.is_empty())
                    .with_context(|| format!("missing public key for {}", tunnel.id()))?,
                short_id: credentials
                    .short_id
                    .clone()
                    .filter(|value| !value.is_empty())
                    .with_context(|| format!("missing short id for {}", tunnel.id()))?,
            }),
            DesiredTunnel::AnytlsReality { .. } => Ok(Self::AnytlsReality {
                name: credentials
                    .name
                    .clone()
                    .filter(|value| !value.is_empty())
                    .unwrap_or_else(|| "tunnelatlas".to_owned()),
                password: credentials
                    .password
                    .clone()
                    .filter(|value| !value.is_empty())
                    .with_context(|| format!("missing password for {}", tunnel.id()))?,
                private_key: credentials
                    .private_key
                    .clone()
                    .filter(|value| !value.is_empty())
                    .with_context(|| format!("missing private key for {}", tunnel.id()))?,
                public_key: credentials
                    .public_key
                    .clone()
                    .filter(|value| !value.is_empty())
                    .with_context(|| format!("missing public key for {}", tunnel.id()))?,
                short_id: credentials
                    .short_id
                    .clone()
                    .filter(|value| !value.is_empty())
                    .with_context(|| format!("missing short id for {}", tunnel.id()))?,
            }),
            DesiredTunnel::VmessWs { .. } => Ok(Self::VmessWs {
                uuid: credentials
                    .uuid
                    .clone()
                    .filter(|value| !value.is_empty())
                    .with_context(|| format!("missing uuid for {}", tunnel.id()))?,
            }),
        }
    }

    pub fn matches_desired(&self, tunnel: &DesiredTunnel) -> bool {
        matches!(
            (self, tunnel),
            (Self::Shadowsocks { .. }, DesiredTunnel::Shadowsocks { .. })
                | (Self::Hysteria2 { .. }, DesiredTunnel::Hysteria2 { .. })
                | (Self::Tuic { .. }, DesiredTunnel::Tuic { .. })
                | (
                    Self::VlessReality { .. },
                    DesiredTunnel::VlessReality { .. }
                )
                | (
                    Self::AnytlsReality { .. },
                    DesiredTunnel::AnytlsReality { .. }
                )
                | (Self::VmessWs { .. }, DesiredTunnel::VmessWs { .. })
        )
    }
}

pub fn desired_certificate_paths(
    certificates_dir: &Path,
    tunnel: &DesiredTunnel,
) -> (PathBuf, PathBuf) {
    let base = format!("{}-{}", tunnel.id(), tunnel.credential_generation());
    (
        certificates_dir.join(format!("{base}.crt")),
        certificates_dir.join(format!("{base}.key")),
    )
}

pub fn ensure_desired_certificate(certificates_dir: &Path, tunnel: &DesiredTunnel) -> Result<()> {
    let server_name = match tunnel {
        DesiredTunnel::Hysteria2 { server_name, .. } | DesiredTunnel::Tuic { server_name, .. } => {
            server_name
        }
        _ => return Ok(()),
    };
    let (cert_path, key_path) = desired_certificate_paths(certificates_dir, tunnel);
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

pub fn cleanup_desired_certificates(
    certificates_dir: &Path,
    tunnels: &[DesiredTunnel],
) -> Result<()> {
    if !certificates_dir.exists() {
        return Ok(());
    }
    let mut allowed = BTreeSet::new();
    for tunnel in tunnels {
        if matches!(
            tunnel,
            DesiredTunnel::Hysteria2 { .. } | DesiredTunnel::Tuic { .. }
        ) {
            let (certificate, key) = desired_certificate_paths(certificates_dir, tunnel);
            if let Some(name) = certificate.file_name() {
                allowed.insert(name.to_owned());
            }
            if let Some(name) = key.file_name() {
                allowed.insert(name.to_owned());
            }
        }
    }
    for entry in fs::read_dir(certificates_dir)? {
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

    #[test]
    fn secrets_are_stable_until_credential_generation_advances() {
        let temp_dir = tempfile::tempdir().unwrap();
        let certs_dir = temp_dir.path().join("certs");
        let tunnel = DesiredTunnel::Shadowsocks {
            id: "tun_1".into(),
            name: "ss-1".into(),
            listen: "::".into(),
            port: 8388,
            public_host: None,
            credential_generation: 1,
            method: "2022-blake3-aes-128-gcm".into(),
            credentials: None,
            hops: vec![],
        };

        let mut secrets = SecretStore::default();
        assert!(
            secrets
                .reconcile_desired(std::slice::from_ref(&tunnel), &certs_dir)
                .unwrap()
        );
        let first = secrets.clone();

        // Same generation -> no change
        assert!(
            !secrets
                .reconcile_desired(std::slice::from_ref(&tunnel), &certs_dir)
                .unwrap()
        );
        assert_eq!(secrets, first);

        // Advanced generation -> regenerates
        let rotated_tunnel = DesiredTunnel::Shadowsocks {
            id: "tun_1".into(),
            name: "ss-1".into(),
            listen: "::".into(),
            port: 8388,
            public_host: None,
            credential_generation: 2,
            method: "2022-blake3-aes-128-gcm".into(),
            credentials: None,
            hops: vec![],
        };
        assert!(
            secrets
                .reconcile_desired(&[rotated_tunnel], &certs_dir)
                .unwrap()
        );
        assert_ne!(secrets, first);
    }
}
