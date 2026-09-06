use std::path::Path;

use anyhow::{Result, bail};
use serde_json::{Value, json};

use crate::{
    desired::DesiredTunnel,
    secrets::{ProtocolSecret, SecretStore, desired_certificate_paths},
    sing_box::ObservedTunnel,
};

pub struct RenderedConfig {
    pub bytes: Vec<u8>,
    pub tunnels: Vec<ObservedTunnel>,
}

pub fn render_desired(
    tunnels: &[DesiredTunnel],
    secrets: &SecretStore,
    certificates_dir: &Path,
    observed_address: Option<&str>,
    status: &str,
) -> Result<RenderedConfig> {
    let mut inbounds = Vec::new();
    let mut observed_tunnels = Vec::new();
    for tunnel in tunnels {
        let secret = secrets.get_desired(tunnel)?;
        let (inbound, metadata, authentication, reported_protocol) =
            render_desired_tunnel(tunnel, secret, certificates_dir)?;
        inbounds.push(inbound);
        let host = tunnel
            .public_host()
            .or(observed_address)
            .unwrap_or_else(|| tunnel.listen());
        let endpoint = format_endpoint(host, tunnel.port());
        observed_tunnels.push(ObservedTunnel {
            id: tunnel.id().to_owned(),
            name: tunnel.name().to_owned(),
            kind: "sing-box/inbound".to_owned(),
            endpoint,
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
        tunnels: observed_tunnels,
    })
}

pub fn format_endpoint(host: &str, port: u16) -> String {
    let host = host.trim();
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn render_desired_tunnel(
    tunnel: &DesiredTunnel,
    secret: &ProtocolSecret,
    certificates_dir: &Path,
) -> Result<(Value, Value, Value, &'static str)> {
    let base = || {
        json!({
            "tag": tunnel.name(),
            "listen": tunnel.listen(),
            "listen_port": tunnel.port(),
        })
    };
    match (tunnel, secret) {
        (DesiredTunnel::Shadowsocks { method, .. }, ProtocolSecret::Shadowsocks { password }) => {
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
        (DesiredTunnel::Hysteria2 { server_name, .. }, ProtocolSecret::Hysteria2 { password }) => {
            let (cert, key) = desired_certificate_paths(certificates_dir, tunnel);
            let tls = certificate_tls(server_name, &cert, &key, true);
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
            DesiredTunnel::Tuic {
                server_name,
                congestion_control,
                ..
            },
            ProtocolSecret::Tuic { uuid, password },
        ) => {
            let (cert, key) = desired_certificate_paths(certificates_dir, tunnel);
            let tls = certificate_tls(server_name, &cert, &key, true);
            let mut inbound = base();
            merge(
                &mut inbound,
                json!({
                    "type": "tuic",
                    "users": [{ "uuid": uuid, "password": password }],
                    "congestion_control": congestion_control,
                    "tls": tls,
                }),
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
            DesiredTunnel::VlessReality { server_name, .. },
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
                json!({
                    "type": "vless",
                    "users": [{ "uuid": uuid, "flow": "xtls-rprx-vision" }],
                    "tls": tls,
                }),
            );
            Ok((
                inbound,
                reality_metadata(server_name, public_key, short_id),
                json!({ "users": [{ "uuid": uuid, "flow": "xtls-rprx-vision" }] }),
                "vless",
            ))
        }
        (
            DesiredTunnel::AnytlsReality { server_name, .. },
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
                json!({
                    "type": "anytls",
                    "users": [{ "name": name, "password": password }],
                    "padding_scheme": [],
                    "tls": tls,
                }),
            );
            Ok((
                inbound,
                reality_metadata(server_name, public_key, short_id),
                json!({ "users": [{ "name": name, "password": password }] }),
                "anytls",
            ))
        }
        (DesiredTunnel::VmessWs { path, host, .. }, ProtocolSecret::VmessWs { uuid }) => {
            let mut transport = json!({ "type": "ws", "path": path });
            if let Some(host) = host {
                transport["headers"] = json!({ "Host": host });
            }
            let mut inbound = base();
            merge(
                &mut inbound,
                json!({
                    "type": "vmess",
                    "users": [{ "uuid": uuid, "alterId": 0 }],
                    "transport": transport,
                }),
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
        _ => bail!("secret type does not match desired tunnel {}", tunnel.id()),
    }
}

fn certificate_tls(server_name: &str, certificate: &Path, key: &Path, h3: bool) -> Value {
    let mut tls = json!({
        "enabled": true,
        "server_name": server_name,
        "certificate_path": certificate.to_string_lossy(),
        "key_path": key.to_string_lossy()
    });
    if h3 {
        tls["alpn"] = json!(["h3"]);
    }
    tls
}

fn reality_tls(server_name: &str, private_key: &str, short_id: &str) -> Value {
    json!({
        "enabled": true,
        "server_name": server_name,
        "reality": {
            "enabled": true,
            "handshake": {
                "server": server_name,
                "server_port": 443
            },
            "private_key": private_key,
            "short_id": [short_id]
        }
    })
}

fn tls_metadata(server_name: &str, insecure: bool, alpn: Option<Vec<&str>>) -> Value {
    json!({
        "direction": "inbound",
        "tls": {
            "enabled": true,
            "serverName": server_name,
            "insecure": insecure,
            "alpn": alpn.unwrap_or_default()
        }
    })
}

fn reality_metadata(server_name: &str, public_key: &str, short_id: &str) -> Value {
    json!({
        "direction": "inbound",
        "reality": {
            "enabled": true,
            "serverName": server_name,
            "publicKey": public_key,
            "shortId": short_id
        }
    })
}

fn merge(target: &mut Value, source: Value) {
    if let (Value::Object(target_map), Value::Object(source_map)) = (target, source) {
        for (key, value) in source_map {
            target_map.insert(key, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_formatting_handles_ipv4_ipv6_and_domain() {
        assert_eq!(format_endpoint("203.0.113.1", 443), "203.0.113.1:443");
        assert_eq!(format_endpoint("::", 8388), "[::]:8388");
        assert_eq!(format_endpoint("[::]", 8388), "[::]:8388");
        assert_eq!(format_endpoint("2001:db8::1", 8388), "[2001:db8::1]:8388");
        assert_eq!(format_endpoint("example.com", 443), "example.com:443");
    }

    #[test]
    fn renders_all_six_desired_protocols_without_private_keys_in_auth() {
        let temp = tempfile::tempdir().unwrap();
        let certs_dir = temp.path().join("certs");
        let tunnels = vec![
            DesiredTunnel::Shadowsocks {
                id: "t_ss".into(),
                name: "ss".into(),
                listen: "::".into(),
                port: 8388,
                public_host: None,
                credential_generation: 1,
                method: "2022-blake3-aes-128-gcm".into(),
            },
            DesiredTunnel::Hysteria2 {
                id: "t_hy2".into(),
                name: "hy2".into(),
                listen: "::".into(),
                port: 8443,
                public_host: None,
                credential_generation: 1,
                server_name: "www.bing.com".into(),
            },
            DesiredTunnel::Tuic {
                id: "t_tuic".into(),
                name: "tuic".into(),
                listen: "::".into(),
                port: 8444,
                public_host: None,
                credential_generation: 1,
                server_name: "www.bing.com".into(),
                congestion_control: "bbr".into(),
            },
            DesiredTunnel::VlessReality {
                id: "t_vless".into(),
                name: "vless".into(),
                listen: "::".into(),
                port: 443,
                public_host: Some("example.com".into()),
                credential_generation: 1,
                server_name: "addons.mozilla.org".into(),
            },
            DesiredTunnel::AnytlsReality {
                id: "t_anytls".into(),
                name: "anytls".into(),
                listen: "::".into(),
                port: 444,
                public_host: None,
                credential_generation: 1,
                server_name: "addons.mozilla.org".into(),
            },
            DesiredTunnel::VmessWs {
                id: "t_vmess".into(),
                name: "vmess".into(),
                listen: "::".into(),
                port: 10086,
                public_host: None,
                credential_generation: 1,
                path: "/vmess".into(),
                host: Some("edge.example.com".into()),
            },
        ];

        let mut secrets = SecretStore::default();
        secrets.reconcile_desired(&tunnels, &certs_dir).unwrap();

        let rendered = render_desired(
            &tunnels,
            &secrets,
            &certs_dir,
            Some("203.0.113.8"),
            "healthy",
        )
        .unwrap();
        assert_eq!(rendered.tunnels.len(), 6);

        // VLESS endpoint should use public_host
        let vless_tunnel = rendered.tunnels.iter().find(|t| t.id == "t_vless").unwrap();
        assert_eq!(vless_tunnel.endpoint, "example.com:443");
        // Reality private key must not leak to authentication
        assert!(vless_tunnel.authentication.get("private_key").is_none());
        assert!(vless_tunnel.authentication.get("privateKey").is_none());

        // SS endpoint should use observedAddress (203.0.113.8) since public_host is None
        let ss_tunnel = rendered.tunnels.iter().find(|t| t.id == "t_ss").unwrap();
        assert_eq!(ss_tunnel.endpoint, "203.0.113.8:8388");
    }
}
