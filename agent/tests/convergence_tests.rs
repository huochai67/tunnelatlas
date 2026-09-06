use std::{
    collections::BTreeMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use tunnelatlasd::{
    config::Config,
    convergence,
    desired::{DesiredConfig, DesiredTunnel},
    protocol::{ConfigApplyErrorCode, ReportRequest},
    runtime::RuntimeState,
    secrets::SecretStore,
    sing_box::SingBoxSupervisor,
};

fn create_mock_singbox(dir: &Path, exit_on_run: bool) -> PathBuf {
    let script_path = dir.join("sing-box");
    let script = if exit_on_run {
        "#!/bin/sh\nif [ \"$1\" = check ]; then exit 0; fi\nif [ \"$1\" = format ]; then exit 0; fi\nexit 1\n"
    } else {
        "#!/bin/sh\nif [ \"$1\" = check ]; then exit 0; fi\nif [ \"$1\" = format ]; then exit 0; fi\nexec sleep 3600\n"
    };
    fs::write(&script_path, script).unwrap();
    fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755)).unwrap();
    script_path
}

fn create_invalid_mock_singbox(dir: &Path) -> PathBuf {
    let script_path = dir.join("sing-box-invalid");
    let script = "#!/bin/sh\nif [ \"$1\" = check ]; then exit 1; fi\nexit 0\n";
    fs::write(&script_path, script).unwrap();
    fs::set_permissions(&script_path, fs::Permissions::from_mode(0o755)).unwrap();
    script_path
}

fn test_config(dir: &Path, binary: &Path) -> (Config, PathBuf) {
    let config_path = dir.join("config.yaml");
    let yaml = format!(
        r#"
serverUrl: https://atlas.example
reportIntervalSeconds: 30
publicHost: legacy.host
singBox:
  binaryPath: "{}"
  managedConfigPath: "{}"
  secretsPath: "{}"
  certificatesDirectory: "{}"
  restartDelaySeconds: 1
  shutdownTimeoutSeconds: 1
runtimePath: "{}"
protocols:
  - legacy-proto
"#,
        binary.display(),
        dir.join("sing-box.json").display(),
        dir.join("secrets.json").display(),
        dir.join("certificates").display(),
        dir.join("runtime.json").display(),
    );
    fs::write(&config_path, yaml).unwrap();
    let config = Config::load(&config_path).unwrap();
    (config, config_path)
}

#[test]
fn report_request_serializes_uninitialized_as_explicit_null() {
    let labels = BTreeMap::new();
    let req = ReportRequest {
        agent_version: "0.1.0",
        labels: &labels,
        tunnels: vec![],
        applied_config_version: None,
        config_apply_error: None,
    };
    let json = serde_json::to_string(&req).unwrap();
    assert!(json.contains("\"appliedConfigVersion\":null"));
    assert!(!json.contains("configApplyError"));

    let req_with_error = ReportRequest {
        agent_version: "0.1.0",
        labels: &labels,
        tunnels: vec![],
        applied_config_version: Some(2),
        config_apply_error: Some(ConfigApplyErrorCode::SingBoxStartFailed),
    };
    let json_err = serde_json::to_string(&req_with_error).unwrap();
    assert!(json_err.contains("\"appliedConfigVersion\":2"));
    assert!(json_err.contains("\"configApplyError\":\"sing_box_start_failed\""));
}

