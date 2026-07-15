use std::path::Path;

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
        EnrollmentRequest, EnrollmentResponse, Platform, ReportRequest, ReportResponse,
        TunnelReport,
    },
    sing_box::ObservedTunnel,
};

pub struct AtlasClient {
    http: Client,
    server_url: String,
}

impl AtlasClient {
    pub fn new(server_url: &str) -> Result<Self> {
        Ok(Self {
            http: Client::builder()
                .user_agent(concat!("tunnelatlasd/", env!("CARGO_PKG_VERSION")))
                .build()?,
            server_url: server_url.trim_end_matches('/').to_owned(),
        })
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

    pub async fn report(
        &self,
        config: &Config,
        tunnels: &[ObservedTunnel],
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
