use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result, bail};
use clap::Subcommand;

use crate::{
    config::{Config, write_private_atomic},
    render,
    runtime::RuntimeState,
    secrets::SecretStore,
    service,
    sing_box::SingBoxSupervisor,
};

#[derive(Debug, Subcommand)]
pub enum ConfigCommand {
    Show,
    Check,
}

#[derive(Debug, Subcommand)]
pub enum ServiceCommand {
    Status,
    Start,
    Stop,
    Restart,
    Logs,
}

#[derive(Debug, Subcommand)]
pub enum UpdateCommand {
    Agent,
    SingBox,
}

pub async fn config(command: ConfigCommand, config_path: &Path) -> Result<()> {
    match command {
        ConfigCommand::Show => {
            let mut config = Config::load(config_path)?;
            if config.enrollment_token.is_some() {
                config.enrollment_token = Some("<redacted>".into());
            }
            print!("{}", serde_yaml::to_string(&config)?);
            Ok(())
        }
        ConfigCommand::Check => check(config_path).await,
    }
}

pub async fn check(config_path: &Path) -> Result<()> {
    let config = Config::load(config_path)?;
    config.validate()?;
    let runtime_path = Path::new(&config.runtime_path);
    if let Ok(RuntimeState {
        applied_desired_config: Some(desired),
        observed_address,
        ..
    }) = RuntimeState::load(runtime_path)
    {
        desired.validate()?;
        let secrets_path = Path::new(&config.sing_box.secrets_path);
        let secrets = SecretStore::load(secrets_path)?;
        let certs_dir = Path::new(&config.sing_box.certificates_directory);
        let rendered = render::render_desired(
            &desired.tunnels,
            &secrets,
            certs_dir,
            observed_address.as_deref(),
            "healthy",
        )?;
        let supervisor = SingBoxSupervisor::new(config.sing_box.clone());
        supervisor.validate(&rendered.bytes).await?;
    }
    println!("TunnelAtlas configuration is valid");
    Ok(())
}

pub fn service_command(command: ServiceCommand) -> Result<()> {
    let action = match command {
        ServiceCommand::Status => "status",
        ServiceCommand::Start => "start",
        ServiceCommand::Stop => "stop",
        ServiceCommand::Restart => "restart",
        ServiceCommand::Logs => "logs",
    };
    service::action(action)
}

pub async fn update(command: UpdateCommand, config_path: &Path) -> Result<()> {
    match command {
        UpdateCommand::Agent => update_agent(config_path).await,
        UpdateCommand::SingBox => {
            let current = Config::load(config_path)?;
            let binary = PathBuf::from(&current.sing_box.binary_path);
            let backup = binary.with_extension("tunnelatlas-backup");
            fs::copy(&binary, &backup)
                .with_context(|| format!("failed to back up {}", binary.display()))?;
            let result = async {
                update_sing_box().await?;
                check(config_path).await
            }
            .await;
            if let Err(error) = result {
                fs::copy(&backup, &binary)
                    .with_context(|| format!("failed to restore {}", binary.display()))?;
                let _ = fs::remove_file(&backup);
                return Err(error).context("sing-box update failed; previous binary restored");
            }
            fs::remove_file(backup)?;
            if service::is_active().unwrap_or(false) {
                let _ = service::action("restart");
            }
            Ok(())
        }
    }
}

