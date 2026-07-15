use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result, bail};
use clap::{Args, Subcommand, ValueEnum};
use fs2::FileExt;
use rand::{Rng, rngs::OsRng};

use crate::{
    config::{Config, ProtocolKind, ProtocolSpec, write_private_atomic},
    links, render,
    runtime::RuntimeState,
    secrets::SecretStore,
    service,
    sing_box::SingBoxSupervisor,
};

#[derive(Debug, Clone, Copy, ValueEnum)]
pub enum ProtocolType {
    Ss,
    Hy2,
    Tuic,
    Reality,
    Anytls,
    Vmess,
}

impl ProtocolType {
    fn default_tag(self) -> &'static str {
        match self {
            Self::Ss => "ss-in",
            Self::Hy2 => "hy2-in",
            Self::Tuic => "tuic-in",
            Self::Reality => "vless-in",
            Self::Anytls => "anytls-in",
            Self::Vmess => "vmess-ws-in",
        }
    }
}

#[derive(Debug, Subcommand)]
pub enum ProtocolCommand {
    List,
    Add(ProtocolAdd),
    Set(ProtocolSet),
    Remove(ProtocolTarget),
    Rotate(ProtocolTarget),
}

#[derive(Debug, Args)]
pub struct ProtocolAdd {
    #[arg(value_enum)]
    pub protocol: ProtocolType,
    #[arg(long)]
    pub tag: Option<String>,
    #[arg(long)]
    pub port: Option<u16>,
    #[arg(long, default_value = "::")]
    pub listen: String,
    #[arg(long)]
    pub method: Option<String>,
    #[arg(long)]
    pub server_name: Option<String>,
    #[arg(long)]
    pub congestion_control: Option<String>,
    #[arg(long)]
    pub path: Option<String>,
    #[arg(long)]
    pub host: Option<String>,
    #[arg(long, requires = "key")]
    pub certificate: Option<PathBuf>,
    #[arg(long, requires = "certificate")]
    pub key: Option<PathBuf>,
    #[arg(long)]
    pub no_restart: bool,
}

#[derive(Debug, Args)]
pub struct ProtocolSet {
    pub tag: String,
    #[arg(long)]
    pub port: Option<u16>,
    #[arg(long)]
    pub listen: Option<String>,
    #[arg(long)]
    pub method: Option<String>,
    #[arg(long)]
    pub server_name: Option<String>,
    #[arg(long)]
    pub congestion_control: Option<String>,
    #[arg(long)]
    pub path: Option<String>,
    #[arg(long)]
    pub host: Option<String>,
    #[arg(long, requires = "key")]
    pub certificate: Option<PathBuf>,
    #[arg(long, requires = "certificate")]
    pub key: Option<PathBuf>,
    #[arg(long)]
    pub no_restart: bool,
    #[arg(long, help = "Rotate credentials together with this change")]
    pub rotate: bool,
}

#[derive(Debug, Args)]
pub struct ProtocolTarget {
    pub tag: String,
    #[arg(long)]
    pub no_restart: bool,
}

