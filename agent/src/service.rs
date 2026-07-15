use std::{
    fs,
    path::Path,
    process::{Command, ExitStatus},
    thread,
    time::Duration,
};

use anyhow::{Context, Result, bail};

#[derive(Debug, Clone, Copy)]
pub enum InitSystem {
    Systemd,
    OpenRc,
}

pub fn detect() -> Result<InitSystem> {
    if Path::new("/run/systemd/system").is_dir() && command_exists("systemctl") {
        return Ok(InitSystem::Systemd);
    }
    if command_exists("rc-service") {
        return Ok(InitSystem::OpenRc);
    }
    bail!("neither a running systemd nor OpenRC installation was detected")
}

pub fn action(action: &str) -> Result<()> {
    let status = match (detect()?, action) {
        (InitSystem::Systemd, "status") => Command::new("systemctl")
            .args(["status", "--no-pager", "tunnelatlas.service"])
            .status(),
        (InitSystem::Systemd, value @ ("start" | "stop" | "restart")) => Command::new("systemctl")
            .args([value, "tunnelatlas.service"])
            .status(),
        (InitSystem::Systemd, "logs") => Command::new("journalctl")
            .args(["-u", "tunnelatlas.service", "-f"])
            .status(),
        (InitSystem::OpenRc, value @ ("status" | "start" | "stop" | "restart")) => {
            Command::new("rc-service")
                .args(["tunnelatlas", value])
                .status()
        }
        (InitSystem::OpenRc, "logs") if command_exists("logread") => {
            Command::new("logread").arg("-f").status()
        }
        (_, other) => bail!("unsupported service action {other}"),
    }
    .context("failed to execute service manager")?;
    check_status(status, action)
}

pub fn restart_and_check(runtime_path: Option<&Path>) -> Result<()> {
    action("restart")?;
    for _ in 0..10 {
        thread::sleep(Duration::from_millis(500));
        let runtime_healthy = runtime_path.is_none_or(|path| {
            fs::read(path)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
                .and_then(|value| {
                    value
                        .get("processHealthy")
                        .and_then(serde_json::Value::as_bool)
                })
                .unwrap_or(false)
        });
        if is_active()? && runtime_healthy {
            return Ok(());
        }
    }
    bail!("TunnelAtlas service did not become active after restart")
}

pub fn is_active() -> Result<bool> {
    let status = match detect()? {
        InitSystem::Systemd => Command::new("systemctl")
            .args(["is-active", "--quiet", "tunnelatlas.service"])
            .status(),
        InitSystem::OpenRc => Command::new("rc-service")
            .args(["tunnelatlas", "status"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status(),
    }
    .context("failed to inspect TunnelAtlas service")?;
    Ok(status.success())
}

fn check_status(status: ExitStatus, action: &str) -> Result<()> {
    if status.success() {
        Ok(())
    } else {
        bail!("service {action} failed with {status}")
    }
}

fn command_exists(command: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|path| path.join(command).is_file()))
}