pub fn uninstall(config_path: &Path, identity_path: &Path, with_sing_box: bool) -> Result<()> {
    let config = Config::load(config_path)?;
    match service::detect()? {
        service::InitSystem::Systemd => {
            let _ = Command::new("systemctl")
                .args(["disable", "--now", "tunnelatlas.service"])
                .status();
            let _ = fs::remove_file("/etc/systemd/system/tunnelatlas.service");
            let _ = Command::new("systemctl").arg("daemon-reload").status();
        }
        service::InitSystem::OpenRc => {
            let _ = Command::new("rc-service")
                .args(["tunnelatlas", "stop"])
                .status();
            let _ = Command::new("rc-update")
                .args(["del", "tunnelatlas", "default"])
                .status();
            let _ = fs::remove_file("/etc/init.d/tunnelatlas");
        }
    }
    let _ = fs::remove_file(config_path);
    let _ = fs::remove_file(identity_path);
    let _ = fs::remove_file(&config.sing_box.secrets_path);
    let _ = fs::remove_file(&config.sing_box.managed_config_path);
    let _ = fs::remove_file(&config.runtime_path);
    let _ = fs::remove_dir_all(&config.sing_box.certificates_directory);
    let _ = fs::remove_dir_all("/etc/tunnelatlas");
    let _ = fs::remove_dir_all("/var/lib/tunnelatlas");
    if with_sing_box {
        match service::detect()? {
            service::InitSystem::Systemd => {
                let _ = Command::new("systemctl")
                    .args(["disable", "--now", "sing-box.service"])
                    .status();
                let _ = fs::remove_file("/etc/systemd/system/sing-box.service");
                let _ = fs::remove_file("/usr/lib/systemd/system/sing-box.service");
            }
            service::InitSystem::OpenRc => {
                let _ = Command::new("rc-service")
                    .args(["sing-box", "stop"])
                    .status();
                let _ = Command::new("rc-update")
                    .args(["del", "sing-box", "default"])
                    .status();
                let _ = fs::remove_file("/etc/init.d/sing-box");
            }
        }
        if command_exists("apk") {
            let _ = Command::new("apk").args(["del", "sing-box"]).status();
        }
        let _ = fs::remove_file(&config.sing_box.binary_path);
        let _ = fs::remove_dir_all("/etc/sing-box");
        let _ = fs::remove_dir_all("/var/lib/sing-box");
        if matches!(service::detect()?, service::InitSystem::Systemd) {
            let _ = Command::new("systemctl").arg("daemon-reload").status();
        }
    }
    let executable = std::env::current_exe()?;
    fs::remove_file(&executable)
        .with_context(|| format!("failed to remove {}", executable.display()))?;
    println!(
        "TunnelAtlas uninstalled{}",
        if with_sing_box { " with sing-box" } else { "" }
    );
    Ok(())
}

pub async fn manage(config_path: &Path, identity_path: &Path) -> Result<()> {
    loop {
        println!(
            "\nTunnelAtlas 管理\n1. 服务状态\n2. 启动服务\n3. 停止服务\n4. 重启服务\n5. 查看日志\n6. 检查配置\n7. 更新 Agent\n8. 更新 sing-box\n9. 卸载 TunnelAtlas\n10. 卸载 TunnelAtlas 和 sing-box\n0. 退出"
        );
        let choice = prompt("请选择: ")?;
        let result = match choice.trim() {
            "1" => service_command(ServiceCommand::Status),
            "2" => service_command(ServiceCommand::Start),
            "3" => service_command(ServiceCommand::Stop),
            "4" => service_command(ServiceCommand::Restart),
            "5" => service_command(ServiceCommand::Logs),
            "6" => config(ConfigCommand::Check, config_path).await,
            "7" => update(UpdateCommand::Agent, config_path).await,
            "8" => update(UpdateCommand::SingBox, config_path).await,
            "9" => {
                let confirmation = prompt("输入 uninstall 确认: ")?;
                if confirmation == "uninstall" {
                    uninstall(config_path, identity_path, false)?;
                    return Ok(());
                } else {
                    bail!("已取消")
                }
            }
            "10" => {
                let confirmation = prompt("输入 uninstall-with-sing-box 确认: ")?;
                if confirmation == "uninstall-with-sing-box" {
                    uninstall(config_path, identity_path, true)?;
                    return Ok(());
                } else {
                    bail!("已取消")
                }
            }
            "0" => return Ok(()),
            _ => {
                println!("无效选择");
                continue;
            }
        };
        if let Err(error) = result {
            println!("操作失败: {error:#}");
        }
    }
}

