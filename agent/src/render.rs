use std::{collections::HashSet, fs, net::IpAddr, path::Path, str::FromStr};

use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};

use crate::{
    desired::{DesiredHop, DesiredTunnel},
    secrets::{ProtocolSecret, SecretStore, desired_certificate_paths},
    sing_box::ObservedTunnel,
};

pub struct RenderedConfig {
    pub bytes: Vec<u8>,
    pub tunnels: Vec<ObservedTunnel>,
}

pub fn validate_extra_config(path: &Path) -> Result<()> {
    LocalOverlay::load(path).map(|_| ())
}

pub fn render_desired(
    tunnels: &[DesiredTunnel],
    secrets: &SecretStore,
    certificates_dir: &Path,
    observed_address: Option<&str>,
    status: &str,
) -> Result<RenderedConfig> {
    render_desired_with_overlay(
        tunnels,
        secrets,
        certificates_dir,
        observed_address,
        status,
        None,
    )
}

pub fn render_desired_with_overlay(
    tunnels: &[DesiredTunnel],
    secrets: &SecretStore,
    certificates_dir: &Path,
    observed_address: Option<&str>,
    status: &str,
    extra_config_path: Option<&Path>,
) -> Result<RenderedConfig> {
    let overlay = extra_config_path.map(LocalOverlay::load).transpose()?;
    let mut inbounds = Vec::new();
    let mut observed_tunnels = Vec::new();
    let mut outbounds = vec![json!({ "type": "direct", "tag": "direct" })];
    let mut route_rules = Vec::new();
    let mut needs_block = overlay.as_ref().is_some_and(|extra| extra.needs_block);

    for tunnel in tunnels {
        let secret = secrets.get_desired(tunnel)?;
        let (inbound, metadata, authentication, reported_protocol) =
            render_desired_tunnel(tunnel, secret, certificates_dir)?;
        inbounds.push(inbound);

        let hops = tunnel.hops();
        let mut tunnel_status = status.to_owned();
        if !hops.is_empty() {
            if hops.iter().any(|hop| !hop.is_ready()) {
                needs_block = true;
                tunnel_status = "degraded".to_owned();
                route_rules.push(json!({
                    "inbound": [tunnel.name()],
                    "action": "route",
                    "outbound": "block"
                }));
            } else {
                let mut previous: Option<&str> = None;
                for hop in hops {
                    let mut outbound = render_hop_outbound(hop)?;
                    if let Some(detour) = previous {
                        outbound["detour"] = json!(detour);
                    }
                    previous = Some(hop.tag.as_str());
                    outbounds.push(outbound);
                }
                if let Some(last) = hops.last() {
                    route_rules.push(json!({
                        "inbound": [tunnel.name()],
                        "action": "route",
                        "outbound": last.tag
                    }));
                }
            }
        }

        let host = select_reported_host(tunnel.public_host(), tunnel.listen(), observed_address);
        let endpoint = format_endpoint(host, tunnel.port());
        observed_tunnels.push(ObservedTunnel {
            id: tunnel.id().to_owned(),
            name: tunnel.name().to_owned(),
            kind: "sing-box/inbound".to_owned(),
            endpoint,
            protocol: reported_protocol.to_owned(),
            status: tunnel_status,
            metadata,
            authentication,
        });
    }

    if needs_block {
        outbounds.push(json!({ "type": "block", "tag": "block" }));
    }

    let mut document = json!({
        "log": { "level": "info", "timestamp": true },
        "inbounds": inbounds,
        "outbounds": outbounds
    });
    if let Some(extra) = overlay {
        apply_overlay(&mut document, route_rules, extra);
    } else if !route_rules.is_empty() {
        document["route"] = json!({
            "rules": route_rules,
            "final": "direct"
        });
    }
    Ok(RenderedConfig {
        bytes: serde_json::to_vec_pretty(&document)?,
        tunnels: observed_tunnels,
    })
}

struct LocalOverlay {
    outbounds: Vec<Value>,
    endpoints: Vec<Value>,
    route: Option<Map<String, Value>>,
    dns: Option<Value>,
    experimental: Option<Value>,
    needs_block: bool,
}

