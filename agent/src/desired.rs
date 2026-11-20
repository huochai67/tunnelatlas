use std::{collections::HashSet, net::IpAddr, str::FromStr};

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesiredConfig {
    pub version: u64,
    pub tunnels: Vec<DesiredTunnel>,
}

impl DesiredConfig {
    pub fn validate(&self) -> Result<()> {
        if self.tunnels.len() > 64 {
            bail!("desired config contains more than 64 tunnels");
        }
        let mut ids = HashSet::new();
        let mut names = HashSet::new();
        let mut ports = HashSet::new();
        let mut hop_tags = HashSet::new();
        for tunnel in &self.tunnels {
            tunnel.validate()?;
            if !ids.insert(tunnel.id()) {
                bail!("duplicate tunnel id: {}", tunnel.id());
            }
            if !names.insert(tunnel.name()) {
                bail!("duplicate tunnel name: {}", tunnel.name());
            }
            if !ports.insert(tunnel.port()) {
                bail!("duplicate tunnel port: {}", tunnel.port());
            }
            if tunnel.hops().len() > 3 {
                bail!("tunnel {} has more than 3 hops", tunnel.id());
            }
            for hop in tunnel.hops() {
                if !hop_tags.insert(hop.tag.as_str()) {
                    bail!("duplicate hop tag: {}", hop.tag);
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TunnelCredentials {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HopTls {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub insecure: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alpn: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reality: Option<HopReality>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HopReality {
    pub public_key: String,
    pub short_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HopTransport {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesiredHop {
    pub node_id: String,
    pub tunnel_id: String,
    pub tag: String,
    #[serde(rename = "type")]
    pub protocol: String,
    #[serde(default = "hop_ready")]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub flow: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub congestion_control: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tls: Option<HopTls>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transport: Option<HopTransport>,
}

fn hop_ready() -> String {
    "ready".to_owned()
}

impl DesiredHop {
    pub fn is_ready(&self) -> bool {
        self.status == "ready"
            && self.server.as_deref().is_some_and(|s| !s.is_empty())
            && self.port.is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum DesiredTunnel {
    #[serde(rename_all = "camelCase")]
    Shadowsocks {
        id: String,
        name: String,
        #[serde(default = "default_listen")]
        listen: String,
        port: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        public_host: Option<String>,
        #[serde(default = "default_cred_gen")]
        credential_generation: u64,
        #[serde(default = "default_ss_method")]
        method: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        credentials: Option<TunnelCredentials>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        hops: Vec<DesiredHop>,
    },
    #[serde(rename_all = "camelCase")]
    Hysteria2 {
        id: String,
        name: String,
        #[serde(default = "default_listen")]
        listen: String,
        port: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        public_host: Option<String>,
        #[serde(default = "default_cred_gen")]
        credential_generation: u64,
        #[serde(default = "default_tls_name")]
        server_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        credentials: Option<TunnelCredentials>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        hops: Vec<DesiredHop>,
    },
    #[serde(rename_all = "camelCase")]
    Tuic {
        id: String,
        name: String,
        #[serde(default = "default_listen")]
        listen: String,
        port: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        public_host: Option<String>,
        #[serde(default = "default_cred_gen")]
        credential_generation: u64,
        #[serde(default = "default_tls_name")]
        server_name: String,
        #[serde(default = "default_congestion_control")]
        congestion_control: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        credentials: Option<TunnelCredentials>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        hops: Vec<DesiredHop>,
    },
    #[serde(rename_all = "camelCase")]
    VlessReality {
        id: String,
        name: String,
        #[serde(default = "default_listen")]
        listen: String,
        port: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        public_host: Option<String>,
        #[serde(default = "default_cred_gen")]
        credential_generation: u64,
        #[serde(default = "default_reality_name")]
        server_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        credentials: Option<TunnelCredentials>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        hops: Vec<DesiredHop>,
    },
    #[serde(rename_all = "camelCase")]
    AnytlsReality {
        id: String,
        name: String,
        #[serde(default = "default_listen")]
        listen: String,
        port: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        public_host: Option<String>,
        #[serde(default = "default_cred_gen")]
        credential_generation: u64,
        #[serde(default = "default_reality_name")]
        server_name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        credentials: Option<TunnelCredentials>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        hops: Vec<DesiredHop>,
    },
    #[serde(rename_all = "camelCase")]
    VmessWs {
        id: String,
        name: String,
        #[serde(default = "default_listen")]
        listen: String,
        port: u16,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        public_host: Option<String>,
        #[serde(default = "default_cred_gen")]
        credential_generation: u64,
        #[serde(default = "default_ws_path")]
        path: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        host: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        credentials: Option<TunnelCredentials>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        hops: Vec<DesiredHop>,
    },
}

fn default_listen() -> String {
    "::".to_owned()
}
fn default_cred_gen() -> u64 {
    1
}

impl DesiredTunnel {
    pub fn id(&self) -> &str {
        match self {
            Self::Shadowsocks { id, .. }
            | Self::Hysteria2 { id, .. }
            | Self::Tuic { id, .. }
            | Self::VlessReality { id, .. }
            | Self::AnytlsReality { id, .. }
            | Self::VmessWs { id, .. } => id,
        }
    }

    pub fn name(&self) -> &str {
        match self {
            Self::Shadowsocks { name, .. }
            | Self::Hysteria2 { name, .. }
            | Self::Tuic { name, .. }
            | Self::VlessReality { name, .. }
            | Self::AnytlsReality { name, .. }
            | Self::VmessWs { name, .. } => name,
        }
    }

    pub fn listen(&self) -> &str {
        match self {
            Self::Shadowsocks { listen, .. }
            | Self::Hysteria2 { listen, .. }
            | Self::Tuic { listen, .. }
            | Self::VlessReality { listen, .. }
            | Self::AnytlsReality { listen, .. }
            | Self::VmessWs { listen, .. } => listen,
        }
    }

    pub fn port(&self) -> u16 {
        match self {
            Self::Shadowsocks { port, .. }
            | Self::Hysteria2 { port, .. }
            | Self::Tuic { port, .. }
            | Self::VlessReality { port, .. }
            | Self::AnytlsReality { port, .. }
            | Self::VmessWs { port, .. } => *port,
        }
    }

    pub fn public_host(&self) -> Option<&str> {
        match self {
            Self::Shadowsocks { public_host, .. }
            | Self::Hysteria2 { public_host, .. }
            | Self::Tuic { public_host, .. }
            | Self::VlessReality { public_host, .. }
            | Self::AnytlsReality { public_host, .. }
            | Self::VmessWs { public_host, .. } => public_host.as_deref(),
        }
    }

    pub fn credential_generation(&self) -> u64 {
        match self {
            Self::Shadowsocks {
                credential_generation,
                ..
            }
            | Self::Hysteria2 {
                credential_generation,
                ..
            }
            | Self::Tuic {
                credential_generation,
                ..
            }
            | Self::VlessReality {
                credential_generation,
                ..
            }
            | Self::AnytlsReality {
                credential_generation,
                ..
            }
            | Self::VmessWs {
                credential_generation,
                ..
            } => *credential_generation,
        }
    }

    pub fn credentials(&self) -> Option<&TunnelCredentials> {
        match self {
            Self::Shadowsocks { credentials, .. }
            | Self::Hysteria2 { credentials, .. }
            | Self::Tuic { credentials, .. }
            | Self::VlessReality { credentials, .. }
            | Self::AnytlsReality { credentials, .. }
            | Self::VmessWs { credentials, .. } => credentials.as_ref(),
        }
    }

    pub fn hops(&self) -> &[DesiredHop] {
        match self {
            Self::Shadowsocks { hops, .. }
            | Self::Hysteria2 { hops, .. }
            | Self::Tuic { hops, .. }
            | Self::VlessReality { hops, .. }
            | Self::AnytlsReality { hops, .. }
            | Self::VmessWs { hops, .. } => hops,
        }
    }

    pub fn protocol_type(&self) -> &'static str {
        match self {
            Self::Shadowsocks { .. } => "shadowsocks",
            Self::Hysteria2 { .. } => "hysteria2",
            Self::Tuic { .. } => "tuic",
            Self::VlessReality { .. } => "vless-reality",
            Self::AnytlsReality { .. } => "anytls-reality",
            Self::VmessWs { .. } => "vmess-ws",
        }
    }

    pub fn validate(&self) -> Result<()> {
        let name = self.name();
        if name.is_empty()
            || name.len() > 64
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            bail!("invalid tunnel name: {name}");
        }

        let port = self.port();
        if port == 0 {
            bail!("invalid tunnel port: {port}");
        }

        let listen_raw = self.listen().trim();
        let listen = if listen_raw.starts_with('[') && listen_raw.ends_with(']') {
            &listen_raw[1..listen_raw.len() - 1]
        } else {
            listen_raw
        };
        if IpAddr::from_str(listen).is_err() {
            bail!("invalid listen IP address: {listen}");
        }

        if let Some(host) = self.public_host()
            && !valid_public_host(host)
        {
            bail!("invalid public host: {}", host.trim());
        }

        if let Some(credentials) = self.credentials() {
            self.validate_credentials(credentials)?;
        }

        match self {
            Self::Shadowsocks { method, .. } => {
                if !matches!(
                    method.as_str(),
                    "2022-blake3-aes-128-gcm"
                        | "2022-blake3-aes-256-gcm"
                        | "2022-blake3-chacha20-poly1305"
                ) {
                    bail!("invalid shadowsocks method: {method}");
                }
            }
            Self::Hysteria2 { server_name, .. } => {
                if !valid_server_name(server_name) {
                    bail!("invalid hysteria2 server name: {server_name}");
                }
            }
            Self::Tuic {
                server_name,
                congestion_control,
                ..
            } => {
                if !valid_server_name(server_name) {
                    bail!("invalid tuic server name: {server_name}");
                }
                if !matches!(congestion_control.as_str(), "bbr" | "cubic" | "new_reno") {
                    bail!("invalid tuic congestion control: {congestion_control}");
                }
            }
            Self::VlessReality { server_name, .. } => {
                if !valid_server_name(server_name) {
                    bail!("invalid vless reality server name: {server_name}");
                }
            }
            Self::AnytlsReality { server_name, .. } => {
                if !valid_server_name(server_name) {
                    bail!("invalid anytls reality server name: {server_name}");
                }
            }
            Self::VmessWs { path, host, .. } => {
                let p = path.trim();
                if !p.starts_with('/') || p.chars().any(|c| c.is_whitespace() || c.is_control()) {
                    bail!("invalid vmess path: {path}");
                }
                if let Some(h) = host.as_deref() {
                    let h = h.trim();
                    if h.is_empty()
                        || h.contains(':')
                        || h.contains('/')
                        || h.chars().any(char::is_whitespace)
                    {
                        bail!("invalid vmess host: {h}");
                    }
                }
            }
        }
        Ok(())
    }

    fn validate_credentials(&self, credentials: &TunnelCredentials) -> Result<()> {
        match self {
            Self::Shadowsocks { .. } | Self::Hysteria2 { .. } => {
                if credentials
                    .password
                    .as_deref()
                    .is_none_or(|value| value.is_empty())
                {
                    bail!("missing password for tunnel {}", self.id());
                }
            }
            Self::Tuic { .. } => {
                if credentials
                    .uuid
                    .as_deref()
                    .is_none_or(|value| value.is_empty())
                    || credentials
                        .password
                        .as_deref()
                        .is_none_or(|value| value.is_empty())
                {
                    bail!("missing tuic credentials for tunnel {}", self.id());
                }
            }
            Self::VlessReality { .. } => {
                if credentials
                    .uuid
                    .as_deref()
                    .is_none_or(|value| value.is_empty())
                    || credentials
                        .private_key
                        .as_deref()
                        .is_none_or(|value| value.is_empty())
                    || credentials
                        .public_key
                        .as_deref()
                        .is_none_or(|value| value.is_empty())
                    || credentials
                        .short_id
                        .as_deref()
                        .is_none_or(|value| value.is_empty())
                {
                    bail!("missing vless reality credentials for tunnel {}", self.id());
                }
            }
            Self::AnytlsReality { .. } => {
                if credentials
                    .password
                    .as_deref()
                    .is_none_or(|value| value.is_empty())
                    || credentials
                        .private_key
                        .as_deref()
                        .is_none_or(|value| value.is_empty())
                    || credentials
                        .public_key
                        .as_deref()
                        .is_none_or(|value| value.is_empty())
                    || credentials
                        .short_id
                        .as_deref()
                        .is_none_or(|value| value.is_empty())
                {
                    bail!(
                        "missing anytls reality credentials for tunnel {}",
                        self.id()
                    );
                }
            }
            Self::VmessWs { .. } => {
                if credentials
                    .uuid
                    .as_deref()
                    .is_none_or(|value| value.is_empty())
                {
                    bail!("missing vmess uuid for tunnel {}", self.id());
                }
            }
        }
        Ok(())
    }
}

fn valid_public_host(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.len() > 253 {
        return false;
    }
    if trimmed.starts_with('[') || trimmed.ends_with(']') {
        if !(trimmed.starts_with('[') && trimmed.ends_with(']')) {
            return false;
        }
        return IpAddr::from_str(&trimmed[1..trimmed.len() - 1]).is_ok_and(|addr| addr.is_ipv6());
    }
    if IpAddr::from_str(trimmed).is_ok() {
        return true;
    }
    !(trimmed.contains(':')
        || trimmed.contains('/')
        || trimmed.contains('*')
        || trimmed.chars().any(|c| c.is_whitespace() || c.is_control()))
}

fn valid_server_name(value: &str) -> bool {
    if value.is_empty() || value.len() > 253 {
        return false;
    }
    let labels: Vec<&str> = value.split('.').collect();
    if labels.len() <= 4
        && labels
            .iter()
            .all(|label| !label.is_empty() && label.bytes().all(|b| b.is_ascii_digit()))
    {
        return false;
    }
    labels.iter().all(|label| {
        (1..=63).contains(&label.len())
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    })
}

#[cfg(test)]
mod tests {
    use super::DesiredTunnel;

    fn sample_tunnel(kind: &str, server_name: &str) -> DesiredTunnel {
        let base = serde_json::json!({
            "id": "tunnel_1",
            "name": "edge-in",
            "type": kind,
            "listen": "::",
            "port": 8443,
            "serverName": server_name
        });
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn validates_strict_server_name_hostnames() {
        for kind in ["hysteria2", "tuic", "vless-reality", "anytls-reality"] {
            assert!(sample_tunnel(kind, "www.bing.com").validate().is_ok());
            assert!(
                sample_tunnel(kind, "sub-1.a2.example.org")
                    .validate()
                    .is_ok()
            );
        }

        let too_long = format!("{}.com", vec!["aaaa"; 51].join("."));
        assert!(too_long.len() > 253);
        let label_too_long = format!("{}.com", "a".repeat(64));

        for invalid in [
            "",
            "   ",
            "www .bing.com",
            " www.bing.com",
            "https://www.bing.com",
            "www.bing.com/path",
            "www.bing.com:443",
            "1.2.3.4",
            "192.168.1.1",
            "::1",
            "[::1]",
            "bad_host.example.com",
            "-bad.example.com",
            "bad-.example.com",
            "www.bing.com.",
            "a..b.com",
            &too_long,
            &label_too_long,
        ] {
            for kind in ["hysteria2", "tuic", "vless-reality", "anytls-reality"] {
                assert!(
                    sample_tunnel(kind, invalid).validate().is_err(),
                    "expected {kind} to reject serverName {invalid:?}"
                );
            }
        }
    }

    #[test]
    fn validates_ipv4_ipv6_and_domain_public_hosts() {
        let with_host = |host: &str| -> DesiredTunnel {
            serde_json::from_value(serde_json::json!({
                "id": "tunnel_1",
                "name": "edge-in",
                "type": "shadowsocks",
                "listen": "::",
                "port": 8388,
                "publicHost": host,
                "method": "2022-blake3-aes-128-gcm"
            }))
            .unwrap()
        };

        for valid in [
            "203.0.113.8",
            "2001:db8::8",
            "[2001:db8::8]",
            "edge.example.com",
        ] {
            assert!(
                with_host(valid).validate().is_ok(),
                "expected publicHost {valid:?} to be valid"
            );
        }

        for invalid in [
            "",
            "   ",
            "203.0.113.8:8388",
            "[203.0.113.8]",
            "[2001:db8::8]:8388",
            "2001:db8:::8",
            "*.example.com",
            "edge.example.com/path",
        ] {
            assert!(
                with_host(invalid).validate().is_err(),
                "expected publicHost {invalid:?} to be rejected"
            );
        }
    }
}
