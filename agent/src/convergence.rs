use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Result, bail};
use fs2::FileExt;

use crate::{
    config::{Config, write_private_atomic},
    desired::DesiredConfig,
    protocol::ConfigApplyErrorCode,
    render,
    runtime::RuntimeState,
    secrets::SecretStore,
    sing_box::{ObservedTunnel, SingBoxSupervisor},
};

pub struct DirectorySnapshot {
    pub existed: bool,
    pub files: Vec<(OsString, Vec<u8>)>,
}

pub fn snapshot_directory(path: &Path) -> Result<DirectorySnapshot> {
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

pub fn restore_directory(path: &Path, snapshot: &DirectorySnapshot) -> Result<()> {
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

pub fn restore_file(path: &Path, content: Option<&[u8]>) -> Result<()> {
    match content {
        Some(bytes) => write_private_atomic(path, bytes),
        None => {
            if path.exists() {
                let _ = fs::remove_file(path);
            }
            Ok(())
        }
    }
}

#[derive(Debug)]
pub struct ConvergenceResult {
    pub applied: bool,
    pub tunnels: Vec<ObservedTunnel>,
}

pub async fn converge(
    config: &mut Config,
    config_path: &Path,
    desired: &DesiredConfig,
    supervisor: &mut SingBoxSupervisor,
    observed_address: Option<&str>,
) -> Result<ConvergenceResult, (ConfigApplyErrorCode, anyhow::Error)> {
    let lock_path = Path::new(&config.sing_box.secrets_path)
        .parent()
        .unwrap_or(Path::new("/var/lib/tunnelatlas"))
        .join("control.lock");
    if let Some(parent) = lock_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let lock_file = match fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
    {
        Ok(f) => f,
        Err(e) => return Err((ConfigApplyErrorCode::LocalApplyFailed, e.into())),
    };
    if let Err(e) = lock_file.lock_exclusive() {
        return Err((ConfigApplyErrorCode::LocalApplyFailed, e.into()));
    }

    if let Err(err) = desired.validate() {
        return Err((ConfigApplyErrorCode::InvalidDesiredConfig, err));
    }

    let secrets_path = PathBuf::from(&config.sing_box.secrets_path);
    let managed_path = PathBuf::from(&config.sing_box.managed_config_path);
    let certs_path = PathBuf::from(&config.sing_box.certificates_directory);
    let runtime_path = PathBuf::from(&config.runtime_path);

    let old_config = fs::read(config_path).ok();
    let old_secrets = fs::read(&secrets_path).ok();
    let old_managed = fs::read(&managed_path).ok();
    let old_certs = match snapshot_directory(&certs_path) {
        Ok(s) => s,
        Err(e) => return Err((ConfigApplyErrorCode::LocalApplyFailed, e)),
    };
    let old_runtime = fs::read(&runtime_path).ok();
    let was_running = supervisor.is_running();

    if desired.tunnels.is_empty() {
        if let Err(err) = supervisor.stop().await {
            return Err((ConfigApplyErrorCode::LocalApplyFailed, err));
        }
        let mut runtime = RuntimeState::load(&runtime_path).unwrap_or_default();
        runtime.applied_desired_config = Some(desired.clone());
        runtime.last_apply_error = None;
        runtime.process_healthy = true;
        if let Err(err) = runtime.save(&runtime_path) {
            return Err((ConfigApplyErrorCode::LocalApplyFailed, err));
        }
        if config.clear_legacy_tunnels() {
            if let Err(err) = config.save(config_path) {
                return Err((ConfigApplyErrorCode::LocalApplyFailed, err));
            }
            println!("local tunnel configuration was discarded; tunnels are managed by the Worker");
        }
        return Ok(ConvergenceResult {
            applied: true,
            tunnels: vec![],
        });
    }

    let mut staged_secrets = SecretStore::load(&secrets_path).unwrap_or_default();
    if let Err(err) = staged_secrets.reconcile_desired(&desired.tunnels, &certs_path) {
        let _ = restore_directory(&certs_path, &old_certs);
        return Err((ConfigApplyErrorCode::LocalApplyFailed, err));
    }

    let rendered = match render::render_desired(
        &desired.tunnels,
        &staged_secrets,
        &certs_path,
        observed_address,
        "healthy",
    ) {
        Ok(r) => r,
        Err(err) => {
            let _ = restore_directory(&certs_path, &old_certs);
            return Err((ConfigApplyErrorCode::LocalApplyFailed, err));
        }
    };

    if let Err(err) = supervisor.prepare(&rendered.bytes).await {
        let _ = restore_directory(&certs_path, &old_certs);
        return Err((ConfigApplyErrorCode::SingBoxValidationFailed, err));
    }

    let swap_and_start = async {
        write_private_atomic(&managed_path, &rendered.bytes)?;
        if was_running {
            supervisor.restart().await?;
        } else {
            supervisor.start().await?;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        if let Some(exit) = supervisor.poll()? {
            bail!("sing-box exited during startup with {exit}");
        }
        staged_secrets.save(&secrets_path)?;
        let mut runtime = RuntimeState::load(&runtime_path).unwrap_or_default();
        runtime.applied_desired_config = Some(desired.clone());
        runtime.last_apply_error = None;
        runtime.process_healthy = true;
        runtime.save(&runtime_path)?;

        if config.clear_legacy_tunnels() {
            config.save(config_path)?;
            println!("local tunnel configuration was discarded; tunnels are managed by the Worker");
        }
        Ok::<(), anyhow::Error>(())
    }
    .await;

    if let Err(err) = swap_and_start {
        let _ = restore_file(config_path, old_config.as_deref());
        let _ = restore_file(&secrets_path, old_secrets.as_deref());
        let _ = restore_file(&managed_path, old_managed.as_deref());
        let _ = restore_directory(&certs_path, &old_certs);
        let _ = restore_file(&runtime_path, old_runtime.as_deref());
        if was_running {
            let _ = supervisor.start().await;
        }
        let code = if err.to_string().contains("sing-box exited during startup")
            || err.to_string().contains("start")
        {
            ConfigApplyErrorCode::SingBoxStartFailed
        } else {
            ConfigApplyErrorCode::LocalApplyFailed
        };
        return Err((code, err));
    }

    Ok(ConvergenceResult {
        applied: true,
        tunnels: rendered.tunnels,
    })
}