#[derive(Debug, Subcommand)]
pub enum ConfigCommand {
    Show,
    Check,
    Apply,
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

pub async fn protocol(command: ProtocolCommand, config_path: &Path) -> Result<()> {
    match command {
        ProtocolCommand::List => {
            let config = Config::load(config_path)?;
            if config.protocols.is_empty() {
                println!("No protocols configured");
            }
            for item in config.protocols {
                println!(
                    "{}\t{}\t{}",
                    item.tag,
                    item.kind.name(),
                    display_endpoint(&item.listen, item.port)
                );
            }
            Ok(())
        }
        ProtocolCommand::Add(args) => {
            transaction(config_path, !args.no_restart, move |config, _| {
                let tag = args
                    .tag
                    .clone()
                    .unwrap_or_else(|| args.protocol.default_tag().to_owned());
                if config.protocols.iter().any(|item| item.tag == tag) {
                    bail!("protocol tag already exists: {tag}");
                }
                let port = args.port.unwrap_or_else(|| random_port(config));
                validate_add_options(&args)?;
                let mut kind = kind_from_add(&args);
                import_certificate(config, &tag, &args.certificate, &args.key, &mut kind)?;
                config.protocols.push(ProtocolSpec {
                    tag: tag.clone(),
                    listen: args.listen.clone(),
                    port,
                    kind,
                });
                println!("Added protocol {tag} on port {port}");
                Ok(())
            })
            .await
        }
        ProtocolCommand::Set(args) => {
            transaction(config_path, !args.no_restart, move |config, secrets| {
                let index = config
                    .protocols
                    .iter()
                    .position(|item| item.tag == args.tag)
                    .with_context(|| format!("protocol not found: {}", args.tag))?;
                if let Some(port) = args.port {
                    if config
                        .protocols
                        .iter()
                        .enumerate()
                        .any(|(other, item)| other != index && item.port == port)
                    {
                        bail!("protocol port already used: {port}");
                    }
                    config.protocols[index].port = port;
                }
                if let Some(listen) = &args.listen {
                    config.protocols[index].listen = listen.clone();
                }
                validate_set_options(&config.protocols[index].kind, &args)?;
                update_kind(&mut config.protocols[index].kind, &args)?;
                let tag = config.protocols[index].tag.clone();
                let mut kind = config.protocols[index].kind.clone();
                import_certificate(config, &tag, &args.certificate, &args.key, &mut kind)?;
                config.protocols[index].kind = kind;
                if args.rotate {
                    secrets.rotate(&config.protocols[index]);
                }
                println!("Updated protocol {}", args.tag);
                Ok(())
            })
            .await
        }
        ProtocolCommand::Remove(args) => {
            transaction(config_path, !args.no_restart, move |config, _| {
                let before = config.protocols.len();
                config.protocols.retain(|item| item.tag != args.tag);
                if config.protocols.len() == before {
                    bail!("protocol not found: {}", args.tag);
                }
                println!("Removed protocol {}", args.tag);
                Ok(())
            })
            .await
        }
        ProtocolCommand::Rotate(args) => {
            transaction(config_path, !args.no_restart, move |config, secrets| {
                let protocol = config
                    .protocols
                    .iter()
                    .find(|item| item.tag == args.tag)
                    .with_context(|| format!("protocol not found: {}", args.tag))?;
                secrets.rotate(protocol);
                println!("Rotated credentials for {}", args.tag);
                Ok(())
            })
            .await
        }
    }
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
        ConfigCommand::Check => transaction(config_path, false, |_, _| Ok(()))
            .await
            .map(|_| println!("TunnelAtlas and generated sing-box configurations are valid")),
        ConfigCommand::Apply => transaction(config_path, true, |_, _| Ok(()))
            .await
            .map(|_| println!("Configuration applied")),
    }
}

pub fn show_links(config_path: &Path) -> Result<()> {
    let mut config = Config::load(config_path)?;
    if config.public_host.is_none() {
        config.public_host = RuntimeState::load(Path::new(&config.runtime_path))?.observed_address;
    }
    if config.public_host.is_none() {
        bail!("public address is unknown; set publicHost or send an agent report first");
    }
    let mut secrets = SecretStore::load(Path::new(&config.sing_box.secrets_path))?;
    secrets.reconcile(&config)?;
    let rendered = render::render(&config, &secrets, "healthy")?;
    for link in links::links(&rendered.tunnels)? {
        println!("{link}");
    }
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
                config(ConfigCommand::Apply, config_path).await
            }
            .await;
            if let Err(error) = result {
                fs::copy(&backup, &binary)
                    .with_context(|| format!("failed to restore {}", binary.display()))?;
                let _ = config(ConfigCommand::Apply, config_path).await;
                let _ = fs::remove_file(&backup);
                return Err(error).context("sing-box update failed; previous binary restored");
            }
            fs::remove_file(backup)?;
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
            "\nTunnelAtlas 管理\n1. 协议列表\n2. 添加协议\n3. 修改协议端口\n4. 删除协议\n5. 轮换凭据\n6. 显示链接\n7. 服务状态\n8. 启动服务\n9. 停止服务\n10. 重启服务\n11. 查看日志\n12. 检查配置\n13. 更新 Agent\n14. 更新 sing-box\n15. 卸载 TunnelAtlas\n16. 卸载 TunnelAtlas 和 sing-box\n0. 退出"
        );
        let choice = prompt("请选择: ")?;
        let result = match choice.trim() {
            "1" => protocol(ProtocolCommand::List, config_path).await,
            "2" => interactive_add(config_path).await,
            "3" => {
                let tag = prompt("协议 tag: ")?;
                let port = prompt("新端口: ")?.parse()?;
                protocol(
                    ProtocolCommand::Set(ProtocolSet {
                        tag,
                        port: Some(port),
                        listen: None,
                        method: None,
                        server_name: None,
                        congestion_control: None,
                        path: None,
                        host: None,
                        certificate: None,
                        key: None,
                        no_restart: false,
                        rotate: false,
                    }),
                    config_path,
                )
                .await
            }
            "4" => {
                let tag = prompt("协议 tag: ")?;
                protocol(
                    ProtocolCommand::Remove(ProtocolTarget {
                        tag,
                        no_restart: false,
                    }),
                    config_path,
                )
                .await
            }
            "5" => {
                let tag = prompt("协议 tag: ")?;
                protocol(
                    ProtocolCommand::Rotate(ProtocolTarget {
                        tag,
                        no_restart: false,
                    }),
                    config_path,
                )
                .await
            }
            "6" => show_links(config_path),
            "7" => service_command(ServiceCommand::Status),
            "8" => service_command(ServiceCommand::Start),
            "9" => service_command(ServiceCommand::Stop),
            "10" => service_command(ServiceCommand::Restart),
            "11" => service_command(ServiceCommand::Logs),
            "12" => config(ConfigCommand::Check, config_path).await,
            "13" => update(UpdateCommand::Agent, config_path).await,
            "14" => update(UpdateCommand::SingBox, config_path).await,
            "15" => {
                let confirmation = prompt("输入 uninstall 确认: ")?;
                if confirmation == "uninstall" {
                    uninstall(config_path, identity_path, false)?;
                    return Ok(());
                } else {
                    bail!("已取消")
                }
            }
            "16" => {
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
                eprintln!("无效选项");
                continue;
            }
        };
        if let Err(error) = result {
            eprintln!("操作失败: {error:#}");
        }
    }
}