#[tokio::test]
async fn converge_commits_desired_and_discards_legacy_yaml() {
    let temp = tempfile::tempdir().unwrap();
    let binary = create_mock_singbox(temp.path(), false);
    let (mut config, config_path) = test_config(temp.path(), &binary);
    let mut supervisor = SingBoxSupervisor::new(config.sing_box.clone());

    assert!(config.has_legacy_tunnels());

    let desired = DesiredConfig {
        version: 1,
        tunnels: vec![DesiredTunnel::Shadowsocks {
            id: "tun_1".into(),
            name: "ss-1".into(),
            listen: "::".into(),
            port: 8388,
            public_host: None,
            credential_generation: 1,
            method: "2022-blake3-aes-128-gcm".into(),
        }],
    };

    let outcome = convergence::converge(
        &mut config,
        &config_path,
        &desired,
        &mut supervisor,
        Some("203.0.113.8"),
    )
    .await
    .unwrap();

    assert!(outcome.applied);
    assert_eq!(outcome.tunnels.len(), 1);
    assert_eq!(outcome.tunnels[0].id, "tun_1");
    assert_eq!(outcome.tunnels[0].endpoint, "203.0.113.8:8388");

    // Supervisor is running
    assert!(supervisor.is_running());
    let _ = supervisor.stop().await;

    // Runtime state committed
    let runtime = RuntimeState::load(Path::new(&config.runtime_path)).unwrap();
    assert!(runtime.process_healthy);
    assert_eq!(runtime.applied_desired_config.unwrap().version, 1);
    assert_eq!(runtime.last_apply_error, None);

    // Legacy YAML discarded only after successful commit
    let saved_config = Config::load(&config_path).unwrap();
    assert!(!saved_config.has_legacy_tunnels());
    let raw_yaml = fs::read_to_string(&config_path).unwrap();
    assert!(!raw_yaml.contains("legacy.host"));
    assert!(!raw_yaml.contains("legacy-proto"));
}

#[tokio::test]
async fn converge_with_empty_desired_list_stops_child_and_commits() {
    let temp = tempfile::tempdir().unwrap();
    let binary = create_mock_singbox(temp.path(), false);
    let (mut config, config_path) = test_config(temp.path(), &binary);
    let mut supervisor = SingBoxSupervisor::new(config.sing_box.clone());

    // Pre-create managed config to verify it is NOT deleted
    let managed_path = PathBuf::from(&config.sing_box.managed_config_path);
    fs::write(&managed_path, b"{\"existing\":true}").unwrap();

    let desired = DesiredConfig {
        version: 0,
        tunnels: vec![],
    };

    let outcome = convergence::converge(&mut config, &config_path, &desired, &mut supervisor, None)
        .await
        .unwrap();

    assert!(outcome.applied);
    assert!(outcome.tunnels.is_empty());
    assert!(!supervisor.is_running());

    // Managed config is preserved for diagnostics
    assert!(managed_path.exists());

    // Runtime committed version 0 and process is healthy (ready)
    let runtime = RuntimeState::load(Path::new(&config.runtime_path)).unwrap();
    assert!(runtime.process_healthy);
    assert_eq!(runtime.applied_desired_config.unwrap().version, 0);
}

#[tokio::test]
async fn converge_validation_failure_restores_snapshots_and_preserves_legacy_yaml() {
    let temp = tempfile::tempdir().unwrap();
    let binary = create_invalid_mock_singbox(temp.path());
    let (mut config, config_path) = test_config(temp.path(), &binary);
    let mut supervisor = SingBoxSupervisor::new(config.sing_box.clone());

    let desired = DesiredConfig {
        version: 1,
        tunnels: vec![DesiredTunnel::Shadowsocks {
            id: "tun_1".into(),
            name: "ss-1".into(),
            listen: "::".into(),
            port: 8388,
            public_host: None,
            credential_generation: 1,
            method: "2022-blake3-aes-128-gcm".into(),
        }],
    };

    let err = convergence::converge(&mut config, &config_path, &desired, &mut supervisor, None)
        .await
        .unwrap_err();

    assert_eq!(err.0, ConfigApplyErrorCode::SingBoxValidationFailed);

    // Legacy YAML must still be byte-for-byte available!
    let saved_config = Config::load(&config_path).unwrap();
    assert!(saved_config.has_legacy_tunnels());
    let raw_yaml = fs::read_to_string(&config_path).unwrap();
    assert!(raw_yaml.contains("legacy.host"));
}

#[tokio::test]
async fn converge_startup_failure_restores_snapshots() {
    let temp = tempfile::tempdir().unwrap();
    let binary = create_mock_singbox(temp.path(), true); // exits with code 1 on run
    let (mut config, config_path) = test_config(temp.path(), &binary);
    let mut supervisor = SingBoxSupervisor::new(config.sing_box.clone());

    let desired = DesiredConfig {
        version: 1,
        tunnels: vec![DesiredTunnel::Shadowsocks {
            id: "tun_1".into(),
            name: "ss-1".into(),
            listen: "::".into(),
            port: 8388,
            public_host: None,
            credential_generation: 1,
            method: "2022-blake3-aes-128-gcm".into(),
        }],
    };

    let err = convergence::converge(&mut config, &config_path, &desired, &mut supervisor, None)
        .await
        .unwrap_err();

    assert_eq!(err.0, ConfigApplyErrorCode::SingBoxStartFailed);

    // Legacy YAML remains
    assert!(config.has_legacy_tunnels());
    let raw_yaml = fs::read_to_string(&config_path).unwrap();
    assert!(raw_yaml.contains("legacy.host"));
}

