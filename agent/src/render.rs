use std::path::Path;

use anyhow::{Result, bail};
use serde_json::{Value, json};

use crate::{
    config::{Config, ProtocolKind, ProtocolSpec},
    secrets::{ProtocolSecret, SecretStore, certificate_paths},
    sing_box::ObservedTunnel,
};

pub struct RenderedConfig {
    pub bytes: Vec<u8>,
    pub tunnels: Vec<ObservedTunnel>,
}

pub fn render(config: &Config, secrets: &SecretStore, status: &str) -> Result<RenderedConfig> {
    let mut inbounds = Vec::new();
    let mut tunnels = Vec::new();
    for protocol in &config.protocols {
        let secret = secrets.get(protocol)?;
        let (inbound, metadata, authentication, reported_protocol) =
            render_protocol(config, protocol, secret)?;
        inbounds.push(inbound);
        tunnels.push(ObservedTunnel {
            id: uuid::Uuid::new_v5(
                &uuid::Uuid::NAMESPACE_URL,
                format!("tunnelatlas:sing-box:inbound:{}", protocol.tag).as_bytes(),
            )
            .to_string(),
            name: protocol.tag.clone(),
            kind: "sing-box/inbound".to_owned(),
            endpoint: endpoint(
                config.public_host.as_deref().unwrap_or(&protocol.listen),
                protocol.port,
            ),
            protocol: reported_protocol.to_owned(),
            status: status.to_owned(),
            metadata,
            authentication,
        });
    }
    let document = json!({
        "log": { "level": "info", "timestamp": true },
        "inbounds": inbounds,
        "outbounds": [{ "type": "direct", "tag": "direct" }]
    });
    Ok(RenderedConfig {
        bytes: serde_json::to_vec_pretty(&document)?,
        tunnels,
    })
}

fn render_protocol(
    config: &Config,
    protocol: &ProtocolSpec,
    secret: &ProtocolSecret,
) -> Result<(Value, Value, Value, &'static str)> {
    let base =
        || json!({ "tag": protocol.tag, "listen": protocol.listen, "listen_port": protocol.port });
    match (&protocol.kind, secret) {
        (ProtocolKind::Shadowsocks { method }, ProtocolSecret::Shadowsocks { password }) => {
            let mut inbound = base();
            merge(
                &mut inbound,
                json!({ "type": "shadowsocks", "method": method, "password": password }),
            );
            Ok((
                inbound,
                json!({ "direction": "inbound" }),
                json!({ "method": method, "password": password }),
                "shadowsocks",
            ))
        }
        (ProtocolKind::Hysteria2 { server_name, .. }, ProtocolSecret::Hysteria2 { password }) => {
            let (certificate, key) = certificate_paths(config, protocol)?;
            let tls = certificate_tls(server_name, &certificate, &key, true);
            let mut inbound = base();
            merge(
                &mut inbound,
                json!({ "type": "hysteria2", "users": [{ "password": password }], "tls": tls }),
            );
            Ok((
                inbound,
                tls_metadata(server_name, true, Some(vec!["h3"])),
                json!({ "users": [{ "password": password }] }),
                "hysteria2",
            ))
        }
        (
            ProtocolKind::Tuic {
                server_name,
                congestion_control,
                ..
            },
            ProtocolSecret::Tuic { uuid, password },
        ) => {
            let (certificate, key) = certificate_paths(config, protocol)?;
            let tls = certificate_tls(server_name, &certificate, &key, true);
            let mut inbound = base();
            merge(
                &mut inbound,
                json!({ "type": "tuic", "users": [{ "uuid": uuid, "password": password }], "congestion_control": congestion_control, "tls": tls }),
            );
            let mut metadata = tls_metadata(server_name, true, Some(vec!["h3"]));
            metadata["congestionControl"] = json!(congestion_control);
            Ok((
                inbound,
                metadata,
                json!({ "users": [{ "uuid": uuid, "password": password }] }),
                "tuic",
            ))
        }
        (
            ProtocolKind::VlessReality { server_name },
            ProtocolSecret::VlessReality {
                uuid,
                private_key,
                public_key,
                short_id,
            },
        ) => {
            let tls = reality_tls(server_name, private_key, short_id);
            let mut inbound = base();
            merge(
                &mut inbound,
                json!({ "type": "vless", "users": [{ "uuid": uuid, "flow": "xtls-rprx-vision" }], "tls": tls }),
            );
            Ok((
                inbound,
                reality_metadata(server_name, public_key, short_id),
                json!({ "users": [{ "uuid": uuid, "flow": "xtls-rprx-vision" }] }),
                "vless",
            ))
        }
        (
            ProtocolKind::AnytlsReality { server_name },
            ProtocolSecret::AnytlsReality {
                name,
                password,
                private_key,
                public_key,
                short_id,
            },
        ) => {
            let tls = reality_tls(server_name, private_key, short_id);
            let mut inbound = base();
            merge(
                &mut inbound,
                json!({ "type": "anytls", "users": [{ "name": name, "password": password }], "padding_scheme": [], "tls": tls }),
            );
            Ok((
                inbound,
                reality_metadata(server_name, public_key, short_id),
                json!({ "users": [{ "name": name, "password": password }] }),
                "anytls",
            ))
        }
        (ProtocolKind::VmessWs { path, host }, ProtocolSecret::VmessWs { uuid }) => {
            let mut transport = json!({ "type": "ws", "path": path });
            if let Some(host) = host {
                transport["headers"] = json!({ "Host": host });
            }
            let mut inbound = base();
            merge(
                &mut inbound,
                json!({ "type": "vmess", "users": [{ "uuid": uuid, "alterId": 0 }], "transport": transport }),
            );
            let mut public_transport = json!({ "type": "ws", "path": path });
            if let Some(host) = host {
                public_transport["host"] = json!(host);
            }
            Ok((
                inbound,
                json!({ "direction": "inbound", "transport": public_transport }),
                json!({ "users": [{ "uuid": uuid }] }),
                "vmess",
            ))
        }
        _ => bail!("secret type does not match protocol {}", protocol.tag),
    }
}

