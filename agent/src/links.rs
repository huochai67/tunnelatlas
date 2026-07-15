use anyhow::{Context, Result};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde_json::{Value, json};

use crate::sing_box::ObservedTunnel;

pub fn links(tunnels: &[ObservedTunnel]) -> Result<Vec<String>> {
    tunnels.iter().map(link).collect()
}

fn link(tunnel: &ObservedTunnel) -> Result<String> {
    let name = utf8_percent_encode(&tunnel.name, NON_ALPHANUMERIC);
    let auth = &tunnel.authentication;
    let metadata = &tunnel.metadata;
    let users = || {
        auth.get("users")
            .and_then(Value::as_array)
            .and_then(|users| users.first())
            .context("protocol has no generated user")
    };
    match tunnel.protocol.as_str() {
        "shadowsocks" => {
            let method = text(auth, "method")?;
            let password = text(auth, "password")?;
            Ok(format!(
                "ss://{}@{}#{name}",
                URL_SAFE_NO_PAD.encode(format!("{method}:{password}")),
                tunnel.endpoint
            ))
        }
        "vless" => {
            let user = users()?;
            let uuid = text(user, "uuid")?;
            let reality = &metadata["tls"]["reality"];
            Ok(format!(
                "vless://{uuid}@{}?encryption=none&flow=xtls-rprx-vision&security=reality&sni={}&fp=chrome&pbk={}&sid={}#{name}",
                tunnel.endpoint,
                encode(text(&metadata["tls"], "serverName")?),
                encode(text(reality, "publicKey")?),
                encode(text(reality, "shortId")?)
            ))
        }
        "anytls" => {
            let user = users()?;
            let password = encode(text(user, "password")?);
            let reality = &metadata["tls"]["reality"];
            Ok(format!(
                "anytls://{password}@{}/?security=reality&sni={}&fp=chrome&pbk={}&sid={}#{name}",
                tunnel.endpoint,
                encode(text(&metadata["tls"], "serverName")?),
                encode(text(reality, "publicKey")?),
                encode(text(reality, "shortId")?)
            ))
        }
        "hysteria2" => {
            let password = encode(text(users()?, "password")?);
            Ok(format!(
                "hysteria2://{password}@{}/?sni={}&alpn=h3&insecure=1#{name}",
                tunnel.endpoint,
                encode(text(&metadata["tls"], "serverName")?)
            ))
        }
        "tuic" => {
            let user = users()?;
            let uuid = text(user, "uuid")?;
            let password = encode(text(user, "password")?);
            let congestion = metadata
                .get("congestionControl")
                .and_then(Value::as_str)
                .unwrap_or("bbr");
            Ok(format!(
                "tuic://{uuid}:{password}@{}/?congestion_control={}&alpn=h3&sni={}&insecure=1#{name}",
                tunnel.endpoint,
                encode(congestion),
                encode(text(&metadata["tls"], "serverName")?)
            ))
        }
        "vmess" => {
            let user = users()?;
            let transport = &metadata["transport"];
            let endpoint = parse_endpoint(&tunnel.endpoint)?;
            let value = json!({ "v": "2", "ps": tunnel.name, "add": endpoint.0, "port": endpoint.1.to_string(),
                "id": text(user, "uuid")?, "aid": "0", "scy": "auto", "net": "ws", "type": "none",
                "host": transport.get("host").and_then(Value::as_str).unwrap_or(""),
                "path": transport.get("path").and_then(Value::as_str).unwrap_or("/vmess"), "tls": "" });
            Ok(format!(
                "vmess://{}",
                STANDARD.encode(serde_json::to_vec(&value)?)
            ))
        }
        protocol => anyhow::bail!("unsupported link protocol {protocol}"),
    }
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .with_context(|| format!("missing {key}"))
}

fn encode(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

fn parse_endpoint(endpoint: &str) -> Result<(String, u16)> {
    if let Some(value) = endpoint.strip_prefix('[') {
        let (host, port) = value.split_once("]:").context("invalid IPv6 endpoint")?;
        return Ok((host.to_owned(), port.parse()?));
    }
    let (host, port) = endpoint.rsplit_once(':').context("invalid endpoint")?;
    Ok((host.to_owned(), port.parse()?))
}
