use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
};

use anyhow::{Context, Result, bail};
use nix::{sys::signal, unistd::Pid};
use serde_json::Value;
use tokio::{
    process::{Child, Command},
    time::{Duration, timeout},
};

use crate::config::{SingBoxSettings, write_private_atomic};

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
}

impl SingBoxSupervisor {
    pub fn new(settings: SingBoxSettings) -> Self {
        Self {
            settings,
            child: None,
            status: ProcessStatus::Stopped,
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

    pub async fn prepare(&self, bytes: &[u8]) -> Result<bool> {
        let candidate = self.candidate_path();
        write_private_atomic(&candidate, bytes)?;
        if let Err(error) = self.check_path(&candidate).await {
            let _ = fs::remove_file(&candidate);
            return Err(error);
        }
        if let Err(error) = self.format_path(&candidate).await {
            let _ = fs::remove_file(&candidate);
            return Err(error);
        }
        let candidate_bytes = fs::read(&candidate)?;
        if fs::read(&self.settings.managed_config_path).ok().as_deref()
            == Some(candidate_bytes.as_slice())
        {
            fs::remove_file(candidate)?;
            return Ok(false);
        }
        let managed = Path::new(&self.settings.managed_config_path);
        if let Some(parent) = managed.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&candidate, managed)
            .with_context(|| format!("failed to replace managed config {}", managed.display()))?;
        Ok(true)
    }

    pub async fn validate(&self, bytes: &[u8]) -> Result<()> {
        let candidate = self.candidate_path();
        write_private_atomic(&candidate, bytes)?;
        let result = self.check_path(&candidate).await;
        let _ = fs::remove_file(candidate);
        result
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

    async fn check_path(&self, path: &Path) -> Result<()> {
        let output = self
            .tool_command("check", path)
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
        let output = self
            .tool_command("format", path)
            .arg("-w")
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

    fn tool_command(&self, operation: &str, path: &Path) -> Command {
        let mut command = Command::new(&self.settings.binary_path);
        command
            .arg(operation)
            .arg("-c")
            .arg(path)
            .stdin(Stdio::null());
        if let Some(directory) = &self.settings.working_directory {
            command.current_dir(directory);
        }
        command
    }

    fn candidate_path(&self) -> PathBuf {
        Path::new(&self.settings.managed_config_path).with_extension("candidate.json")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    #[cfg(unix)]
    async fn validates_writes_and_supervises_generated_config() {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("sing-box");
        fs::write(&binary, "#!/bin/sh\nif [ \"$1\" = check ]; then grep -q invalid \"$3\" && exit 1; exit 0; fi\nif [ \"$1\" = format ]; then exit 0; fi\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n").unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        let managed = directory.path().join("managed.json");
        let settings = SingBoxSettings {
            binary_path: binary.to_string_lossy().into(),
            managed_config_path: managed.to_string_lossy().into(),
            secrets_path: directory
                .path()
                .join("secrets.json")
                .to_string_lossy()
                .into(),
            certificates_directory: directory.path().join("certs").to_string_lossy().into(),
            working_directory: None,
            restart_delay_seconds: 1,
            shutdown_timeout_seconds: 2,
        };
        let mut supervisor = SingBoxSupervisor::new(settings);
        assert!(supervisor.prepare(br#"{"inbounds":[]}"#).await.unwrap());
        assert!(!supervisor.prepare(br#"{"inbounds":[]}"#).await.unwrap());
        assert!(supervisor.prepare(br#"{"invalid":true}"#).await.is_err());
        assert_eq!(fs::read(&managed).unwrap(), br#"{"inbounds":[]}"#);
        fs::write(&managed, br#"{"tampered":true}"#).unwrap();
        assert!(supervisor.prepare(br#"{"inbounds":[]}"#).await.unwrap());
        assert_eq!(fs::read(&managed).unwrap(), br#"{"inbounds":[]}"#);
        supervisor.start().await.unwrap();
        assert!(supervisor.is_running());
        supervisor.stop().await.unwrap();
        assert_eq!(supervisor.status(), ProcessStatus::Stopped);
    }
}
