use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use curve25519_dalek::montgomery::MontgomeryPoint;
use nix::{sys::signal, unistd::Pid};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{
    process::{Child, Command},
    time::{Duration, timeout},
};

use crate::config::SingBoxSettings;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProcessStatus {
    Healthy,
    Failed,
    Stopped,
}

impl ProcessStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Healthy => "healthy",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ObservedTunnel {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub endpoint: String,
    pub protocol: String,
    pub status: String,
    pub metadata: Value,
    pub authentication: Value,
}

pub struct SingBoxSupervisor {
    settings: SingBoxSettings,
    child: Option<Child>,
    status: ProcessStatus,
    source_digest: Option<[u8; 32]>,
    rejected_digest: Option<[u8; 32]>,
}

impl SingBoxSupervisor {
    pub fn new(settings: SingBoxSettings) -> Self {
        Self {
            settings,
            child: None,
            status: ProcessStatus::Stopped,
            source_digest: None,
            rejected_digest: None,
        }
    }

    pub fn settings(&self) -> &SingBoxSettings {
        &self.settings
    }

    pub fn status(&self) -> ProcessStatus {
        self.status.clone()
    }

    pub fn is_running(&self) -> bool {
        self.child.is_some()
    }

    pub async fn validate_source(&self) -> Result<()> {
        let source = self.read_source()?;
        let candidate = self.candidate_path();
        write_private_atomic_candidate(&candidate, &source)?;
        let result = self.check_path(&candidate).await;
        let _ = fs::remove_file(candidate);
        result
    }

    pub async fn reconcile(&mut self) -> Result<bool> {
        let source = self.read_source()?;
        let digest: [u8; 32] = Sha256::digest(&source).into();
        if self.source_digest == Some(digest) || self.rejected_digest == Some(digest) {
            return Ok(false);
        }

        let candidate = self.candidate_path();
        write_private_atomic_candidate(&candidate, &source)?;
        if let Err(error) = self.check_path(&candidate).await {
            let _ = fs::remove_file(&candidate);
            self.rejected_digest = Some(digest);
            return Err(error);
        }
        if let Err(error) = self.format_path(&candidate).await {
            let _ = fs::remove_file(&candidate);
            return Err(error);
        }
        let candidate_bytes = fs::read(&candidate)?;
        let managed = fs::read(&self.settings.managed_config_path).ok();
        if managed.as_deref() == Some(candidate_bytes.as_slice()) {
            fs::remove_file(&candidate)?;
            self.source_digest = Some(digest);
            self.rejected_digest = None;
            return Ok(false);
        }
        let managed_path = Path::new(&self.settings.managed_config_path);
        if let Some(parent) = managed_path.parent() {
            fs::create_dir_all(parent)
                .with_context(|| format!("failed to create {}", parent.display()))?;
        }
        fs::rename(&candidate, managed_path).with_context(|| {
            format!(
                "failed to replace managed config {}",
                managed_path.display()
            )
        })?;
        self.source_digest = Some(digest);
        self.rejected_digest = None;
        Ok(true)
    }