async fn interactive_add(config_path: &Path) -> Result<()> {
    let protocol_name = prompt("协议 (ss/hy2/tuic/reality/anytls/vmess): ")?;
    let protocol_type = match protocol_name.trim() {
        "ss" => ProtocolType::Ss,
        "hy2" => ProtocolType::Hy2,
        "tuic" => ProtocolType::Tuic,
        "reality" => ProtocolType::Reality,
        "anytls" => ProtocolType::Anytls,
        "vmess" => ProtocolType::Vmess,
        _ => bail!("不支持的协议"),
    };
    let tag = prompt(&format!("tag [{}]: ", protocol_type.default_tag()))?;
    let port = prompt("端口 [随机]: ")?;
    protocol(
        ProtocolCommand::Add(ProtocolAdd {
            protocol: protocol_type,
            tag: (!tag.is_empty()).then_some(tag),
            port: if port.is_empty() {
                None
            } else {
                Some(port.parse()?)
            },
            listen: "::".into(),
            method: None,
            server_name: None,
            congestion_control: None,
            path: None,
            host: None,
            certificate: None,
            key: None,
            no_restart: false,
        }),
        config_path,
    )
    .await
}

async fn transaction<F>(config_path: &Path, restart: bool, modify: F) -> Result<()>
where
    F: FnOnce(&mut Config, &mut SecretStore) -> Result<()>,
{
    let initial = Config::load(config_path)?;
    let lock_path = Path::new(&initial.sing_box.secrets_path)
        .parent()
        .unwrap_or(Path::new("/var/lib/tunnelatlas"))
        .join("control.lock");
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)?;
    lock.lock_exclusive()
        .context("failed to lock TunnelAtlas configuration")?;

    let mut config = Config::load(config_path)?;
    let secrets_path = PathBuf::from(&config.sing_box.secrets_path);
    let managed_path = PathBuf::from(&config.sing_box.managed_config_path);
    let certificates_path = PathBuf::from(&config.sing_box.certificates_directory);
    let old_config = fs::read(config_path).ok();
    let old_secrets = fs::read(&secrets_path).ok();
    let old_managed = fs::read(&managed_path).ok();
    let old_certificates = snapshot_directory(&certificates_path)?;
    let mut secrets = SecretStore::load(&secrets_path)?;
    let preflight = async {
        modify(&mut config, &mut secrets)?;
        config.validate()?;
        secrets.reconcile(&config)?;
        let rendered = render::render(&config, &secrets, "healthy")?;
        let supervisor = SingBoxSupervisor::new(config.sing_box.clone());
        supervisor.validate(&rendered.bytes).await?;
        Ok::<_, anyhow::Error>((rendered, supervisor))
    }
    .await;
    let (rendered, supervisor) = match preflight {
        Ok(value) => value,
        Err(error) => {
            restore_directory(&certificates_path, &old_certificates)?;
            return Err(error);
        }
    };

    let result = async {
        config.save(config_path)?;
        secrets.save(&secrets_path)?;
        supervisor.prepare(&rendered.bytes).await?;
        if restart {
            let runtime_path = Path::new(&config.runtime_path);
            let mut runtime = RuntimeState::load(runtime_path)?;
            runtime.process_healthy = false;
            runtime.save(runtime_path)?;
            service::restart_and_check(Some(runtime_path))?;
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;
    if let Err(error) = result {
        restore(config_path, old_config.as_deref())?;
        restore(&secrets_path, old_secrets.as_deref())?;
        restore(&managed_path, old_managed.as_deref())?;
        restore_directory(&certificates_path, &old_certificates)?;
        if restart {
            let runtime_path = Path::new(&config.runtime_path);
            if let Ok(mut runtime) = RuntimeState::load(runtime_path) {
                runtime.process_healthy = false;
                let _ = runtime.save(runtime_path);
            }
            let _ = service::restart_and_check(Some(runtime_path));
        }
        return Err(error).context("configuration apply failed; previous state restored");
    }
    Ok(())
}

fn kind_from_add(args: &ProtocolAdd) -> ProtocolKind {
    match args.protocol {
        ProtocolType::Ss => ProtocolKind::Shadowsocks {
            method: args
                .method
                .clone()
                .unwrap_or_else(|| "2022-blake3-aes-128-gcm".into()),
        },
        ProtocolType::Hy2 => ProtocolKind::Hysteria2 {
            server_name: args
                .server_name
                .clone()
                .unwrap_or_else(|| "www.bing.com".into()),
            certificate_path: None,
            key_path: None,
        },
        ProtocolType::Tuic => ProtocolKind::Tuic {
            server_name: args
                .server_name
                .clone()
                .unwrap_or_else(|| "www.bing.com".into()),
            congestion_control: args
                .congestion_control
                .clone()
                .unwrap_or_else(|| "bbr".into()),
            certificate_path: None,
            key_path: None,
        },
        ProtocolType::Reality => ProtocolKind::VlessReality {
            server_name: args
                .server_name
                .clone()
                .unwrap_or_else(|| "addons.mozilla.org".into()),
        },
        ProtocolType::Anytls => ProtocolKind::AnytlsReality {
            server_name: args
                .server_name
                .clone()
                .unwrap_or_else(|| "addons.mozilla.org".into()),
        },
        ProtocolType::Vmess => ProtocolKind::VmessWs {
            path: args.path.clone().unwrap_or_else(|| "/vmess".into()),
            host: args.host.clone(),
        },
    }
}

fn validate_add_options(args: &ProtocolAdd) -> Result<()> {
    let invalid = match args.protocol {
        ProtocolType::Ss => {
            args.server_name.is_some()
                || args.congestion_control.is_some()
                || args.path.is_some()
                || args.host.is_some()
                || args.certificate.is_some()
        }
        ProtocolType::Hy2 => {
            args.method.is_some()
                || args.congestion_control.is_some()
                || args.path.is_some()
                || args.host.is_some()
        }
        ProtocolType::Tuic => args.method.is_some() || args.path.is_some() || args.host.is_some(),
        ProtocolType::Reality | ProtocolType::Anytls => {
            args.method.is_some()
                || args.congestion_control.is_some()
                || args.path.is_some()
                || args.host.is_some()
                || args.certificate.is_some()
        }
        ProtocolType::Vmess => {
            args.method.is_some()
                || args.server_name.is_some()
                || args.congestion_control.is_some()
                || args.certificate.is_some()
        }
    };
    if invalid {
        bail!("one or more options are not supported by the selected protocol");
    }
    Ok(())
}

fn validate_set_options(kind: &ProtocolKind, args: &ProtocolSet) -> Result<()> {
    let invalid = match kind {
        ProtocolKind::Shadowsocks { .. } => {
            args.server_name.is_some()
                || args.congestion_control.is_some()
                || args.path.is_some()
                || args.host.is_some()
                || args.certificate.is_some()
        }
        ProtocolKind::Hysteria2 { .. } => {
            args.method.is_some()
                || args.congestion_control.is_some()
                || args.path.is_some()
                || args.host.is_some()
        }
        ProtocolKind::Tuic { .. } => {
            args.method.is_some() || args.path.is_some() || args.host.is_some()
        }
        ProtocolKind::VlessReality { .. } | ProtocolKind::AnytlsReality { .. } => {
            args.method.is_some()
                || args.congestion_control.is_some()
                || args.path.is_some()
                || args.host.is_some()
                || args.certificate.is_some()
        }
        ProtocolKind::VmessWs { .. } => {
            args.method.is_some()
                || args.server_name.is_some()
                || args.congestion_control.is_some()
                || args.certificate.is_some()
        }
    };
    if invalid {
        bail!(
            "one or more options are not supported by protocol {}",
            kind.name()
        );
    }
    Ok(())
}

fn update_kind(kind: &mut ProtocolKind, args: &ProtocolSet) -> Result<()> {
    match kind {
        ProtocolKind::Shadowsocks { method } => {
            if let Some(value) = &args.method {
                *method = value.clone();
            }
        }
        ProtocolKind::Hysteria2 { server_name, .. } => {
            if let Some(value) = &args.server_name {
                *server_name = value.clone();
            }
        }
        ProtocolKind::Tuic {
            server_name,
            congestion_control,
            ..
        } => {
            if let Some(value) = &args.server_name {
                *server_name = value.clone();
            }
            if let Some(value) = &args.congestion_control {
                *congestion_control = value.clone();
            }
        }
        ProtocolKind::VlessReality { server_name }
        | ProtocolKind::AnytlsReality { server_name } => {
            if let Some(value) = &args.server_name {
                *server_name = value.clone();
            }
        }
        ProtocolKind::VmessWs { path, host } => {
            if let Some(value) = &args.path {
                *path = value.clone();
            }
            if let Some(value) = &args.host {
                *host = (!value.is_empty()).then_some(value.clone());
            }
        }
    }
    Ok(())
}

fn import_certificate(
    config: &Config,
    tag: &str,
    certificate: &Option<PathBuf>,
    key: &Option<PathBuf>,
    kind: &mut ProtocolKind,
) -> Result<()> {
    let (Some(certificate), Some(key)) = (certificate, key) else {
        return Ok(());
    };
    let directory = Path::new(&config.sing_box.certificates_directory);
    let cert_target = directory.join(format!("{tag}.pem"));
    let key_target = directory.join(format!("{tag}.key"));
    write_private_atomic(
        &cert_target,
        &fs::read(certificate)
            .with_context(|| format!("failed to read {}", certificate.display()))?,
    )?;
    write_private_atomic(
        &key_target,
        &fs::read(key).with_context(|| format!("failed to read {}", key.display()))?,
    )?;
    let cert = cert_target.to_string_lossy().into_owned();
    let private = key_target.to_string_lossy().into_owned();
    match kind {
        ProtocolKind::Hysteria2 {
            certificate_path,
            key_path,
            ..
        }
        | ProtocolKind::Tuic {
            certificate_path,
            key_path,
            ..
        } => {
            *certificate_path = Some(cert);
            *key_path = Some(private);
            Ok(())
        }
        _ => bail!("external certificates are only supported by Hysteria2 and TUIC"),
    }
}

fn random_port(config: &Config) -> u16 {
    loop {
        let port = OsRng.gen_range(10000..=60000);
        if config.protocols.iter().all(|item| item.port != port) {
            return port;
        }
    }
}

fn display_endpoint(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

fn restore(path: &Path, bytes: Option<&[u8]>) -> Result<()> {
    match bytes {
        Some(bytes) => write_private_atomic(path, bytes),
        None => {
            if path.exists() {
                fs::remove_file(path)?;
            }
            Ok(())
        }
    }
}

struct DirectorySnapshot {
    existed: bool,
    files: Vec<(std::ffi::OsString, Vec<u8>)>,
}

fn snapshot_directory(path: &Path) -> Result<DirectorySnapshot> {
    if !path.exists() {
        return Ok(DirectorySnapshot {
            existed: false,
            files: vec![],
        });
    }
    let mut files = Vec::new();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_file() {
            files.push((entry.file_name(), fs::read(entry.path())?));
        }
    }
    Ok(DirectorySnapshot {
        existed: true,
        files,
    })
}

fn restore_directory(path: &Path, snapshot: &DirectorySnapshot) -> Result<()> {
    if path.exists() {
        fs::remove_dir_all(path)?;
    }
    if snapshot.existed {
        fs::create_dir_all(path)?;
        for (name, bytes) in &snapshot.files {
            write_private_atomic(&path.join(name), bytes)?;
        }
    }
    Ok(())
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
        fs::rename(&backup, &target).context("failed to restore previous TunnelAtlas binary")?;
        if let Ok(mut runtime) = RuntimeState::load(&runtime_path) {
            runtime.process_healthy = false;
            let _ = runtime.save(&runtime_path);
        }
        let _ = service::restart_and_check(Some(&runtime_path));
        return Err(error).context("TunnelAtlas update failed; previous binary restored");
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
                "--repository=https://dl-cdn.alpinelinux.org/alpine/edge/community",
                "sing-box",
            ])
            .status()?;
        if !status.success() {
            bail!("apk failed to update sing-box");
        }
    } else {
        let bytes = reqwest::get("https://sing-box.app/install.sh")
            .await?
            .error_for_status()?
            .bytes()
            .await?;
        let script =
            std::env::temp_dir().join(format!("sing-box-install-{}.sh", std::process::id()));
        write_private_atomic(&script, &bytes)?;
        let status = Command::new("bash").arg(&script).status()?;
        let _ = fs::remove_file(script);
        if !status.success() {
            bail!("official sing-box installer failed");
        }
    }
    match service::detect()? {
        service::InitSystem::Systemd => {
            let _ = Command::new("systemctl")
                .args(["disable", "--now", "sing-box.service"])
                .status();
        }
        service::InitSystem::OpenRc => {
            let _ = Command::new("rc-service")
                .args(["sing-box", "stop"])
                .status();
            let _ = Command::new("rc-update")
                .args(["del", "sing-box", "default"])
                .status();
        }
    }
    Ok(())
}