fn prompt(message: &str) -> Result<String> {
    print!("{message}");
    io::stdout().flush()?;
    let mut value = String::new();
    io::stdin().read_line(&mut value)?;
    Ok(value.trim().to_owned())
}

async fn update_agent(config_path: &Path) -> Result<()> {
    #[derive(serde::Deserialize)]
    struct Release {
        tag_name: String,
    }
    let config = Config::load(config_path)?;
    let runtime_path = PathBuf::from(&config.runtime_path);
    let mut runtime = RuntimeState::load(&runtime_path)?;
    let old_config_bytes = fs::read(config_path).ok();

    let client = reqwest::Client::builder()
        .user_agent(concat!("tunnelatlasd/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let release: Release = client
        .get("https://api.github.com/repos/huochai67/tunnelatlas/releases/latest")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let version = release.tag_name.trim_start_matches('v');
    let arch = match std::env::consts::ARCH {
        "x86_64" => "x86_64",
        "aarch64" => "aarch64",
        other => bail!("unsupported architecture {other}"),
    };
    let libc = if cfg!(target_env = "musl") {
        "musl"
    } else {
        "gnu"
    };
    let platform = format!("{arch}-linux-{libc}");
    let archive = format!("tunnelatlasd-{version}-{platform}.tar.gz");
    let base = format!(
        "https://github.com/huochai67/tunnelatlas/releases/download/{}/",
        release.tag_name
    );
    let sums = client
        .get(format!("{base}SHA256SUMS"))
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let expected = sums
        .lines()
        .find_map(|line| {
            let mut fields = line.split_whitespace();
            let hash = fields.next()?;
            let name = fields.next()?.trim_start_matches("./");
            (name == archive).then_some(hash.to_owned())
        })
        .context("release checksum is missing")?;
    let bytes = client
        .get(format!("{base}{archive}"))
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    use sha2::{Digest, Sha256};
    if hex::encode(Sha256::digest(&bytes)) != expected.to_ascii_lowercase() {
        bail!("release checksum verification failed");
    }
    let directory = std::env::temp_dir().join(format!("tunnelatlas-update-{}", std::process::id()));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory)?;
    let archive_path = directory.join(&archive);
    write_private_atomic(&archive_path, &bytes)?;
    let status = Command::new("tar")
        .arg("-C")
        .arg(&directory)
        .args(["--no-same-owner", "-xzf"])
        .arg(&archive_path)
        .status()?;
    if !status.success() {
        bail!("failed to extract release archive");
    }
    let source = directory.join(format!("tunnelatlasd-{version}-{platform}/tunnelatlasd"));
    let target = std::env::current_exe()?;
    let candidate = target.with_extension("new");
    let backup = target.with_extension("tunnelatlas-backup");
    let _ = fs::remove_file(&candidate);
    let _ = fs::remove_file(&backup);
    fs::copy(&target, &backup)?;
    fs::copy(&source, &candidate)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&candidate, fs::Permissions::from_mode(0o755))?;
    }
    runtime.process_healthy = false;
    runtime.save(&runtime_path)?;
    fs::rename(&candidate, &target)?;
    let _ = fs::remove_dir_all(&directory);
    if let Err(error) = service::restart_and_check(Some(&runtime_path)) {
        if let Some(bytes) = old_config_bytes {
            let _ = write_private_atomic(config_path, &bytes);
        }
        fs::rename(&backup, &target).context("failed to restore previous TunnelAtlas binary")?;
        if let Ok(mut runtime) = RuntimeState::load(&runtime_path) {
            runtime.process_healthy = false;
            let _ = runtime.save(&runtime_path);
        }
        let _ = service::restart_and_check(Some(&runtime_path));
        return Err(error)
            .context("TunnelAtlas update failed; previous binary and config restored");
    }
    fs::remove_file(backup)?;
    println!("Updated TunnelAtlas to {}", release.tag_name);
    Ok(())
}