impl LocalOverlay {
    fn load(path: &Path) -> Result<Self> {
        let bytes = fs::read(path)
            .with_context(|| format!("failed to read extra sing-box config {}", path.display()))?;
        let root: Value = serde_json::from_slice(&bytes)
            .with_context(|| format!("invalid JSON in extra sing-box config {}", path.display()))?;
        let Value::Object(mut obj) = root else {
            bail!("extra sing-box config root must be a JSON object");
        };

        if obj.contains_key("inbounds") {
            bail!(
                "extra sing-box config cannot define 'inbounds'; inbounds are managed by TunnelAtlas"
            );
        }
        for key in obj.keys() {
            if !matches!(
                key.as_str(),
                "outbounds" | "endpoints" | "route" | "dns" | "experimental"
            ) {
                bail!(
                    "unsupported top-level key '{key}' in extra sing-box config; allowed keys are: outbounds, endpoints, route, dns, experimental"
                );
            }
        }

        let mut extra_tags = HashSet::new();
        let outbounds = match obj.remove("outbounds") {
            Some(value) => parse_tagged_entries(value, "outbounds", &mut extra_tags)?,
            None => Vec::new(),
        };
        let endpoints = match obj.remove("endpoints") {
            Some(value) => parse_tagged_entries(value, "endpoints", &mut extra_tags)?,
            None => Vec::new(),
        };

        let mut needs_block = false;
        let route = match obj.remove("route") {
            Some(Value::Object(route_map)) => {
                needs_block = validate_extra_route(&route_map, &extra_tags)?;
                Some(route_map)
            }
            Some(_) => bail!("extra sing-box config 'route' must be a JSON object"),
            None => None,
        };

        let dns = match obj.remove("dns") {
            Some(value @ Value::Object(_)) => Some(value),
            Some(_) => bail!("extra sing-box config 'dns' must be a JSON object"),
            None => None,
        };
        let experimental = match obj.remove("experimental") {
            Some(value @ Value::Object(_)) => Some(value),
            Some(_) => bail!("extra sing-box config 'experimental' must be a JSON object"),
            None => None,
        };

        Ok(Self {
            outbounds,
            endpoints,
            route,
            dns,
            experimental,
            needs_block,
        })
    }
}

fn parse_tagged_entries(
    value: Value,
    section: &str,
    seen_tags: &mut HashSet<String>,
) -> Result<Vec<Value>> {
    let Value::Array(items) = value else {
        bail!("extra sing-box config '{section}' must be a JSON array");
    };
    for item in &items {
        let Some(map) = item.as_object() else {
            bail!("each entry in extra sing-box config '{section}' must be a JSON object");
        };
        if map
            .get("type")
            .and_then(Value::as_str)
            .is_none_or(str::is_empty)
        {
            bail!("each entry in extra sing-box config '{section}' must have a non-empty 'type'");
        }
        let Some(tag) = map.get("tag").and_then(Value::as_str) else {
            bail!("each entry in extra sing-box config '{section}' must have a non-empty 'tag'");
        };
        if tag.is_empty() {
            bail!("each entry in extra sing-box config '{section}' must have a non-empty 'tag'");
        }
        if tag == "direct" || tag == "block" || tag.starts_with("hop-") {
            bail!("extra tag '{tag}' is reserved by TunnelAtlas");
        }
        if !seen_tags.insert(tag.to_owned()) {
            bail!("duplicate tag '{tag}' in extra sing-box config");
        }
    }
    Ok(items)
}

fn validate_extra_route(
    route_map: &Map<String, Value>,
    extra_tags: &HashSet<String>,
) -> Result<bool> {
    let mut needs_block = false;
    if let Some(rules_val) = route_map.get("rules") {
        let Some(rules) = rules_val.as_array() else {
            bail!("extra route.rules must be a JSON array");
        };
        for rule in rules {
            let Some(rule_obj) = rule.as_object() else {
                bail!("each entry in extra route.rules must be a JSON object");
            };
            if rule_obj.get("outbound").and_then(Value::as_str) == Some("block") {
                needs_block = true;
            }
        }
    }
    if let Some(rule_sets_val) = route_map.get("rule_set") {
        let Some(rule_sets) = rule_sets_val.as_array() else {
            bail!("extra route.rule_set must be a JSON array");
        };
        let mut seen_rule_sets = HashSet::new();
        for rule_set in rule_sets {
            let Some(rs_obj) = rule_set.as_object() else {
                bail!("each entry in extra route.rule_set must be a JSON object");
            };
            let Some(tag) = rs_obj.get("tag").and_then(Value::as_str) else {
                bail!("each entry in extra route.rule_set must have a non-empty 'tag'");
            };
            if tag.is_empty() {
                bail!("each entry in extra route.rule_set must have a non-empty 'tag'");
            }
            if !seen_rule_sets.insert(tag.to_owned()) {
                bail!("duplicate rule_set tag '{tag}' in extra sing-box config");
            }
        }
    }
    if let Some(final_val) = route_map.get("final") {
        let Some(final_tag) = final_val.as_str().filter(|s| !s.is_empty()) else {
            bail!("extra route.final must be a non-empty string");
        };
        if final_tag == "block" {
            needs_block = true;
        }
        if final_tag != "direct" && final_tag != "block" && !extra_tags.contains(final_tag) {
            bail!("extra route.final references unknown outbound '{final_tag}'");
        }
    }
    Ok(needs_block)
}

