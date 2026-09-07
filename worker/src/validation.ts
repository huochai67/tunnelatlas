import { base64UrlToBytes } from "./crypto";
import { validFrontendAddress, validIpAddress, validWebSocketPath } from "./endpoints";
import { HttpError } from "./http";
import type {
  ConfigApplyErrorCode,
  DesiredTunnel,
  DesiredTunnelType,
  EnrollmentBody,
  HopRef,
  ReportBody,
  TunnelBody,
  TunnelConfigRow,
} from "./types";
const STATUS = new Set(["healthy", "degraded", "failed", "unknown", "stopped"]);
const AUTH_FIELDS = new Set(["name", "username", "password", "uuid", "flow", "token"]);
const CONFIG_APPLY_ERRORS: Record<ConfigApplyErrorCode, true> = {
  invalid_desired_config: true,
  sing_box_validation_failed: true,
  sing_box_start_failed: true,
  local_apply_failed: true,
};
const TUNNEL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TUNNEL_TYPES: Record<DesiredTunnelType, true> = {
  shadowsocks: true,
  hysteria2: true,
  tuic: true,
  "vless-reality": true,
  "anytls-reality": true,
  "vmess-ws": true,
};
const SS_METHODS: Record<string, true> = {
  "2022-blake3-aes-128-gcm": true,
  "2022-blake3-aes-256-gcm": true,
  "2022-blake3-chacha20-poly1305": true,
};
const TUIC_CONGESTION: Record<string, true> = {
  bbr: true,
  cubic: true,
  new_reno: true,
};

function text(value: unknown, name: string, max = 255): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new HttpError(400, `Invalid ${name}`);
}

export function validateEnrollment(body: EnrollmentBody): void {
  if (!body || typeof body !== "object") throw new HttpError(400, "Invalid enrollment");
  text(body.publicKey, "publicKey", 128);
  try {
    if (base64UrlToBytes(body.publicKey).byteLength !== 32) throw new Error("wrong length");
  } catch {
    throw new HttpError(400, "publicKey must be an Ed25519 public key");
  }
  if (!body.platform || typeof body.platform !== "object") throw new HttpError(400, "Invalid platform");
  text(body.platform.os, "platform.os", 64);
  text(body.platform.arch, "platform.arch", 64);
  text(body.platform.agentVersion, "platform.agentVersion", 64);
}

function validateTunnel(tunnel: TunnelBody): void {
  text(tunnel.id, "tunnel.id", 128);
  text(tunnel.name, "tunnel.name");
  text(tunnel.kind, "tunnel.kind", 64);
  text(tunnel.endpoint, "tunnel.endpoint", 2048);
  text(tunnel.protocol, "tunnel.protocol", 32);
  if (!STATUS.has(tunnel.status)) throw new HttpError(400, "Invalid tunnel.status");
  validateAuthentication(tunnel.authentication);
}

function validateAuthentication(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Invalid tunnel.authentication");
  const authentication = value as Record<string, unknown>;
  for (const [key, field] of Object.entries(authentication)) {
    if (["method", "password", "token"].includes(key)) {
      text(field, `tunnel.authentication.${key}`, 1024);
      continue;
    }
    if (key !== "users" || !Array.isArray(field) || field.length > 32) throw new HttpError(400, "Invalid tunnel.authentication field");
    for (const user of field) {
      if (!user || typeof user !== "object" || Array.isArray(user)) throw new HttpError(400, "Invalid tunnel.authentication.users");
      const entries = Object.entries(user as Record<string, unknown>);
      if (entries.length === 0) throw new HttpError(400, "Empty tunnel authentication user");
      for (const [userKey, userValue] of entries) {
        if (!AUTH_FIELDS.has(userKey)) throw new HttpError(400, "Invalid tunnel authentication user field");
        text(userValue, `tunnel.authentication.users.${userKey}`, 1024);
      }
    }
  }
  if (JSON.stringify(value).length > 16 * 1024) throw new HttpError(400, "Tunnel authentication is too large");
}