    pub async fn start(&mut self) -> Result<()> {
        if self.child.is_some() {
            bail!("sing-box is already supervised");
        }
        let mut command = Command::new(&self.settings.binary_path);
        command
            .arg("run")
            .arg("-c")
            .arg(&self.settings.managed_config_path)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(true);
        if let Some(directory) = &self.settings.working_directory {
            command.current_dir(directory);
        }
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.status = ProcessStatus::Failed;
                return Err(error)
                    .with_context(|| format!("failed to start {}", self.settings.binary_path));
            }
        };
        self.child = Some(child);
        self.status = ProcessStatus::Healthy;
        Ok(())
    }

    pub fn poll(&mut self) -> Result<Option<std::process::ExitStatus>> {
        let Some(child) = self.child.as_mut() else {
            return Ok(None);
        };
        if let Some(exit) = child.try_wait().context("failed to poll sing-box")? {
            self.child = None;
            self.status = ProcessStatus::Failed;
            return Ok(Some(exit));
        }
        Ok(None)
    }

    pub async fn restart(&mut self) -> Result<()> {
        self.stop().await?;
        self.start().await
    }

    pub async fn stop(&mut self) -> Result<()> {
        let Some(mut child) = self.child.take() else {
            self.status = ProcessStatus::Stopped;
            return Ok(());
        };
        if let Some(id) = child.id() {
            let _ = signal::kill(Pid::from_raw(id as i32), signal::Signal::SIGTERM);
        }
        let grace = Duration::from_secs(self.settings.shutdown_timeout_seconds);
        if timeout(grace, child.wait()).await.is_err() {
            child
                .kill()
                .await
                .context("failed to kill sing-box after shutdown timeout")?;
            child.wait().await.context("failed to reap sing-box")?;
        }
        self.status = ProcessStatus::Stopped;
        Ok(())
    }

    pub fn discover_tunnels(&self) -> Result<Vec<ObservedTunnel>> {
        let bytes = fs::read(&self.settings.managed_config_path)
            .with_context(|| format!("failed to read {}", self.settings.managed_config_path))?;
        let config: Value =
            serde_json::from_slice(&bytes).context("managed sing-box config is invalid JSON")?;
        let mut tunnels = Vec::new();
        discover_section(
            &config,
            "inbounds",
            "inbound",
            self.status.as_str(),
            &mut tunnels,
        );
        Ok(tunnels)
    }

    async fn check_path(&self, path: &Path) -> Result<()> {
        let mut command = Command::new(&self.settings.binary_path);
        command
            .arg("check")
            .arg("-c")
            .arg(path)
            .stdin(Stdio::null());
        if let Some(directory) = &self.settings.working_directory {
            command.current_dir(directory);
        }
        let output = command
            .output()
            .await
            .with_context(|| format!("failed to execute {} check", self.settings.binary_path))?;
        if !output.status.success() {
            bail!(
                "sing-box config check failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
    }

    async fn format_path(&self, path: &Path) -> Result<()> {
        let mut command = Command::new(&self.settings.binary_path);
        command
            .arg("format")
            .arg("-w")
            .arg("-c")
            .arg(path)
            .stdin(Stdio::null());
        if let Some(directory) = &self.settings.working_directory {
            command.current_dir(directory);
        }
        let output = command
            .output()
            .await
            .with_context(|| format!("failed to execute {} format", self.settings.binary_path))?;
        if !output.status.success() {
            bail!(
                "sing-box config format failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
    }

    fn read_source(&self) -> Result<Vec<u8>> {
        let bytes = fs::read(&self.settings.source_config_path)
            .with_context(|| format!("failed to read {}", self.settings.source_config_path))?;
        Ok(bytes)
    }

    fn candidate_path(&self) -> PathBuf {
        Path::new(&self.settings.managed_config_path).with_extension("candidate.json")
    }
}

fn discover_section(
    config: &Value,
    section: &str,
    direction: &str,
    status: &str,
    output: &mut Vec<ObservedTunnel>,
) {
    let Some(items) = config.get(section).and_then(Value::as_array) else {
        return;
    };
    for (index, item) in items.iter().enumerate() {
        let protocol = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let name = item
            .get("tag")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{direction}-{index}"));
        let endpoint = endpoint_of(item, direction);
        let id = uuid::Uuid::new_v5(
            &uuid::Uuid::NAMESPACE_URL,
            format!("tunnelatlas:sing-box:{direction}:{name}").as_bytes(),
        )
        .to_string();
        output.push(ObservedTunnel {
            id,
            name,
            kind: format!("sing-box/{direction}"),
            endpoint,
            protocol: protocol.to_owned(),
            status: status.to_owned(),
            metadata: metadata_of(item, direction),
            authentication: authentication_of(item),
        });
    }
}

fn authentication_of(item: &Value) -> Value {
    const AUTH_FIELDS: &[&str] = &["name", "username", "password", "uuid", "flow", "token"];
    let mut authentication = serde_json::Map::new();
    for field in ["method", "password", "token"] {
        if let Some(value) = item
            .get(field)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            authentication.insert(field.to_owned(), Value::String(value.to_owned()));
        }
    }
    if let Some(users) = item.get("users").and_then(Value::as_array) {
        let filtered = users
            .iter()
            .take(32)
            .filter_map(Value::as_object)
            .map(|user| {
                let mut filtered_user = serde_json::Map::new();
                for field in AUTH_FIELDS {
                    if let Some(value) = user
                        .get(*field)
                        .and_then(Value::as_str)
                        .filter(|value| !value.is_empty())
                    {
                        filtered_user.insert((*field).to_owned(), Value::String(value.to_owned()));
                    }
                }
                Value::Object(filtered_user)
            })
            .filter(|user| user.as_object().is_some_and(|value| !value.is_empty()))
            .collect::<Vec<_>>();
        if !filtered.is_empty() {
            authentication.insert("users".to_owned(), Value::Array(filtered));
        }
    }
    Value::Object(authentication)
}

fn metadata_of(item: &Value, direction: &str) -> Value {
    let mut metadata = serde_json::Map::new();
    metadata.insert("direction".to_owned(), Value::String(direction.to_owned()));

    if let Some(tls) = item.get("tls").and_then(Value::as_object) {
        let mut public_tls = serde_json::Map::new();
        if let Some(enabled) = tls.get("enabled").and_then(Value::as_bool) {
            public_tls.insert("enabled".to_owned(), Value::Bool(enabled));
        }
        if let Some(server_name) = tls.get("server_name").and_then(Value::as_str) {
            public_tls.insert(
                "serverName".to_owned(),
                Value::String(server_name.to_owned()),
            );
        }
        if let Some(alpn) = tls.get("alpn").and_then(Value::as_array) {
            let values = alpn
                .iter()
                .filter_map(Value::as_str)
                .map(|value| Value::String(value.to_owned()))
                .collect::<Vec<_>>();
            if !values.is_empty() {
                public_tls.insert("alpn".to_owned(), Value::Array(values));
            }
        }
        if tls
            .get("certificate_path")
            .and_then(Value::as_str)
            .is_some()
        {
            public_tls.insert("insecure".to_owned(), Value::Bool(true));
        }
        if let Some(reality) = tls.get("reality").and_then(Value::as_object)
            && reality.get("enabled").and_then(Value::as_bool) == Some(true)
        {
            let mut public_reality = serde_json::Map::new();
            public_reality.insert("enabled".to_owned(), Value::Bool(true));
            if let Some(public_key) = reality
                .get("private_key")
                .and_then(Value::as_str)
                .and_then(reality_public_key)
            {
                public_reality.insert("publicKey".to_owned(), Value::String(public_key));
            }
            if let Some(short_id) = reality.get("short_id").and_then(reality_short_id) {
                public_reality.insert("shortId".to_owned(), Value::String(short_id.to_owned()));
            }
            public_tls.insert("reality".to_owned(), Value::Object(public_reality));
        }
        if !public_tls.is_empty() {
            metadata.insert("tls".to_owned(), Value::Object(public_tls));
        }
    }

    if let Some(transport) = item.get("transport").and_then(Value::as_object) {
        let mut public_transport = serde_json::Map::new();
        for field in ["type", "path"] {
            if let Some(value) = transport.get(field).and_then(Value::as_str) {
                public_transport.insert(field.to_owned(), Value::String(value.to_owned()));
            }
        }
        if let Some(host) = transport
            .get("headers")
            .and_then(Value::as_object)
            .and_then(|headers| headers.get("Host").or_else(|| headers.get("host")))
            .and_then(Value::as_str)
        {
            public_transport.insert("host".to_owned(), Value::String(host.to_owned()));
        }
        if !public_transport.is_empty() {
            metadata.insert("transport".to_owned(), Value::Object(public_transport));
        }
    }
    if let Some(value) = item.get("congestion_control").and_then(Value::as_str) {
        metadata.insert(
            "congestionControl".to_owned(),
            Value::String(value.to_owned()),
        );
    }
    Value::Object(metadata)
}

fn reality_short_id(value: &Value) -> Option<&str> {
    value
        .as_str()
        .or_else(|| value.as_array()?.first()?.as_str())
        .filter(|value| !value.is_empty())
}

fn reality_public_key(private_key: &str) -> Option<String> {
    let bytes: [u8; 32] = URL_SAFE_NO_PAD.decode(private_key).ok()?.try_into().ok()?;
    let public_key = MontgomeryPoint::mul_base_clamped(bytes).to_bytes();
    Some(URL_SAFE_NO_PAD.encode(public_key))
}

fn endpoint_of(item: &Value, direction: &str) -> String {
    let host_key = if direction == "inbound" {
        "listen"
    } else {
        "server"
    };
    let port_key = if direction == "inbound" {
        "listen_port"
    } else {
        "server_port"
    };
    let host = item
        .get(host_key)
        .and_then(Value::as_str)
        .unwrap_or(if direction == "inbound" {
            "127.0.0.1"
        } else {
            "managed"
        });
    match item.get(port_key).and_then(Value::as_u64) {
        Some(port) => format_host_port(host, port),
        None => host.to_owned(),
    }
}

fn format_host_port(host: &str, port: u64) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn write_private_atomic_candidate(path: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("failed to create {}", parent.display()))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    #[cfg(not(unix))]
    fs::write(path, bytes)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn discovers_only_inbounds_with_allowlisted_authentication() {
        let config = json!({
            "inbounds": [{
                "type":"vless", "tag":"public", "listen":"::", "listen_port":443,
                "users":[{"name":"alice", "uuid":"client-uuid", "flow":"xtls-rprx-vision", "unknown":"ignored"}],
                "tls":{"reality":{"private_key":"server-private-key", "short_id":["abcd"]}}
            }, {
                "type":"shadowsocks", "tag":"ss", "listen":"::", "listen_port":8388,
                "method":"2022-blake3-aes-128-gcm", "password":"ss-password"
            }],
            "outbounds": [{"type":"vless", "tag":"remote", "server":"example.com", "server_port":443, "uuid":"outbound-secret"}],
            "endpoints": [{"type":"wireguard", "tag":"wg", "private_key":"endpoint-secret"}]
        });
        let mut tunnels = Vec::new();
        discover_section(&config, "inbounds", "inbound", "healthy", &mut tunnels);
        assert_eq!(tunnels.len(), 2);
        assert_eq!(tunnels[0].endpoint, "[::]:443");
        assert_eq!(tunnels[0].authentication["users"][0]["uuid"], "client-uuid");
        assert_eq!(
            tunnels[1].authentication["method"],
            "2022-blake3-aes-128-gcm"
        );
        assert_eq!(tunnels[1].authentication["password"], "ss-password");
        let serialized = serde_json::to_string(&tunnels[0].authentication).unwrap();
        assert!(!serialized.contains("server-private-key"));
        assert!(!serialized.contains("short_id"));
        assert!(!serialized.contains("unknown"));
    }

    #[test]
    fn reports_public_reality_client_parameters_without_the_private_key() {
        let private_key = URL_SAFE_NO_PAD.encode(
            hex::decode("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
                .unwrap(),
        );
        let config = json!({
            "inbounds": [{
                "type": "vless", "tag": "reality", "listen": "::", "listen_port": 443,
                "users": [{"name": "", "uuid": "client-uuid", "flow": "xtls-rprx-vision"}],
                "tls": {
                    "enabled": true,
                    "server_name": "addons.mozilla.org",
                    "reality": {"enabled": true, "private_key": private_key, "short_id": "0123456789abcdef"}
                }
            }]
        });
        let mut tunnels = Vec::new();
        discover_section(&config, "inbounds", "inbound", "healthy", &mut tunnels);
        let metadata = &tunnels[0].metadata;
        assert_eq!(
            metadata["tls"]["reality"]["publicKey"],
            URL_SAFE_NO_PAD.encode(
                hex::decode("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
                    .unwrap()
            )
        );
        assert_eq!(metadata["tls"]["serverName"], "addons.mozilla.org");
        assert_eq!(metadata["tls"]["reality"]["shortId"], "0123456789abcdef");
        assert_eq!(tunnels[0].authentication["users"][0]["uuid"], "client-uuid");
        assert!(tunnels[0].authentication["users"][0].get("name").is_none());
        assert!(!metadata.to_string().contains("private_key"));
        assert!(!metadata.to_string().contains(&private_key));
    }

    #[tokio::test]
    #[cfg(unix)]
    async fn validates_reconciles_and_supervises_process() {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("sing-box");
        fs::write(
            &binary,
            "#!/bin/sh\nif [ \"$1\" = check ]; then grep -q invalid \"$3\" && exit 1; exit 0; fi\nif [ \"$1\" = format ]; then exit 0; fi\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n",
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        let source = directory.path().join("source.json");
        let managed = directory.path().join("managed.json");
        fs::write(
            &source,
            r#"{"inbounds":[{"type":"socks","tag":"local","listen_port":1080}]}"#,
        )
        .unwrap();
        let settings = SingBoxSettings {
            binary_path: binary.to_string_lossy().into_owned(),
            source_config_path: source.to_string_lossy().into_owned(),
            managed_config_path: managed.to_string_lossy().into_owned(),
            working_directory: None,
            reconcile_interval_seconds: 2,
            restart_delay_seconds: 1,
            shutdown_timeout_seconds: 2,
        };
        let mut supervisor = SingBoxSupervisor::new(settings);
        assert!(supervisor.reconcile().await.unwrap());
        assert!(!supervisor.reconcile().await.unwrap());
        supervisor.start().await.unwrap();
        assert!(supervisor.is_running());
        assert_eq!(supervisor.discover_tunnels().unwrap().len(), 1);
        supervisor.stop().await.unwrap();
        assert_eq!(supervisor.status(), ProcessStatus::Stopped);

        fs::write(&source, r#"{"invalid":true}"#).unwrap();
        assert!(supervisor.reconcile().await.is_err());
        assert!(!supervisor.reconcile().await.unwrap());
        assert!(managed.exists());
    }
}
