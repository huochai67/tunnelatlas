use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::sing_box::ObservedTunnel;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentRequest<'a> {
    pub name: &'a str,
    pub site_id: &'a str,
    pub public_key: &'a str,
    pub platform: Platform,
    pub labels: &'a BTreeMap<String, String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Platform {
    pub os: &'static str,
    pub arch: &'static str,
    pub agent_version: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrollmentResponse {
    pub agent_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportRequest<'a> {
    pub agent_version: &'static str,
    pub labels: &'a BTreeMap<String, String>,
    pub tunnels: Vec<TunnelReport<'a>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelReport<'a> {
    pub id: &'a str,
    pub name: &'a str,
    pub kind: &'a str,
    pub endpoint: &'a str,
    pub protocol: &'a str,
    pub status: &'a str,
    pub metadata: &'a Value,
    pub authentication: &'a Value,
}

impl<'a> From<&'a ObservedTunnel> for TunnelReport<'a> {
    fn from(value: &'a ObservedTunnel) -> Self {
        Self {
            id: &value.id,
            name: &value.name,
            kind: &value.kind,
            endpoint: &value.endpoint,
            protocol: &value.protocol,
            status: &value.status,
            metadata: &value.metadata,
            authentication: &value.authentication,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportResponse {
    pub accepted_sequence: u64,
    pub server_time: String,
}