async fn update_sing_box() -> Result<()> {
    if command_exists("apk") {
        let status = Command::new("apk")
            .args([
                "add",
                "--upgrade",
                "--repository=https://dl-cdn.alpinelinux.org/alpine/edge/testing",
                "sing-box",
            ])
            .status()?;
        if !status.success() {
            bail!("apk failed to update sing-box");
        }
        return Ok(());
    }

    #[derive(serde::Deserialize)]
    struct SingBoxRelease {
        tag_name: String,
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("tunnelatlasd/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let release: SingBoxRelease = client
        .get("https://api.github.com/repos/SagerNet/sing-box/releases/latest")
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let version = release.tag_name.trim_start_matches('v');
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        other => bail!("unsupported architecture {other}"),
    };
    let archive = format!("sing-box-{version}-linux-{arch}.tar.gz");
    let base = format!(
        "https://github.com/SagerNet/sing-box/releases/download/{}/",
        release.tag_name
    );
    let bytes = client
        .get(format!("{base}{archive}"))
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    let directory = std::env::temp_dir().join(format!("sing-box-update-{}", std::process::id()));
    let _ = fs::remove_dir_all(&directory);
    fs::create_dir_all(&directory)?;
    let archive_path = directory.join(&archive);
    write_private_atomic(&archive_path, &bytes)?;
    let status = Command::new("tar")
        .arg("-C")
        .arg(&directory)
        .args(["--no-same-owner", "-xzf"])
        .arg(&archive_path)
        .status()?;
    if !status.success() {
        bail!("failed to extract sing-box archive");
    }
    let binary = directory.join(format!("sing-box-{version}-linux-{arch}/sing-box"));
    let target = Path::new("/usr/local/bin/sing-box");
    let candidate = target.with_extension("new");
    let _ = fs::remove_file(&candidate);
    fs::copy(&binary, &candidate)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&candidate, fs::Permissions::from_mode(0o755))?;
    }
    fs::rename(&candidate, target)?;
    let _ = fs::remove_dir_all(&directory);
    println!("Updated sing-box to {}", release.tag_name);
    Ok(())
}

fn command_exists(name: &str) -> bool {
    std::env::var_os("PATH")
        .map(|paths| {
            std::env::split_paths(&paths)
                .map(|path| path.join(name))
                .any(|path| path.is_file())
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    #[cfg(unix)]
    async fn check_validates_config_without_modifying_files() {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("sing-box");
        fs::write(&binary, "#!/bin/sh\nexit 0\n").unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        let config_path = directory.path().join("config.yaml");
        let config = Config {
            server_url: "https://example.com".into(),
            enrollment_token: None,
            report_interval_seconds: 60,
            labels: BTreeMap::new(),
            runtime_path: directory
                .path()
                .join("runtime.json")
                .to_string_lossy()
                .into(),
            sing_box: crate::config::SingBoxSettings {
                binary_path: binary.to_string_lossy().into(),
                managed_config_path: directory
                    .path()
                    .join("sing-box.json")
                    .to_string_lossy()
                    .into(),
                secrets_path: directory
                    .path()
                    .join("secrets.json")
                    .to_string_lossy()
                    .into(),
                certificates_directory: directory
                    .path()
                    .join("certificates")
                    .to_string_lossy()
                    .into(),
                working_directory: None,
                restart_delay_seconds: 1,
                shutdown_timeout_seconds: 1,
            },
            public_host: None,
            protocols: None,
        };
        config.save(&config_path).unwrap();

        let before = fs::read(&config_path).unwrap();
        check(&config_path).await.unwrap();
        assert_eq!(fs::read(&config_path).unwrap(), before);
    }
}