fn command_exists(command: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|path| path.join(command).is_file()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::SingBoxSettings;
    use std::collections::BTreeMap;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    #[cfg(unix)]
    async fn protocol_changes_persist_secrets_and_reject_invalid_updates() {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("sing-box");
        fs::write(&binary, "#!/bin/sh\nif [ \"$1\" = check ]; then exit 0; fi\nif [ \"$1\" = format ]; then exit 0; fi\nexit 0\n").unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        let config_path = directory.path().join("config.yaml");
        let config = Config {
            server_url: "https://example.com".into(),
            agent_name: "edge".into(),
            site_id: "home".into(),
            enrollment_token: None,
            report_interval_seconds: 60,
            labels: BTreeMap::new(),
            public_host: Some("proxy.example.com".into()),
            runtime_path: directory
                .path()
                .join("runtime.json")
                .to_string_lossy()
                .into(),
            sing_box: SingBoxSettings {
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
            protocols: vec![],
        };
        config.save(&config_path).unwrap();

        protocol(
            ProtocolCommand::Add(ProtocolAdd {
                protocol: ProtocolType::Ss,
                tag: Some("ss-in".into()),
                port: Some(18388),
                listen: "::".into(),
                method: None,
                server_name: None,
                congestion_control: None,
                path: None,
                host: None,
                certificate: None,
                key: None,
                no_restart: true,
            }),
            &config_path,
        )
        .await
        .unwrap();
        let saved = Config::load(&config_path).unwrap();
        assert_eq!(saved.protocols.len(), 1);
        let secret_path = Path::new(&saved.sing_box.secrets_path);
        let before = fs::read(secret_path).unwrap();
        assert_eq!(
            fs::metadata(secret_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&saved.sing_box.managed_config_path)
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );

        protocol(
            ProtocolCommand::Rotate(ProtocolTarget {
                tag: "ss-in".into(),
                no_restart: true,
            }),
            &config_path,
        )
        .await
        .unwrap();
        assert_ne!(fs::read(secret_path).unwrap(), before);

        let yaml_before = fs::read(&config_path).unwrap();
        let error = protocol(
            ProtocolCommand::Add(ProtocolAdd {
                protocol: ProtocolType::Vmess,
                tag: Some("vmess-in".into()),
                port: Some(18388),
                listen: "::".into(),
                method: None,
                server_name: None,
                congestion_control: None,
                path: None,
                host: None,
                certificate: None,
                key: None,
                no_restart: true,
            }),
            &config_path,
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("duplicate protocol port"));
        assert_eq!(fs::read(&config_path).unwrap(), yaml_before);
    }
}