export function validateReport(body: ReportBody): void {
  if (!body || typeof body !== "object") throw new HttpError(400, "Invalid report");
  text(body.agentVersion, "agentVersion", 64);
  if (!Array.isArray(body.tunnels) || body.tunnels.length > 64) throw new HttpError(400, "tunnels must contain at most 64 entries");
  const ids = new Set<string>();
  for (const tunnel of body.tunnels) {
    validateTunnel(tunnel);
    if (ids.has(tunnel.id)) throw new HttpError(400, "Duplicate tunnel.id");
    ids.add(tunnel.id);
  }
  if (body.appliedConfigVersion !== undefined && body.appliedConfigVersion !== null) {
    if (
      typeof body.appliedConfigVersion !== "number" ||
      !Number.isInteger(body.appliedConfigVersion) ||
      body.appliedConfigVersion < 0 ||
      !Number.isSafeInteger(body.appliedConfigVersion)
    ) {
      throw new HttpError(400, "Invalid appliedConfigVersion");
    }
  }
  if (body.configApplyError !== undefined && body.configApplyError !== null) {
    if (!CONFIG_APPLY_ERRORS[body.configApplyError]) {
      throw new HttpError(400, "Invalid configApplyError");
    }
  }
}

export interface NormalizedTunnelConfigInput {
  name: string;
  type: DesiredTunnelType;
  listen: string;
  port: number;
  publicHost: string | null;
  options: Record<string, unknown>;
  hops: HopRef[];
  subscriptionName: string | null;
}

export function validateTunnelConfigInput(input: unknown): NormalizedTunnelConfigInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "Invalid tunnel configuration input");
  }
  const body = input as Record<string, unknown>;

  const rawName = typeof body.name === "string" ? body.name.trim() : "";
  if (!TUNNEL_NAME_RE.test(rawName)) throw new HttpError(400, "Invalid tunnel name");
  const name = rawName;

  if (typeof body.type !== "string" || !TUNNEL_TYPES[body.type as DesiredTunnelType]) {
    throw new HttpError(400, "Invalid tunnel type");
  }
  const type = body.type as DesiredTunnelType;

  const port = typeof body.port === "number"
    ? body.port
    : typeof body.port === "string" && /^\d+$/.test(body.port.trim())
      ? Number(body.port.trim())
      : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HttpError(400, "Invalid tunnel port");
  }

  let listen = "::";
  if (body.listen !== undefined && body.listen !== null) {
    if (typeof body.listen !== "string") throw new HttpError(400, "Invalid listen address");
    const trimmedListen = body.listen.trim();
    if (trimmedListen.length > 0) {
      if (!validIpAddress(trimmedListen)) throw new HttpError(400, "Invalid listen address");
      listen = trimmedListen.startsWith("[") && trimmedListen.endsWith("]")
        ? trimmedListen.slice(1, -1)
        : trimmedListen;
    }
  }

  let publicHost: string | null = null;
  if (body.publicHost !== undefined && body.publicHost !== null) {
    if (typeof body.publicHost !== "string") throw new HttpError(400, "Invalid public host");
    const trimmedPublicHost = body.publicHost.trim();
    if (trimmedPublicHost.length > 0) {
      if (!validFrontendAddress(trimmedPublicHost)) throw new HttpError(400, "Invalid public host");
      publicHost = trimmedPublicHost;
    }
  }

  let options: Record<string, unknown> = {};
  if (type === "shadowsocks") {
    const rawMethod = body.method !== undefined && body.method !== null
      ? (typeof body.method === "string" ? body.method.trim() : "")
      : "2022-blake3-aes-128-gcm";
    if (!SS_METHODS[rawMethod]) throw new HttpError(400, "Invalid Shadowsocks method");
    options = { method: rawMethod };
  } else if (type === "hysteria2") {
    const rawServer = body.serverName !== undefined && body.serverName !== null
      ? (typeof body.serverName === "string" ? body.serverName.trim() : "")
      : "www.bing.com";
    if (!rawServer) throw new HttpError(400, "Invalid server name");
    options = { serverName: rawServer };
  } else if (type === "tuic") {
    const rawServer = body.serverName !== undefined && body.serverName !== null
      ? (typeof body.serverName === "string" ? body.serverName.trim() : "")
      : "www.bing.com";
    if (!rawServer) throw new HttpError(400, "Invalid server name");
    const rawCc = body.congestionControl !== undefined && body.congestionControl !== null
      ? (typeof body.congestionControl === "string" ? body.congestionControl.trim() : "")
      : "bbr";
    if (!TUIC_CONGESTION[rawCc]) throw new HttpError(400, "Invalid TUIC congestion control");
    options = { serverName: rawServer, congestionControl: rawCc };
  } else if (type === "vless-reality" || type === "anytls-reality") {
    const rawServer = body.serverName !== undefined && body.serverName !== null
      ? (typeof body.serverName === "string" ? body.serverName.trim() : "")
      : "addons.mozilla.org";
    if (!rawServer) throw new HttpError(400, "Invalid server name");
    options = { serverName: rawServer };
  } else if (type === "vmess-ws") {
    const rawPath = body.path !== undefined && body.path !== null
      ? (typeof body.path === "string" ? body.path.trim() : "")
      : "/vmess";
    if (!rawPath.startsWith("/") || !validWebSocketPath(rawPath)) {
      throw new HttpError(400, "Invalid VMess WebSocket path");
    }
    let host: string | null = null;
    if (body.host !== undefined && body.host !== null) {
      if (typeof body.host !== "string") throw new HttpError(400, "Invalid VMess host");
      const trimmedHost = body.host.trim();
      if (trimmedHost.length > 0) {
        if (!validFrontendAddress(trimmedHost)) throw new HttpError(400, "Invalid VMess host");
        host = trimmedHost;
      }
    }
    options = { path: rawPath, host };
  }

  const hops = parseHopRefs(body.hops);
  const subscriptionName = parseSubscriptionName(body.subscriptionName);
  return { name, type, listen, port, publicHost, options, hops, subscriptionName };
}