fn apply_overlay(document: &mut Value, mut route_rules: Vec<Value>, extra: LocalOverlay) {
    if let Some(Value::Array(outbounds)) = document.get_mut("outbounds") {
        outbounds.extend(extra.outbounds);
    }
    if !extra.endpoints.is_empty() {
        document["endpoints"] = Value::Array(extra.endpoints);
    }
    if let Some(mut route_map) = extra.route {
        if let Some(Value::Array(extra_rules)) = route_map.remove("rules") {
            route_rules.extend(extra_rules);
        }
        if !route_rules.is_empty() {
            route_map.insert("rules".to_owned(), Value::Array(route_rules));
        }
        if !route_map.contains_key("final") {
            route_map.insert("final".to_owned(), json!("direct"));
        }
        document["route"] = Value::Object(route_map);
    } else if !route_rules.is_empty() {
        document["route"] = json!({
            "rules": route_rules,
            "final": "direct"
        });
    }
    if let Some(dns) = extra.dns {
        document["dns"] = dns;
    }
    if let Some(experimental) = extra.experimental {
        document["experimental"] = experimental;
    }
}

fn strip_brackets(host: &str) -> &str {
    let trimmed = host.trim();
    trimmed
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(trimmed)
}

fn select_reported_host<'a>(
    public_host: Option<&'a str>,
    listen: &'a str,
    observed_address: Option<&'a str>,
) -> &'a str {
    if let Some(host) = public_host {
        let bare = strip_brackets(host);
        if !bare.is_empty() {
            return bare;
        }
    }
    let listen_bare = strip_brackets(listen);
    let observed_bare = observed_address
        .map(strip_brackets)
        .filter(|value| !value.is_empty());
    if listen_bare == "::" {
        return observed_bare.unwrap_or(listen_bare);
    }
    if let Ok(listen_ip) = IpAddr::from_str(listen_bare) {
        if let Some(observed) = observed_bare
            && let Ok(observed_ip) = IpAddr::from_str(observed)
            && observed_ip.is_ipv6() == listen_ip.is_ipv6()
        {
            return observed;
        }
        return listen_bare;
    }
    observed_bare.unwrap_or(listen_bare)
}

