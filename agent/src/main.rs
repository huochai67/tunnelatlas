use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use tokio::time::{Duration, MissedTickBehavior};
use tunnelatlasd::{
    client::AtlasClient,
    config::Config,
    identity::Identity,
    manager::{self, ConfigCommand, ProtocolCommand, ServiceCommand, UpdateCommand},
    render,
    runtime::RuntimeState,
    secrets::SecretStore,
    sing_box::SingBoxSupervisor,
};

#[derive(Debug, Parser)]
#[command(
    name = "tunnelatlasd",
    version,
    about = "TunnelAtlas sing-box management agent"
)]
struct Cli {
    #[arg(
        short,
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
    Protocol {
        #[command(subcommand)]
        command: Box<ProtocolCommand>,
    },
    Links,
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
            report_once(&client, &config, &cli.identity).await?;
        }
        Command::Run => {
            let config = Config::load(&cli.config)?;
            let client = AtlasClient::new(&config.server_url)?;
            run(client, config, cli.identity).await?;
        }
        Command::Check => manager::config(ConfigCommand::Check, &cli.config).await?,
        Command::Manage => manager::manage(&cli.config, &cli.identity).await?,
        Command::Protocol { command } => manager::protocol(*command, &cli.config).await?,
        Command::Links => manager::show_links(&cli.config)?,
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

async fn prepared(
    config: &Config,
    status: &str,
) -> Result<(SecretStore, render::RenderedConfig, SingBoxSupervisor)> {
    let secrets_path = Path::new(&config.sing_box.secrets_path);
    let mut secrets = SecretStore::load(secrets_path)?;
    secrets.reconcile(config)?;
    secrets.save(secrets_path)?;
    let rendered = render::render(config, &secrets, status)?;
    let supervisor = SingBoxSupervisor::new(config.sing_box.clone());
    supervisor.prepare(&rendered.bytes).await?;
    Ok((secrets, rendered, supervisor))
}

async fn report_once(client: &AtlasClient, config: &Config, identity_path: &Path) -> Result<()> {
    let mut identity = Identity::load(identity_path)?;
    let (_, rendered, _) = prepared(config, "stopped").await?;
    let response = client
        .report(config, &rendered.tunnels, &mut identity, identity_path)
        .await?;
    save_runtime(config, response.observed_address)?;
    println!(
        "report accepted at sequence {} ({})",
        response.accepted_sequence, response.server_time
    );
    Ok(())
}

async fn run(client: AtlasClient, config: Config, identity_path: PathBuf) -> Result<()> {
    if !identity_path.exists() {
        enroll(&client, &config, &identity_path).await?;
    }
    let mut identity = Identity::load(&identity_path)?;
    set_process_health(&config, false)?;
    let (secrets, _, mut supervisor) = prepared(&config, "healthy").await?;
    supervisor.start().await?;
    tokio::time::sleep(Duration::from_millis(500)).await;
    if let Some(exit) = supervisor.poll()? {
        bail!("sing-box exited during startup with {exit}");
    }
    set_process_health(&config, true)?;

    let mut report_interval =
        tokio::time::interval(Duration::from_secs(config.report_interval_seconds));
    report_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut process_interval = tokio::time::interval(Duration::from_secs(2));
    process_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = shutdown_signal() => {
                println!("shutdown requested");
                let _ = set_process_health(&config, false);
                supervisor.stop().await?;
                return Ok(());
            }
            _ = report_interval.tick() => {
                let rendered = render::render(&config, &secrets, supervisor.status().as_str())?;
                match client.report(&config, &rendered.tunnels, &mut identity, &identity_path).await {
                    Ok(response) => {
                        if let Err(error) = save_runtime(&config, response.observed_address) { eprintln!("runtime state save failed: {error:#}"); }
                        println!("report accepted: sequence={}", response.accepted_sequence);
                    }
                    Err(error) => eprintln!("report failed: {error:#}"),
                }
            }
            _ = process_interval.tick() => {
                if let Some(exit) = supervisor.poll()? {
                    eprintln!("sing-box exited with {exit}; restarting after delay");
                    let _ = set_process_health(&config, false);
                    tokio::time::sleep(Duration::from_secs(supervisor.settings().restart_delay_seconds)).await;
                    restore_and_start(&config, &secrets, &mut supervisor).await;
                } else if !supervisor.is_running() {
                    tokio::time::sleep(Duration::from_secs(supervisor.settings().restart_delay_seconds)).await;
                    restore_and_start(&config, &secrets, &mut supervisor).await;
                }
            }
        }
    }
}

async fn restore_and_start(
    config: &Config,
    secrets: &SecretStore,
    supervisor: &mut SingBoxSupervisor,
) {
    let result = async {
        let rendered = render::render(config, secrets, "healthy")?;
        supervisor.prepare(&rendered.bytes).await?;
        supervisor.start().await
    }
    .await;
    if let Err(error) = result {
        eprintln!("sing-box start retry failed: {error:#}");
    } else if let Err(error) = set_process_health(config, true) {
        eprintln!("runtime state save failed: {error:#}");
    }
}

fn save_runtime(config: &Config, observed_address: Option<String>) -> Result<()> {
    let path = Path::new(&config.runtime_path);
    let mut runtime = RuntimeState::load(path)?;
    if observed_address.is_some() {
        runtime.observed_address = observed_address;
    }
    runtime.save(path)
}

fn set_process_health(config: &Config, healthy: bool) -> Result<()> {
    let path = Path::new(&config.runtime_path);
    let mut runtime = RuntimeState::load(path)?;
    runtime.process_healthy = healthy;
    runtime.save(path)
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate()).expect("failed to install SIGTERM handler");
    tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
