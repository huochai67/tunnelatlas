use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use tokio::time::{Duration, MissedTickBehavior};
use tunnelatlasd::{
    client::AtlasClient, config::Config, identity::Identity, sing_box::SingBoxSupervisor,
};

#[derive(Debug, Parser)]
#[command(
    name = "tunnelatlasd",
    version,
    about = "TunnelAtlas local reporting daemon"
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
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let config = Config::load(&cli.config)?;
    if matches!(cli.command, Command::Check) {
        let supervisor = SingBoxSupervisor::new(config.sing_box.clone());
        supervisor.validate_source().await?;
        println!("TunnelAtlas and sing-box configurations are valid");
        return Ok(());
    }

    let client = AtlasClient::new(&config.server_url)?;
    match cli.command {
        Command::Enroll => {
            enroll(&client, &config, &cli.identity).await?;
            println!("enrolled; identity saved to {}", cli.identity.display());
        }
        Command::ReportOnce => {
            let mut identity = Identity::load(&cli.identity)?;
            let mut supervisor = SingBoxSupervisor::new(config.sing_box.clone());
            supervisor.reconcile().await?;
            let tunnels = supervisor.discover_tunnels()?;
            let response = client
                .report(&config, &tunnels, &mut identity, &cli.identity)
                .await?;
            println!(
                "report accepted at sequence {} ({})",
                response.accepted_sequence, response.server_time
            );
        }
        Command::Run => run(client, config, cli.identity).await?,
        Command::Check => unreachable!(),
    }
    Ok(())
}

async fn enroll(client: &AtlasClient, config: &Config, identity_path: &Path) -> Result<()> {
    if identity_path.exists() {
        bail!(
            "identity already exists at {}; remove it only after revoking the agent",
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

async fn run(client: AtlasClient, config: Config, identity_path: PathBuf) -> Result<()> {
    if !identity_path.exists() {
        enroll(&client, &config, &identity_path).await?;
    }
    let mut identity = Identity::load(&identity_path)?;
    let mut supervisor = SingBoxSupervisor::new(config.sing_box.clone());
    supervisor.reconcile().await?;
    supervisor.start().await?;

    let mut report_interval =
        tokio::time::interval(Duration::from_secs(config.report_interval_seconds));
    report_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut reconcile_interval = tokio::time::interval(Duration::from_secs(
        supervisor.settings().reconcile_interval_seconds,
    ));
    reconcile_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut process_interval = tokio::time::interval(Duration::from_secs(2));
    process_interval.set_missed_tick_behavior(MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            _ = shutdown_signal() => {
                println!("shutdown requested");
                supervisor.stop().await?;
                return Ok(());
            }
            _ = report_interval.tick() => {
                let tunnels = supervisor.discover_tunnels()?;
                match client.report(&config, &tunnels, &mut identity, &identity_path).await {
                    Ok(response) => println!("report accepted: sequence={}", response.accepted_sequence),
                    Err(error) => eprintln!("report failed: {error:#}"),
                }
            }
            _ = reconcile_interval.tick() => {
                match supervisor.reconcile().await {
                    Ok(true) => {
                        println!("sing-box configuration changed; restarting managed process");
                        if let Err(error) = supervisor.restart().await {
                            eprintln!("sing-box restart failed: {error:#}");
                        }
                    }
                    Ok(false) => {}
                    Err(error) => eprintln!("sing-box configuration rejected; keeping current process: {error:#}"),
                }
            }
            _ = process_interval.tick() => {
                if let Some(exit) = supervisor.poll()? {
                    eprintln!("sing-box exited with {exit}; restarting after delay");
                    tokio::time::sleep(Duration::from_secs(supervisor.settings().restart_delay_seconds)).await;
                    if let Err(error) = supervisor.start().await {
                        eprintln!("sing-box start failed: {error:#}");
                    }
                } else if !supervisor.is_running() {
                    tokio::time::sleep(Duration::from_secs(supervisor.settings().restart_delay_seconds)).await;
                    if let Err(error) = supervisor.start().await {
                        eprintln!("sing-box start retry failed: {error:#}");
                    }
                }
            }
        }
    }
}

#[cfg(unix)]
async fn shutdown_signal() {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate()).expect("failed to install SIGTERM handler");
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
}

#[cfg(not(unix))]
async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}
