export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  READ_TOKEN: string;
  ENROLLMENT_PEPPER: string;
  CREDENTIALS_KEY: string;
  AGENT_OFFLINE_SECONDS?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ZONE_NAME?: string;
  CLOUDFLARE_PREFERRED_ADDRESS?: string;
}

export interface CloudflareFrontendState {
  hostname: string;
  status: string;
  sourceEndpoint: string;
  error: string | null;
  updatedAt: string | null;
}

export interface EnrollmentBody {
  publicKey: string;
  platform: { os: string; arch: string; agentVersion: string };
  labels?: Record<string, string>;
}

export type ConfigApplyErrorCode =
  | "invalid_desired_config"
  | "sing_box_validation_failed"
  | "sing_box_start_failed"
  | "local_apply_failed";

export interface ReportBody {
  agentVersion: string;
  labels?: Record<string, string>;
  tunnels: TunnelBody[];
  appliedConfigVersion?: number | null;
  configApplyError?: ConfigApplyErrorCode | null;
}

export interface TunnelBody {
  id: string;
  name: string;
  kind: string;
  endpoint: string;
  protocol: string;
  status: "healthy" | "degraded" | "failed" | "unknown" | "stopped";
  metadata?: unknown;
  authentication?: unknown;
}

export interface AgentRow {
  id: string;
  public_key: string;
  last_sequence: number;
}

export type DesiredTunnelType =
  | "shadowsocks"
  | "hysteria2"
  | "tuic"
  | "vless-reality"
  | "anytls-reality"
  | "vmess-ws";

export interface StoredCredentials {
  password?: string;
  uuid?: string;
  privateKey?: string;
  publicKey?: string;
  shortId?: string;
  name?: string;
}

export interface HopRef {
  nodeId: string;
  tunnelId: string;
}

export type DesiredHop =
  | {
    nodeId: string;
    tunnelId: string;
    tag: string;
    type: DesiredTunnelType;
    status: "pending";
    port: number;
  }
  | DesiredReadyHop;

export type DesiredReadyHop =
  | {
    nodeId: string;
    tunnelId: string;
    tag: string;
    status: "ready";
    type: "shadowsocks";
    server: string;
    port: number;
    method: string;
    password: string;
  }
  | {
    nodeId: string;
    tunnelId: string;
    tag: string;
    status: "ready";
    type: "hysteria2";
    server: string;
    port: number;
    password: string;
    tls: { serverName: string; insecure: true; alpn: string[] };
  }
  | {
    nodeId: string;
    tunnelId: string;
    tag: string;
    status: "ready";
    type: "tuic";
    server: string;
    port: number;
    uuid: string;
    password: string;
    congestionControl: string;
    tls: { serverName: string; insecure: true; alpn: string[] };
  }
  | {
    nodeId: string;
    tunnelId: string;
    tag: string;
    status: "ready";
    type: "vless-reality";
    server: string;
    port: number;
    uuid: string;
    flow: "xtls-rprx-vision";
    tls: { serverName: string; reality: { publicKey: string; shortId: string } };
  }
  | {
    nodeId: string;
    tunnelId: string;
    tag: string;
    status: "ready";
    type: "anytls-reality";
    server: string;
    port: number;
    password: string;
    tls: { serverName: string; reality: { publicKey: string; shortId: string } };
  }
  | {
    nodeId: string;
    tunnelId: string;
    tag: string;
    status: "ready";
    type: "vmess-ws";
    server: string;
    port: number;
    uuid: string;
    tls?: { serverName: string };
    transport: { type: "ws"; path: string; host?: string };
  };

export interface DesiredTunnelBase {
  id: string;
  name: string;
  type: DesiredTunnelType;
  listen: string;
  port: number;
  publicHost: string | null;
  credentialGeneration: number;
  credentials?: StoredCredentials;
  hops?: DesiredHop[];
}

export interface ShadowsocksDesiredTunnel extends DesiredTunnelBase {
  type: "shadowsocks";
  method: string;
}

export interface Hysteria2DesiredTunnel extends DesiredTunnelBase {
  type: "hysteria2";
  serverName: string;
}

export interface TuicDesiredTunnel extends DesiredTunnelBase {
  type: "tuic";
  serverName: string;
  congestionControl: string;
}

export interface VlessRealityDesiredTunnel extends DesiredTunnelBase {
  type: "vless-reality";
  serverName: string;
}

export interface AnytlsRealityDesiredTunnel extends DesiredTunnelBase {
  type: "anytls-reality";
  serverName: string;
}

export interface VmessWsDesiredTunnel extends DesiredTunnelBase {
  type: "vmess-ws";
  path: string;
  host: string | null;
}

export type DesiredTunnel =
  | ShadowsocksDesiredTunnel
  | Hysteria2DesiredTunnel
  | TuicDesiredTunnel
  | VlessRealityDesiredTunnel
  | AnytlsRealityDesiredTunnel
  | VmessWsDesiredTunnel;

export interface DesiredConfig {
  version: number;
  tunnels: DesiredTunnel[];
}

export interface ReportResponse {
  acceptedSequence: number;
  serverTime: string;
  observedAddress: string | null;
  desiredConfig: DesiredConfig;
}

export interface CreateTunnelConfigInput {
  name: string;
  type: DesiredTunnelType;
  listen?: string;
  port: number;
  publicHost?: string | null;
  method?: string;
  serverName?: string;
  congestionControl?: string;
  path?: string;
  host?: string | null;
  hops?: HopRef[];
}

export interface UpdateTunnelConfigInput {
  name: string;
  type: DesiredTunnelType;
  listen?: string;
  port: number;
  publicHost?: string | null;
  method?: string;
  serverName?: string;
  congestionControl?: string;
  path?: string;
  host?: string | null;
  hops?: HopRef[];
}

export interface PatchTunnelConfigInput {
  subscriptionEnabled: boolean;
}

export interface TunnelConfigRow {
  node_id: string;
  id: string;
  name: string;
  type: DesiredTunnelType;
  listen: string;
  port: number;
  public_host: string | null;
  options_json: string;
  credential_generation: number;
  subscription_enabled: number;
  credentials_ciphertext: string | null;
  created_at: string;
  updated_at: string;
}