#[tokio::test]
async fn credential_rotation_rotates_only_targeted_tunnel() {
    let temp = tempfile::tempdir().unwrap();
    let binary = create_mock_singbox(temp.path(), false);
    let (mut config, config_path) = test_config(temp.path(), &binary);
    let mut supervisor = SingBoxSupervisor::new(config.sing_box.clone());

    let desired_v1 = DesiredConfig {
        version: 1,
        tunnels: vec![
            DesiredTunnel::Shadowsocks {
                id: "tun_1".into(),
                name: "ss-1".into(),
                listen: "::".into(),
                port: 8388,
                public_host: None,
                credential_generation: 1,
                method: "2022-blake3-aes-128-gcm".into(),
            },
            DesiredTunnel::Shadowsocks {
                id: "tun_2".into(),
                name: "ss-2".into(),
                listen: "::".into(),
                port: 8389,
                public_host: None,
                credential_generation: 1,
                method: "2022-blake3-aes-128-gcm".into(),
            },
        ],
    };

    convergence::converge(
        &mut config,
        &config_path,
        &desired_v1,
        &mut supervisor,
        None,
    )
    .await
    .unwrap();

    let secrets_v1 = SecretStore::load(Path::new(&config.sing_box.secrets_path)).unwrap();
    let secret_1_v1 = secrets_v1.protocols.get("tun_1").unwrap().clone();
    let secret_2_v1 = secrets_v1.protocols.get("tun_2").unwrap().clone();

    // Rotate only tun_1 (credential_generation 2)
    let desired_v2 = DesiredConfig {
        version: 2,
        tunnels: vec![
            DesiredTunnel::Shadowsocks {
                id: "tun_1".into(),
                name: "ss-1".into(),
                listen: "::".into(),
                port: 8388,
                public_host: None,
                credential_generation: 2,
                method: "2022-blake3-aes-128-gcm".into(),
            },
            DesiredTunnel::Shadowsocks {
                id: "tun_2".into(),
                name: "ss-2".into(),
                listen: "::".into(),
                port: 8389,
                public_host: None,
                credential_generation: 1,
                method: "2022-blake3-aes-128-gcm".into(),
            },
        ],
    };

    convergence::converge(
        &mut config,
        &config_path,
        &desired_v2,
        &mut supervisor,
        None,
    )
    .await
    .unwrap();

    let secrets_v2 = SecretStore::load(Path::new(&config.sing_box.secrets_path)).unwrap();
    let secret_1_v2 = secrets_v2.protocols.get("tun_1").unwrap().clone();
    let secret_2_v2 = secrets_v2.protocols.get("tun_2").unwrap().clone();

    // tun_1 rotated, tun_2 untouched!
    assert_ne!(secret_1_v1, secret_1_v2);
    assert_eq!(secret_2_v1, secret_2_v2);

    let _ = supervisor.stop().await;
}

#[tokio::test]
async fn empty_desired_config_keeps_readiness_without_child() {
    let temp = tempfile::tempdir().unwrap();
    let binary = create_mock_singbox(temp.path(), false);
    let (mut config, config_path) = test_config(temp.path(), &binary);
    let mut supervisor = SingBoxSupervisor::new(config.sing_box.clone());

    let desired = DesiredConfig {
        version: 0,
        tunnels: vec![],
    };

    let outcome = convergence::converge(&mut config, &config_path, &desired, &mut supervisor, None)
        .await
        .unwrap();

    assert!(outcome.applied);
    assert!(!supervisor.is_running());

    let runtime_path = PathBuf::from(&config.runtime_path);
    let runtime = RuntimeState::load(&runtime_path).unwrap();
    assert!(runtime.process_healthy);

    // Process is not running and expectations match: empty list expects no child
    let expects_child = match &runtime.applied_desired_config {
        Some(applied) => !applied.tunnels.is_empty(),
        None => false,
    };
    assert!(!expects_child);
}