fn certificate_tls(server_name: &str, certificate: &Path, key: &Path, h3: bool) -> Value {
    let mut tls = json!({ "enabled": true, "server_name": server_name,
        "certificate_path": certificate.to_string_lossy(), "key_path": key.to_string_lossy() });
    if h3 {
        tls["alpn"] = json!(["h3"]);
    }
    tls
}

fn reality_tls(server_name: &str, private_key: &str, short_id: &str) -> Value {
    json!({ "enabled": true, "server_name": server_name, "reality": { "enabled": true,
        "handshake": { "server": server_name, "server_port": 443 }, "private_key": private_key, "short_id": [short_id] } })
}

fn tls_metadata(server_name: &str, insecure: bool, alpn: Option<Vec<&str>>) -> Value {
    json!({ "direction": "inbound", "tls": { "enabled": true, "serverName": server_name,
        "insecure": insecure, "alpn": alpn.unwrap_or_default() } })
}

fn reality_metadata(server_name: &str, public_key: &str, short_id: &str) -> Value {
    json!({ "direction": "inbound", "tls": { "enabled": true, "serverName": server_name,
        "reality": { "enabled": true, "publicKey": public_key, "shortId": short_id } } })
}

fn merge(target: &mut Value, extra: Value) {
    target
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
}

fn endpoint(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SingBoxSettings;
    use std::collections::BTreeMap;
    use tempfile::tempdir;

    #[test]
    fn renders_all_supported_protocols_without_exposing_private_reality_keys() {
        let directory = tempdir().unwrap();
        let kinds = vec![
            ProtocolKind::Shadowsocks {
                method: "2022-blake3-aes-128-gcm".into(),
            },
            ProtocolKind::Hysteria2 {
                server_name: "www.bing.com".into(),
                certificate_path: None,
                key_path: None,
            },
            ProtocolKind::Tuic {
                server_name: "www.bing.com".into(),
                congestion_control: "bbr".into(),
                certificate_path: None,
                key_path: None,
            },
            ProtocolKind::VlessReality {
                server_name: "addons.mozilla.org".into(),
            },
            ProtocolKind::AnytlsReality {
                server_name: "addons.mozilla.org".into(),
            },
            ProtocolKind::VmessWs {
                path: "/vmess".into(),
                host: Some("cdn.example.com".into()),
            },
        ];
        let protocols = kinds
            .into_iter()
            .enumerate()
            .map(|(index, kind)| ProtocolSpec {
                tag: format!("p{index}"),
                listen: "::".into(),
                port: 20000 + index as u16,
                kind,
            })
            .collect();
        let config = Config {
            server_url: "https://example.com".into(),
            enrollment_token: None,
            report_interval_seconds: 60,
            labels: BTreeMap::new(),
            public_host: Some("proxy.example.com".into()),
            runtime_path: directory
                .path()
                .join("runtime.json")
                .to_string_lossy()
                .into(),
            protocols,
            sing_box: SingBoxSettings {
                binary_path: "/bin/true".into(),
                managed_config_path: directory
                    .path()
                    .join("config.json")
                    .to_string_lossy()
                    .into(),
                secrets_path: directory
                    .path()
                    .join("secrets.json")
                    .to_string_lossy()
                    .into(),
                certificates_directory: directory.path().join("certs").to_string_lossy().into(),
                working_directory: None,
                restart_delay_seconds: 1,
                shutdown_timeout_seconds: 1,
            },
        };
        let mut secrets = SecretStore::default();
        secrets.reconcile(&config).unwrap();
        let rendered = render(&config, &secrets, "healthy").unwrap();
        assert_eq!(rendered.tunnels.len(), 6);
        assert_eq!(
            serde_json::from_slice::<Value>(&rendered.bytes).unwrap()["inbounds"]
                .as_array()
                .unwrap()
                .len(),
            6
        );
        for tunnel in &rendered.tunnels {
            assert!(!tunnel.metadata.to_string().contains("private_key"));
        }
        let links = crate::links::links(&rendered.tunnels).unwrap();
        for scheme in [
            "ss://",
            "hysteria2://",
            "tuic://",
            "vless://",
            "anytls://",
            "vmess://",
        ] {
            assert!(
                links.iter().any(|link| link.starts_with(scheme)),
                "missing {scheme}"
            );
        }
    }
}
