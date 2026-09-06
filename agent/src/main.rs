use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use fs2::FileExt;
use tokio::time::MissedTickBehavior;
use tunnelatlasd::{
    client::AtlasClient,
    config::Config,
    convergence,
    identity::Identity,
    manager::{self, ConfigCommand, ServiceCommand, UpdateCommand},
    render,
    runtime::RuntimeState,
    secrets::SecretStore,
    service,
    sing_box::SingBoxSupervisor,
};

#[derive(Debug, Parser)]
#[command(
    name = "tunnelatlasd",
    version,
    about = "TunnelAtlas node daemon and management CLI"
)]
struct Cli {
    #[arg(
        long,
        default_value = "/etc/tunnelatlas/config.yaml",
        env = "TUNNELATLAS_CONFIG"
    )]
    config: PathBuf,
    #[arg(
        long,
        default_value = "/var/lib/tunnelatlas/identity.json",
        env = "TUNNELATLAS_IDENTITY"
    )]
    identity: PathBuf,
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Enroll,
    ReportOnce,
    Run,
    Check,
    Manage,
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    Service {
        #[command(subcommand)]
        command: ServiceCommand,
    },
    Update {
        #[command(subcommand)]
        command: UpdateCommand,
    },
    Uninstall {
        #[arg(long)]
        with_sing_box: bool,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Command::Enroll => {
            let config = Config::load(&cli.config)?;
            let client = AtlasClient::new(&config.server_url)?;
            enroll(&client, &config, &cli.identity).await?;
            println!("enrolled; identity saved to {}", cli.identity.display());
        }
        Command::ReportOnce => {
            let config = Config::load(&cli.config)?;
            let client = AtlasClient::new(&config.server_url)?;
            report_once(&client, config, &cli.config, &cli.identity).await?;
        }
        Command::Run => {
            let config = Config::load(&cli.config)?;
            let client = AtlasClient::new(&config.server_url)?;
            run(client, config, cli.config, cli.identity).await?;
        }
        Command::Check => manager::config(ConfigCommand::Check, &cli.config).await?,
        Command::Manage => manager::manage(&cli.config, &cli.identity).await?,
        Command::Config { command } => manager::config(command, &cli.config).await?,
        Command::Service { command } => manager::service_command(command)?,
        Command::Update { command } => manager::update(command, &cli.config).await?,
        Command::Uninstall { with_sing_box } => {
            manager::uninstall(&cli.config, &cli.identity, with_sing_box)?
        }
    }
    Ok(())
}

async fn enroll(client: &AtlasClient, config: &Config, identity_path: &Path) -> Result<()> {
    if identity_path.exists() {
        bail!(
            "identity already exists at {}; clean installation required",
            identity_path.display()
        );
    }
    let token = config
        .enrollment_token
        .as_deref()
        .context("enrollmentToken is required for enrollment")?;
    let (key, _) = Identity::generate_pending();
    let response = client.enroll(config, token, &key).await?;
    Identity::from_enrollment(response.agent_id, &key).save(identity_path)
}