const HOP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function parseSubscriptionName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "Invalid subscription name");
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 64 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new HttpError(400, "Invalid subscription name");
  }
  return trimmed;
}

function parseHopRefs(value: unknown): HopRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 3) throw new HttpError(400, "Invalid hops");
  const hops: HopRef[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new HttpError(400, "Invalid hop");
    const record = item as Record<string, unknown>;
    if (typeof record.nodeId !== "string" || !HOP_ID_RE.test(record.nodeId)) {
      throw new HttpError(400, "Invalid hop nodeId");
    }
    if (typeof record.tunnelId !== "string" || !HOP_ID_RE.test(record.tunnelId)) {
      throw new HttpError(400, "Invalid hop tunnelId");
    }
    const key = `${record.nodeId}:${record.tunnelId}`;
    if (seen.has(key)) throw new HttpError(400, "Duplicate hop");
    seen.add(key);
    hops.push({ nodeId: record.nodeId, tunnelId: record.tunnelId });
  }
  return hops;
}
export function validateTunnelPatchInput(input: unknown): { subscriptionEnabled: boolean } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "Invalid subscriptionEnabled");
  }
  const body = input as Record<string, unknown>;
  if (typeof body.subscriptionEnabled !== "boolean") {
    throw new HttpError(400, "Invalid subscriptionEnabled");
  }
  return { subscriptionEnabled: body.subscriptionEnabled };
}

export function desiredTunnelFromRow(row: TunnelConfigRow): DesiredTunnel {
  const options = JSON.parse(row.options_json || "{}") as Record<string, unknown>;
  const base = {
    id: row.id,
    name: row.name,
    type: row.type,
    listen: row.listen,
    port: row.port,
    publicHost: row.public_host,
    credentialGeneration: row.credential_generation,
  };
  switch (row.type) {
    case "shadowsocks":
      return {
        ...base,
        type: "shadowsocks",
        method: typeof options.method === "string" ? options.method : "2022-blake3-aes-128-gcm",
      };
    case "hysteria2":
      return {
        ...base,
        type: "hysteria2",
        serverName: typeof options.serverName === "string" ? options.serverName : "www.bing.com",
      };
    case "tuic":
      return {
        ...base,
        type: "tuic",
        serverName: typeof options.serverName === "string" ? options.serverName : "www.bing.com",
        congestionControl: typeof options.congestionControl === "string" ? options.congestionControl : "bbr",
      };
    case "vless-reality":
      return {
        ...base,
        type: "vless-reality",
        serverName: typeof options.serverName === "string" ? options.serverName : "addons.mozilla.org",
      };
    case "anytls-reality":
      return {
        ...base,
        type: "anytls-reality",
        serverName: typeof options.serverName === "string" ? options.serverName : "addons.mozilla.org",
      };
    case "vmess-ws":
      return {
        ...base,
        type: "vmess-ws",
        path: typeof options.path === "string" ? options.path : "/vmess",
        host: typeof options.host === "string" ? options.host : null,
      };
  }
}