pub fn format_endpoint(host: &str, port: u16) -> String {
    let host = strip_brackets(host);
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn render_hop_outbound(hop: &DesiredHop) -> Result<Value> {
    let server = hop
        .server
        .as_deref()
        .filter(|value| !value.is_empty())
        .with_context(|| format!("hop {} is missing a server", hop.tag))?;
    let port = hop
        .port
        .context(format!("hop {} is missing a port", hop.tag))?;
    let mut outbound = json!({
        "tag": hop.tag,
        "server": server,
        "server_port": port,
    });
    match hop.protocol.as_str() {
        "shadowsocks" => {
            merge(
                &mut outbound,
                json!({
                    "type": "shadowsocks",
                    "method": hop.method.as_deref().unwrap_or("2022-blake3-aes-128-gcm"),
                    "password": hop.password.as_deref().unwrap_or_default(),
                }),
            );
        }
        "hysteria2" => {
            merge(
                &mut outbound,
                json!({
                    "type": "hysteria2",
                    "password": hop.password.as_deref().unwrap_or_default(),
                    "tls": hop_tls(hop, true),
                }),
            );
        }
        "tuic" => {
            merge(
                &mut outbound,
                json!({
                    "type": "tuic",
                    "uuid": hop.uuid.as_deref().unwrap_or_default(),
                    "password": hop.password.as_deref().unwrap_or_default(),
                    "congestion_control": hop.congestion_control.as_deref().unwrap_or("bbr"),
                    "tls": hop_tls(hop, true),
                }),
            );
        }
        "vless-reality" => {
            merge(
                &mut outbound,
                json!({
                    "type": "vless",
                    "uuid": hop.uuid.as_deref().unwrap_or_default(),
                    "flow": hop.flow.as_deref().unwrap_or("xtls-rprx-vision"),
                    "network": "tcp",
                    "packet_encoding": "xudp",
                    "tls": hop_tls(hop, false),
                }),
            );
        }
        "anytls-reality" => {
            merge(
                &mut outbound,
                json!({
                    "type": "anytls",
                    "password": hop.password.as_deref().unwrap_or_default(),
                    "tls": hop_tls(hop, false),
                }),
            );
        }
        "vmess-ws" => {
            let mut transport = json!({
                "type": "ws",
                "path": hop.transport.as_ref().and_then(|value| value.path.as_deref()).unwrap_or("/vmess"),
            });
            if let Some(host) = hop
                .transport
                .as_ref()
                .and_then(|value| value.host.as_deref())
            {
                transport["headers"] = json!({ "Host": host });
            }
            let mut extra = json!({
                "type": "vmess",
                "uuid": hop.uuid.as_deref().unwrap_or_default(),
                "alter_id": 0,
                "security": "auto",
                "transport": transport,
            });
            if hop.tls.is_some() {
                extra["tls"] = hop_tls(hop, false);
            }
            merge(&mut outbound, extra);
        }
        other => bail!("unsupported hop type: {other}"),
    }
    Ok(outbound)
}

fn hop_tls(hop: &DesiredHop, h3: bool) -> Value {
    let tls = hop.tls.as_ref();
    let server_name = tls
        .and_then(|value| value.server_name.as_deref())
        .or_else(|| {
            hop.transport
                .as_ref()
                .and_then(|value| value.host.as_deref())
        })
        .unwrap_or(hop.server.as_deref().unwrap_or_default());
    let mut document = json!({
        "enabled": true,
        "server_name": server_name,
        "insecure": tls.and_then(|value| value.insecure).unwrap_or(false),
    });
    if h3 {
        document["alpn"] = json!(
            tls.and_then(|value| value.alpn.clone())
                .unwrap_or_else(|| vec!["h3".to_owned()])
        );
    }
    if let Some(reality) = tls.and_then(|value| value.reality.as_ref()) {
        document["insecure"] = json!(false);
        document["utls"] = json!({
            "enabled": true,
            "fingerprint": "chrome"
        });
        document["reality"] = json!({
            "enabled": true,
            "public_key": reality.public_key,
            "short_id": reality.short_id
        });
    }
    document
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
        "tls": {
            "enabled": true,
            "serverName": server_name,
            "reality": {
                "enabled": true,
                "publicKey": public_key,
                "shortId": short_id
            }
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
    use crate::desired::{HopReality, HopTls};

    #[test]
    fn endpoint_formatting_handles_ipv4_ipv6_and_domain() {
        assert_eq!(format_endpoint("203.0.113.1", 443), "203.0.113.1:443");
        assert_eq!(format_endpoint("::", 8388), "[::]:8388");
        assert_eq!(format_endpoint("[::]", 8388), "[::]:8388");
        assert_eq!(format_endpoint("2001:db8::1", 8388), "[2001:db8::1]:8388");
        assert_eq!(format_endpoint("[2001:db8::1]", 8388), "[2001:db8::1]:8388");
        assert_eq!(format_endpoint("example.com", 443), "example.com:443");
    }

    #[test]
    fn reported_host_respects_listen_address_family() {
        assert_eq!(
            select_reported_host(Some("[2001:db8::1]"), "::", Some("203.0.113.8")),
            "2001:db8::1"
        );
        assert_eq!(
            select_reported_host(None, "::", Some("2001:db8::8")),
            "2001:db8::8"
        );
        assert_eq!(
            select_reported_host(None, "0.0.0.0", Some("2001:db8::8")),
            "0.0.0.0"
        );
        assert_eq!(
            select_reported_host(None, "0.0.0.0", Some("203.0.113.8")),
            "203.0.113.8"
        );
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
                credentials: None,
                hops: vec![],
            },
            DesiredTunnel::Hysteria2 {
                id: "t_hy2".into(),
                name: "hy2".into(),
                listen: "::".into(),
                port: 8443,
                public_host: None,
                credential_generation: 1,
                server_name: "www.bing.com".into(),
                credentials: None,
                hops: vec![],
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
                credentials: None,
                hops: vec![],
            },
            DesiredTunnel::VlessReality {
                id: "t_vless".into(),
                name: "vless".into(),
                listen: "::".into(),
                port: 443,
                public_host: Some("example.com".into()),
                credential_generation: 1,
                server_name: "addons.mozilla.org".into(),
                credentials: None,
                hops: vec![],
            },
            DesiredTunnel::AnytlsReality {
                id: "t_anytls".into(),
                name: "anytls".into(),
                listen: "::".into(),
                port: 444,
                public_host: None,
                credential_generation: 1,
                server_name: "addons.mozilla.org".into(),
                credentials: None,
                hops: vec![],
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
                credentials: None,
                hops: vec![],
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
        assert_eq!(vless_tunnel.metadata["tls"]["enabled"], true);
        assert_eq!(
            vless_tunnel.metadata["tls"]["serverName"],
            "addons.mozilla.org"
        );
        assert_eq!(vless_tunnel.metadata["tls"]["reality"]["enabled"], true);
        assert!(
            vless_tunnel.metadata["tls"]["reality"]["publicKey"]
                .as_str()
                .is_some()
        );
        assert!(
            vless_tunnel.metadata["tls"]["reality"]["shortId"]
                .as_str()
                .is_some()
        );

        // SS endpoint should use observedAddress (203.0.113.8) since public_host is None
        let ss_tunnel = rendered.tunnels.iter().find(|t| t.id == "t_ss").unwrap();
        assert_eq!(ss_tunnel.endpoint, "203.0.113.8:8388");
    }

    #[test]
    fn renders_ready_hops_as_detoured_outbounds() {
        let temp = tempfile::tempdir().unwrap();
        let certs_dir = temp.path().join("certs");
        let tunnels = vec![DesiredTunnel::Shadowsocks {
            id: "t_ss".into(),
            name: "ss".into(),
            listen: "::".into(),
            port: 8388,
            public_host: None,
            credential_generation: 1,
            method: "2022-blake3-aes-128-gcm".into(),
            credentials: None,
            hops: vec![
                DesiredHop {
                    node_id: "node_b".into(),
                    tunnel_id: "t_mid".into(),
                    tag: "hop-t_ss-t_mid".into(),
                    protocol: "shadowsocks".into(),
                    status: "ready".into(),
                    server: Some("203.0.113.10".into()),
                    port: Some(8388),
                    method: Some("2022-blake3-aes-128-gcm".into()),
                    password: Some("password".into()),
                    uuid: None,
                    flow: None,
                    congestion_control: None,
                    tls: None,
                    transport: None,
                },
                DesiredHop {
                    node_id: "node_c".into(),
                    tunnel_id: "t_exit".into(),
                    tag: "hop-t_ss-t_exit".into(),
                    protocol: "vless-reality".into(),
                    status: "ready".into(),
                    server: Some("198.51.100.8".into()),
                    port: Some(443),
                    method: None,
                    password: None,
                    uuid: Some("11111111-1111-1111-1111-111111111111".into()),
                    flow: Some("xtls-rprx-vision".into()),
                    congestion_control: None,
                    tls: Some(HopTls {
                        server_name: Some("addons.mozilla.org".into()),
                        insecure: None,
                        alpn: None,
                        reality: Some(HopReality {
                            public_key: "pubkey".into(),
                            short_id: "abcd".into(),
                        }),
                    }),
                    transport: None,
                },
            ],
        }];
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
        let document: Value = serde_json::from_slice(&rendered.bytes).unwrap();
        let outbounds = document["outbounds"].as_array().unwrap();
        assert_eq!(outbounds[0]["tag"], "direct");
        assert_eq!(outbounds[1]["tag"], "hop-t_ss-t_mid");
        assert!(outbounds[1].get("detour").is_none());
        assert_eq!(outbounds[2]["detour"], "hop-t_ss-t_mid");
        assert_eq!(outbounds[2]["tls"]["utls"]["enabled"], true);
        assert_eq!(outbounds[2]["tls"]["utls"]["fingerprint"], "chrome");
        assert_eq!(document["route"]["rules"][0]["outbound"], "hop-t_ss-t_exit");
        assert_eq!(rendered.tunnels[0].status, "healthy");
    }

    #[test]
    fn deserializes_worker_anytls_hop_payload_and_passes_sing_box_check() {
        let raw = r#"{
            "version": 7,
            "tunnels": [
                {
                    "id": "tunnel_entry",
                    "name": "relay-lax",
                    "type": "anytls-reality",
                    "listen": "::",
                    "port": 19992,
                    "publicHost": null,
                    "credentialGeneration": 1,
                    "serverName": "www.bing.com",
                    "credentials": {
                        "password": "passwordpasswordpasswordpasswor",
                        "privateKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                        "publicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                        "shortId": "0123456789abcdef",
                        "name": "tunnelatlas"
                    },
                    "hops": [
                        {
                            "nodeId": "node_exit",
                            "tunnelId": "tunnel_exit",
                            "tag": "hop-tunnel_entry-tunnel_exit",
                            "status": "ready",
                            "server": "198.51.100.8",
                            "port": 42831,
                            "type": "vless-reality",
                            "uuid": "e57c13b5-3954-40d2-94b8-62c259bf549a",
                            "flow": "xtls-rprx-vision",
                            "tls": {
                                "serverName": "www.bing.com",
                                "reality": {
                                    "publicKey": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                                    "shortId": "0123456789abcdef"
                                }
                            }
                        }
                    ]
                }
            ]
        }"#;
        let desired: crate::desired::DesiredConfig = serde_json::from_str(raw).unwrap();
        desired.validate().unwrap();
        assert_eq!(desired.tunnels[0].hops().len(), 1);
        assert!(desired.tunnels[0].hops()[0].is_ready());

        let temp = tempfile::tempdir().unwrap();
        let certs_dir = temp.path().join("certs");
        let mut secrets = SecretStore::default();
        secrets
            .reconcile_desired(&desired.tunnels, &certs_dir)
            .unwrap();
        let rendered = render_desired(
            &desired.tunnels,
            &secrets,
            &certs_dir,
            Some("203.0.113.8"),
            "healthy",
        )
        .unwrap();
        let document: Value = serde_json::from_slice(&rendered.bytes).unwrap();
        assert_eq!(document["inbounds"][0]["tag"], "relay-lax");
        assert_eq!(
            document["route"]["rules"][0]["outbound"],
            "hop-tunnel_entry-tunnel_exit"
        );
        assert_eq!(
            document["outbounds"][1]["tls"]["utls"]["fingerprint"],
            "chrome"
        );

        let config_path = temp.path().join("sing-box.json");
        std::fs::write(&config_path, &rendered.bytes).unwrap();
        if std::process::Command::new("sing-box")
            .arg("version")
            .output()
            .is_ok()
        {
            let check = std::process::Command::new("sing-box")
                .args(["check", "-c"])
                .arg(&config_path)
                .output()
                .unwrap();
            assert!(
                check.status.success(),
                "sing-box check failed: {}",
                String::from_utf8_lossy(&check.stderr)
            );
        }
    }

    #[test]
    fn merges_extra_overlay_after_hop_rules_and_preserves_example_ai_vless_config() {
        let temp = tempfile::tempdir().unwrap();
        let certs_dir = temp.path().join("certs");
        let overlay_path = temp.path().join("extra.json");
        let mut example: Value =
            serde_json::from_str(include_str!("../extra-config.ai-vless.example.json")).unwrap();
        example["dns"] = json!({ "servers": [{ "tag": "local", "type": "local" }] });
        example["endpoints"] = json!([{ "type": "wireguard", "tag": "wg-local" }]);
        fs::write(&overlay_path, serde_json::to_vec_pretty(&example).unwrap()).unwrap();

        let tunnels = vec![
            DesiredTunnel::Shadowsocks {
                id: "t_hop".into(),
                name: "ss-hop".into(),
                listen: "::".into(),
                port: 8388,
                public_host: None,
                credential_generation: 1,
                method: "2022-blake3-aes-128-gcm".into(),
                credentials: None,
                hops: vec![DesiredHop {
                    node_id: "node_b".into(),
                    tunnel_id: "t_exit".into(),
                    tag: "hop-t_hop-t_exit".into(),
                    protocol: "shadowsocks".into(),
                    status: "ready".into(),
                    server: Some("203.0.113.10".into()),
                    port: Some(8388),
                    method: Some("2022-blake3-aes-128-gcm".into()),
                    password: Some("password".into()),
                    uuid: None,
                    flow: None,
                    congestion_control: None,
                    tls: None,
                    transport: None,
                }],
            },
            DesiredTunnel::Shadowsocks {
                id: "t_direct".into(),
                name: "ss-direct".into(),
                listen: "::".into(),
                port: 8389,
                public_host: None,
                credential_generation: 1,
                method: "2022-blake3-aes-128-gcm".into(),
                credentials: None,
                hops: vec![],
            },
        ];

        let mut secrets = SecretStore::default();
        secrets.reconcile_desired(&tunnels, &certs_dir).unwrap();
        let rendered = render_desired_with_overlay(
            &tunnels,
            &secrets,
            &certs_dir,
            Some("203.0.113.8"),
            "healthy",
            Some(&overlay_path),
        )
        .unwrap();

        let document: Value = serde_json::from_slice(&rendered.bytes).unwrap();
        let outbounds = document["outbounds"].as_array().unwrap();
        assert_eq!(outbounds.len(), 3);
        assert_eq!(outbounds[0]["tag"], "direct");
        assert_eq!(outbounds[1]["tag"], "hop-t_hop-t_exit");
        assert_eq!(outbounds[2]["tag"], "lan-ai-vless");

        assert_eq!(document["endpoints"][0]["tag"], "wg-local");
        assert_eq!(document["dns"]["servers"][0]["tag"], "local");
        assert_eq!(document["experimental"]["cache_file"]["enabled"], true);

        let rules = document["route"]["rules"].as_array().unwrap();
        assert_eq!(rules.len(), 3);
        assert_eq!(rules[0]["outbound"], "hop-t_hop-t_exit");
        assert_eq!(rules[1]["action"], "sniff");
        assert_eq!(rules[2]["outbound"], "lan-ai-vless");
        assert_eq!(
            document["route"]["rule_set"][0]["tag"],
            "geosite-category-ai-!cn"
        );
        assert_eq!(document["route"]["final"], "direct");
    }

    #[test]
    fn emits_block_outbound_when_overlay_route_uses_block() {
        let temp = tempfile::tempdir().unwrap();
        let certs_dir = temp.path().join("certs");
        let overlay_path = temp.path().join("extra.json");
        fs::write(
            &overlay_path,
            br#"{"route":{"rules":[{"ip_is_private":true,"outbound":"block"}]}}"#,
        )
        .unwrap();

        let tunnels = vec![DesiredTunnel::Shadowsocks {
            id: "t_ss".into(),
            name: "ss".into(),
            listen: "::".into(),
            port: 8388,
            public_host: None,
            credential_generation: 1,
            method: "2022-blake3-aes-128-gcm".into(),
            credentials: None,
            hops: vec![],
        }];
        let mut secrets = SecretStore::default();
        secrets.reconcile_desired(&tunnels, &certs_dir).unwrap();
        let rendered = render_desired_with_overlay(
            &tunnels,
            &secrets,
            &certs_dir,
            None,
            "healthy",
            Some(&overlay_path),
        )
        .unwrap();
        let document: Value = serde_json::from_slice(&rendered.bytes).unwrap();
        assert!(
            document["outbounds"]
                .as_array()
                .unwrap()
                .iter()
                .any(|o| o["tag"] == "block")
        );
    }

    #[test]
    fn rejects_invalid_extra_overlay_configs() {
        let temp = tempfile::tempdir().unwrap();
        for (idx, body) in [
            r#"{"inbounds":[{"type":"direct","tag":"x"}]}"#,
            r#"{"log":{"level":"debug"}}"#,
            r#"{"outbound":{"type":"direct","tag":"x"}}"#,
            r#"{"outbounds":[{"type":"vless","tag":"direct"}]}"#,
            r#"{"outbounds":[{"type":"vless","tag":"block"}]}"#,
            r#"{"outbounds":[{"type":"vless","tag":"hop-custom"}]}"#,
            r#"{"outbounds":[{"type":"vless","tag":"dup"}],"endpoints":[{"type":"wireguard","tag":"dup"}]}"#,
            r#"{"outbounds":[{"type":"vless","tag":"lan"}],"route":{"final":"missing"}}"#,
        ]
        .into_iter()
        .enumerate()
        {
            let path = temp.path().join(format!("bad-{idx}.json"));
            fs::write(&path, body).unwrap();
            assert!(
                validate_extra_config(&path).is_err(),
                "expected overlay #{idx} to be rejected: {body}"
            );
        }
    }
}