async fn report_once(
    client: &AtlasClient,
    mut config: Config,
    config_path: &Path,
    identity_path: &Path,
) -> Result<()> {
    if service::is_active()? {
        bail!("cannot run report-once while TunnelAtlas service is active");
    }

    let lock_path = Path::new(&config.sing_box.secrets_path)
        .parent()
        .unwrap_or(Path::new("/var/lib/tunnelatlas"))
        .join("control.lock");
    if let Some(parent) = lock_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let lock_file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)?;
    lock_file
        .lock_exclusive()
        .context("failed to acquire control.lock")?;

    let mut identity = Identity::load(identity_path)?;
    let runtime_path = PathBuf::from(&config.runtime_path);
    let runtime = RuntimeState::load(&runtime_path).unwrap_or_default();

    let (initial_tunnels, initial_version) = if let Some(applied) = &runtime.applied_desired_config
    {
        let secrets =
            SecretStore::load(Path::new(&config.sing_box.secrets_path)).unwrap_or_default();
        let rendered = render::render_desired(
            &applied.tunnels,
            &secrets,
            Path::new(&config.sing_box.certificates_directory),
            runtime.observed_address.as_deref(),
            "stopped",
        )?;
        (rendered.tunnels, Some(applied.version))
    } else {
        (vec![], None)
    };

    let response = client
        .report(
            &config,
            &initial_tunnels,
            initial_version,
            runtime.last_apply_error,
            &mut identity,
            identity_path,
        )
        .await?;

    let mut supervisor = SingBoxSupervisor::new(config.sing_box.clone());
    let mut current_runtime = RuntimeState::load(&runtime_path).unwrap_or_default();
    if response.observed_address.is_some() {
        current_runtime.observed_address = response.observed_address.clone();
        let _ = current_runtime.save(&runtime_path);
    }

    let need_converge = match &current_runtime.applied_desired_config {
        None => true,
        Some(applied) => response.desired_config.version > applied.version,
    };

    if need_converge {
        let _outcome = convergence::converge(
            &mut config,
            config_path,
            &response.desired_config,
            &mut supervisor,
            current_runtime.observed_address.as_deref(),
        )
        .await
        .map_err(|(code, err)| anyhow::anyhow!("convergence failed ({:?}): {err}", code))?;

        let _ = supervisor.stop().await;

        let secrets =
            SecretStore::load(Path::new(&config.sing_box.secrets_path)).unwrap_or_default();
        let rendered = render::render_desired(
            &response.desired_config.tunnels,
            &secrets,
            Path::new(&config.sing_box.certificates_directory),
            current_runtime.observed_address.as_deref(),
            "stopped",
        )?;
        let _ = client
            .report(
                &config,
                &rendered.tunnels,
                Some(response.desired_config.version),
                None,
                &mut identity,
                identity_path,
            )
            .await?;
    } else {
        let _ = supervisor.stop().await;
    }

    println!(
        "report accepted at sequence {} ({})",
        response.accepted_sequence, response.server_time
    );
    Ok(())
}

