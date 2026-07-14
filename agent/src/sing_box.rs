use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
};

use anyhow::{Context, Result, bail};
use nix::{sys::signal, unistd::Pid};
use serde_json::{Value, json};
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
        discover_section(
            &config,
            "outbounds",
            "outbound",
            self.status.as_str(),
            &mut tunnels,
        );
        discover_section(
            &config,
            "endpoints",
            "endpoint",
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
            metadata: json!({ "direction": direction }),
        });
    }
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
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn discovers_without_exposing_credentials() {
        let config = json!({
            "inbounds": [{"type":"socks", "tag":"local", "listen":"127.0.0.1", "listen_port":1080, "users":[{"password":"secret"}]}],
            "outbounds": [{"type":"vless", "tag":"remote", "server":"example.com", "server_port":443, "uuid":"secret"}]
        });
        let mut tunnels = Vec::new();
        discover_section(&config, "inbounds", "inbound", "healthy", &mut tunnels);
        discover_section(&config, "outbounds", "outbound", "healthy", &mut tunnels);
        assert_eq!(tunnels.len(), 2);
        assert_eq!(tunnels[1].endpoint, "example.com:443");
        assert!(
            !serde_json::to_string(&tunnels[1].metadata)
                .unwrap()
                .contains("secret")
        );
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
