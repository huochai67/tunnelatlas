use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    path::Path,
    str::FromStr,
    time::Duration,
};

use anyhow::{Context, Result, bail};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use ed25519_dalek::{Signer, SigningKey};
use reqwest::Client;
use sha2::{Digest, Sha256};

use crate::{
    config::Config,
    identity::Identity,
    protocol::{
        ConfigApplyErrorCode, EnrollmentRequest, EnrollmentResponse, IpProbeResponse, Platform,
        ReportRequest, ReportResponse, TunnelReport,
    },
    sing_box::ObservedTunnel,
};

const USER_AGENT: &str = concat!("tunnelatlasd/", env!("CARGO_PKG_VERSION"));
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

pub struct AtlasClient {
    http: Client,
    http_v4: Option<Client>,
    http_v6: Option<Client>,
    server_url: String,
}

impl AtlasClient {
    pub fn new(server_url: &str) -> Result<Self> {
        let http = Client::builder().user_agent(USER_AGENT).build()?;
        let http_v4 = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(PROBE_TIMEOUT)
            .local_address(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
            .build()
            .ok();
        let http_v6 = Client::builder()
            .user_agent(USER_AGENT)
            .timeout(PROBE_TIMEOUT)
            .local_address(IpAddr::V6(Ipv6Addr::UNSPECIFIED))
            .build()
            .ok();
        Ok(Self {
            http,
            http_v4,
            http_v6,
            server_url: server_url.trim_end_matches('/').to_owned(),
        })
    }

    pub async fn probe_addresses(&self) -> (Option<String>, Option<String>) {
        let (v4, v6) = tokio::join!(
            probe_family(self.http_v4.as_ref(), &self.server_url, false),
            probe_family(self.http_v6.as_ref(), &self.server_url, true),
        );
        (v4, v6)
    }

    pub async fn enroll(
        &self,
        config: &Config,
        token: &str,
        key: &SigningKey,
    ) -> Result<EnrollmentResponse> {
        let public_key = URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes());
        let body = EnrollmentRequest {
            public_key: &public_key,
            platform: Platform {
                os: std::env::consts::OS,
                arch: std::env::consts::ARCH,
                agent_version: env!("CARGO_PKG_VERSION"),
            },
            labels: &config.labels,
        };
        let response = self
            .http
            .post(format!("{}/v1/enrollments:exchange", self.server_url))
            .header("Authorization", format!("Enrollment {token}"))
            .json(&body)
            .send()
            .await
            .context("enrollment request failed")?;
        if !response.status().is_success() {
            bail!(
                "enrollment rejected ({}): {}",
                response.status(),
                response.text().await.unwrap_or_default()
            );
        }
        response.json().await.context("invalid enrollment response")
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn report(
        &self,
        config: &Config,
        tunnels: &[ObservedTunnel],
        applied_config_version: Option<u64>,
        config_apply_error: Option<ConfigApplyErrorCode>,
        observed_ipv4: Option<&str>,
        observed_ipv6: Option<&str>,
        identity: &mut Identity,
        identity_path: &Path,
    ) -> Result<ReportResponse> {
        let path = "/v1/agent/report";
        let sequence = identity.take_sequence(identity_path)?;
        let timestamp = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let body = ReportRequest {
            agent_version: env!("CARGO_PKG_VERSION"),
            labels: &config.labels,
            tunnels: tunnels.iter().map(TunnelReport::from).collect(),
            applied_config_version,
            config_apply_error,
            observed_ipv4,
            observed_ipv6,
        };
        let bytes = serde_json::to_vec(&body)?;
        let body_hash = hex::encode(Sha256::digest(&bytes));
        let canonical = format!("POST\n{path}\n{timestamp}\n{sequence}\n{body_hash}");
        let signature = identity.signing_key()?.sign(canonical.as_bytes());

        let response = self
            .http
            .post(format!("{}{}", self.server_url, path))
            .header("Content-Type", "application/json")
            .header("X-Agent-ID", &identity.agent_id)
            .header("X-Timestamp", &timestamp)
            .header("X-Sequence", sequence)
            .header("X-Content-SHA256", body_hash)
            .header("X-Signature", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
            .body(bytes)
            .send()
            .await
            .context("report request failed")?;
        if !response.status().is_success() {
            bail!(
                "report rejected ({}): {}",
                response.status(),
                response.text().await.unwrap_or_default()
            );
        }
        response.json().await.context("invalid report response")
    }
}

async fn probe_family(client: Option<&Client>, server_url: &str, expect_v6: bool) -> Option<String> {
    let client = client?;
    let url = format!("{server_url}/v1/ip");
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload: IpProbeResponse = response.json().await.ok()?;
    let raw = payload.ip?;
    let trimmed = raw.trim();
    let bare = trimmed
        .strip_prefix('[')
        .and_then(|value| value.strip_suffix(']'))
        .unwrap_or(trimmed);
    let parsed = IpAddr::from_str(bare).ok()?;
    if parsed.is_ipv6() == expect_v6 {
        Some(bare.to_owned())
    } else {
        None
    }
}