async fn run(
    client: AtlasClient,
    mut config: Config,
    config_path: PathBuf,
    identity_path: PathBuf,
) -> Result<()> {
    if !identity_path.exists() {
        enroll(&client, &config, &identity_path).await?;
    }
    let mut identity = Identity::load(&identity_path)?;
    let runtime_path = PathBuf::from(&config.runtime_path);
    let mut runtime = RuntimeState::load(&runtime_path).unwrap_or_default();
    let mut supervisor = SingBoxSupervisor::new(config.sing_box.clone());

    if let Some(cached) = &runtime.applied_desired_config {
        if config.has_legacy_tunnels() {
            config.clear_legacy_tunnels();
            let _ = config.save(&config_path);
        }
        if !cached.tunnels.is_empty() {
            let secrets = SecretStore::load(Path::new(&config.sing_box.secrets_path))?;
            let rendered = render::render_desired(
                &cached.tunnels,
                &secrets,
                Path::new(&config.sing_box.certificates_directory),
                runtime.observed_address.as_deref(),
                "healthy",
            )?;
            supervisor.prepare(&rendered.bytes).await?;
            supervisor.start().await?;
            tokio::time::sleep(Duration::from_millis(500)).await;
            if let Some(exit) = supervisor.poll()? {
                bail!("sing-box exited during startup with {exit}");
            }
        }
        runtime.process_healthy = true;
        let _ = runtime.save(&runtime_path);
    } else {
        let managed_path = Path::new(&config.sing_box.managed_config_path);
        if managed_path.exists() {
            let _ = supervisor.start().await;
            tokio::time::sleep(Duration::from_millis(500)).await;
            if let Some(exit) = supervisor.poll()? {
                bail!("sing-box exited during startup with {exit}");
            }
        }
        runtime.process_healthy = true;
        let _ = runtime.save(&runtime_path);
    }

    let mut report_interval =
        tokio::time::interval(Duration::from_secs(config.report_interval_seconds));
    report_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut process_interval = tokio::time::interval(Duration::from_secs(2));
    process_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = shutdown_signal() => {
                println!("shutdown requested");
                let mut runtime = RuntimeState::load(&runtime_path).unwrap_or_default();
                runtime.process_healthy = false;
                let _ = runtime.save(&runtime_path);
                supervisor.stop().await?;
                return Ok(());
            }
            _ = report_interval.tick() => {
                let runtime = RuntimeState::load(&runtime_path).unwrap_or_default();
                let (tunnels, applied_version) = if let Some(applied) = &runtime.applied_desired_config {
                    let secrets = SecretStore::load(Path::new(&config.sing_box.secrets_path)).unwrap_or_default();
                    let rendered = render::render_desired(
                        &applied.tunnels,
                        &secrets,
                        Path::new(&config.sing_box.certificates_directory),
                        runtime.observed_address.as_deref(),
                        supervisor.status().as_str(),
                    );
                    match rendered {
                        Ok(r) => (r.tunnels, Some(applied.version)),
                        Err(e) => {
                            eprintln!("failed to render observed tunnels: {e:#}");
                            (vec![], Some(applied.version))
                        }
                    }
                } else {
                    (vec![], None)
                };

                match client.report(&config, &tunnels, applied_version, runtime.last_apply_error, &mut identity, &identity_path).await {
                    Ok(response) => {
                        let mut runtime = RuntimeState::load(&runtime_path).unwrap_or_default();
                        if response.observed_address.is_some() {
                            runtime.observed_address = response.observed_address;
                            let _ = runtime.save(&runtime_path);
                        }
                        println!("report accepted: sequence={}", response.accepted_sequence);

                        let need_converge = match &runtime.applied_desired_config {
                            None => true,
                            Some(applied) => response.desired_config.version > applied.version,
                        };
                        if let Some(applied) = &runtime.applied_desired_config
                            && response.desired_config.version < applied.version
                        {
                            eprintln!(
                                "warning: Worker returned stale desired version {} (local is {})",
                                response.desired_config.version, applied.version
                            );
                        }

                        if need_converge {
                            match convergence::converge(
                                &mut config,
                                &config_path,
                                &response.desired_config,
                                &mut supervisor,
                                runtime.observed_address.as_deref(),
                            ).await {
                                Ok(outcome) => {
                                    println!("desired config version {} applied successfully", response.desired_config.version);
                                    let mut runtime = RuntimeState::load(&runtime_path).unwrap_or_default();
                                    runtime.applied_desired_config = Some(response.desired_config.clone());
                                    runtime.last_apply_error = None;
                                    runtime.process_healthy = true;
                                    let _ = runtime.save(&runtime_path);

                                    let ack = client.report(
                                        &config,
                                        &outcome.tunnels,
                                        Some(response.desired_config.version),
                                        None,
                                        &mut identity,
                                        &identity_path,
                                    ).await;
                                    if let Err(e) = ack {
                                        eprintln!("acknowledgement report failed: {e:#}");
                                    }
                                }
                                Err((err_code, err)) => {
                                    eprintln!("convergence failed: {err:#}");
                                    let mut runtime = RuntimeState::load(&runtime_path).unwrap_or_default();
                                    runtime.last_apply_error = Some(err_code);
                                    let _ = runtime.save(&runtime_path);
                                }
                            }
                        }
                    }
                    Err(error) => eprintln!("report failed: {error:#}"),
                }
            }
            _ = process_interval.tick() => {
                let runtime = RuntimeState::load(&runtime_path).unwrap_or_default();
                let expects_child = match &runtime.applied_desired_config {
                    Some(applied) => !applied.tunnels.is_empty(),
                    None => Path::new(&config.sing_box.managed_config_path).exists(),
                };

                if expects_child {
                    if let Some(exit) = supervisor.poll()? {
                        eprintln!("sing-box exited with {exit}; restarting after delay");
                        tokio::time::sleep(Duration::from_secs(supervisor.settings().restart_delay_seconds)).await;
                        let _ = supervisor.start().await;
                    } else if !supervisor.is_running() {
                        tokio::time::sleep(Duration::from_secs(supervisor.settings().restart_delay_seconds)).await;
                        let _ = supervisor.start().await;
                    }
                }
            }
        }
    }
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut sigint = signal(SignalKind::interrupt()).expect("SIGINT listener");
    let mut sigterm = signal(SignalKind::terminate()).expect("SIGTERM listener");
    tokio::select! {
        _ = sigint.recv() => {}
        _ = sigterm.recv() => {}
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
