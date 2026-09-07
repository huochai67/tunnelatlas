import { bytesToBase64Url, encryptJson } from "./crypto";
import { parseOriginEndpoint } from "./endpoints";
import type {
  DesiredHop,
  DesiredReadyHop,
  DesiredTunnelType,
  StoredCredentials,
} from "./types";
import { x25519Base } from "./x25519";

export type { DesiredHop, DesiredReadyHop, StoredCredentials };

export function credentialsContext(nodeId: string, tunnelId: string): string {
  return `creds:${nodeId}:${tunnelId}`;
}

function randomBytes(size: number): Uint8Array {
  const value = new Uint8Array(size);
  crypto.getRandomValues(value);
  return value;
}

function randomStandardBase64(size: number): string {
  const value = randomBytes(size);
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function randomHex(size: number): string {
  return [...randomBytes(size)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function realityKeypair(): { privateKey: string; publicKey: string } {
  const privateBytes = randomBytes(32);
  const publicBytes = x25519Base(privateBytes);
  return {
    privateKey: bytesToBase64Url(privateBytes),
    publicKey: bytesToBase64Url(publicBytes),
  };
}

export function generateProtocolCredentials(type: DesiredTunnelType, method?: string): StoredCredentials {
  switch (type) {
    case "shadowsocks": {
      const bytes = typeof method === "string" && method.includes("aes-128") ? 16 : 32;
      return { password: randomStandardBase64(bytes) };
    }
    case "hysteria2":
      return { password: bytesToBase64Url(randomBytes(24)) };
    case "tuic":
      return { uuid: crypto.randomUUID(), password: bytesToBase64Url(randomBytes(24)) };
    case "vless-reality": {
      const pair = realityKeypair();
      return { uuid: crypto.randomUUID(), ...pair, shortId: randomHex(8) };
    }
    case "anytls-reality": {
      const pair = realityKeypair();
      return {
        name: "tunnelatlas",
        password: bytesToBase64Url(randomBytes(24)),
        ...pair,
        shortId: randomHex(8),
      };
    }
    case "vmess-ws":
      return { uuid: crypto.randomUUID() };
  }
}

export async function encryptCredentials(
  credentials: StoredCredentials,
  secret: string,
  nodeId: string,
  tunnelId: string,
): Promise<string> {
  return encryptJson(credentials, secret, credentialsContext(nodeId, tunnelId));
}

export function parseStoredCredentials(value: unknown): StoredCredentials | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const credentials: StoredCredentials = {};
  if (typeof record.password === "string") credentials.password = record.password;
  if (typeof record.uuid === "string") credentials.uuid = record.uuid;
  if (typeof record.privateKey === "string") credentials.privateKey = record.privateKey;
  if (typeof record.publicKey === "string") credentials.publicKey = record.publicKey;
  if (typeof record.shortId === "string") credentials.shortId = record.shortId;
  if (typeof record.name === "string") credentials.name = record.name;
  return Object.keys(credentials).length > 0 ? credentials : null;
}

export function clientAuthentication(
  type: DesiredTunnelType,
  credentials: StoredCredentials,
  options: Record<string, unknown>,
): Record<string, unknown> | null {
  switch (type) {
    case "shadowsocks":
      return typeof credentials.password === "string" && typeof options.method === "string"
        ? { method: options.method, password: credentials.password }
        : null;
    case "hysteria2":
      return typeof credentials.password === "string"
        ? { users: [{ password: credentials.password }] }
        : null;
    case "tuic":
      return typeof credentials.uuid === "string" && typeof credentials.password === "string"
        ? { users: [{ uuid: credentials.uuid, password: credentials.password }] }
        : null;
    case "vless-reality":
      return typeof credentials.uuid === "string"
        ? { users: [{ uuid: credentials.uuid, flow: "xtls-rprx-vision" }] }
        : null;
    case "anytls-reality":
      return typeof credentials.password === "string"
        ? { users: [{ name: credentials.name ?? "tunnelatlas", password: credentials.password }] }
        : null;
    case "vmess-ws":
      return typeof credentials.uuid === "string" ? { users: [{ uuid: credentials.uuid }] } : null;
  }
}

export function hostedMetadata(
  type: DesiredTunnelType,
  credentials: StoredCredentials,
  options: Record<string, unknown>,
): Record<string, unknown> {
  if (type === "hysteria2" || type === "tuic") {
    const metadata: Record<string, unknown> = {
      direction: "inbound",
      tls: {
        enabled: true,
        serverName: typeof options.serverName === "string" ? options.serverName : "www.bing.com",
        insecure: true,
        alpn: ["h3"],
      },
    };
    if (type === "tuic") {
      metadata.congestionControl = typeof options.congestionControl === "string" ? options.congestionControl : "bbr";
    }
    return metadata;
  }
  if (type === "vless-reality" || type === "anytls-reality") {
    return {
      direction: "inbound",
      tls: {
        enabled: true,
        serverName: typeof options.serverName === "string" ? options.serverName : "addons.mozilla.org",
        reality: {
          enabled: true,
          publicKey: credentials.publicKey ?? "",
          shortId: credentials.shortId ?? "",
        },
      },
    };
  }
  if (type === "vmess-ws") {
    const transport: Record<string, unknown> = {
      type: "ws",
      path: typeof options.path === "string" ? options.path : "/vmess",
    };
    if (typeof options.host === "string" && options.host.length > 0) transport.host = options.host;
    return { direction: "inbound", transport };
  }
  return { direction: "inbound" };
}

export function hopTag(entryTunnelId: string, hopTunnelId: string): string {
  return `hop-${entryTunnelId}-${hopTunnelId}`;
}

export function hopEndpoint(
  publicHost: string | null | undefined,
  observedEndpoint: string | null | undefined,
  cfHostname: string | null | undefined,
  cfStatus: string | null | undefined,
  port: number,
): { server: string; port: number; viaCloudflare: boolean } | null {
  if (cfStatus === "active" && cfHostname) {
    return { server: cfHostname, port: 443, viaCloudflare: true };
  }
  if (publicHost && publicHost.trim().length > 0) {
    return { server: publicHost.trim(), port, viaCloudflare: false };
  }
  if (observedEndpoint) {
    const parsed = parseOriginEndpoint(observedEndpoint);
    if (parsed) return { server: parsed.host, port: parsed.port, viaCloudflare: false };
  }
  return null;
}

export function readyHop(input: {
  nodeId: string;
  tunnelId: string;
  entryTunnelId: string;
  type: DesiredTunnelType;
  credentials: StoredCredentials;
  options: Record<string, unknown>;
  server: string;
  port: number;
  viaCloudflare: boolean;
}): DesiredReadyHop | null {
  const base = {
    nodeId: input.nodeId,
    tunnelId: input.tunnelId,
    tag: hopTag(input.entryTunnelId, input.tunnelId),
    status: "ready" as const,
    server: input.server,
    port: input.port,
  };
  switch (input.type) {
    case "shadowsocks":
      return typeof input.credentials.password === "string" && typeof input.options.method === "string"
        ? { ...base, type: "shadowsocks", method: input.options.method, password: input.credentials.password }
        : null;
    case "hysteria2":
      return typeof input.credentials.password === "string"
        ? {
          ...base,
          type: "hysteria2",
          password: input.credentials.password,
          tls: {
            serverName: typeof input.options.serverName === "string" ? input.options.serverName : "www.bing.com",
            insecure: true,
            alpn: ["h3"],
          },
        }
        : null;
    case "tuic":
      return typeof input.credentials.uuid === "string" && typeof input.credentials.password === "string"
        ? {
          ...base,
          type: "tuic",
          uuid: input.credentials.uuid,
          password: input.credentials.password,
          congestionControl: typeof input.options.congestionControl === "string" ? input.options.congestionControl : "bbr",
          tls: {
            serverName: typeof input.options.serverName === "string" ? input.options.serverName : "www.bing.com",
            insecure: true,
            alpn: ["h3"],
          },
        }
        : null;
    case "vless-reality":
      return typeof input.credentials.uuid === "string"
        && typeof input.credentials.publicKey === "string"
        && typeof input.credentials.shortId === "string"
        ? {
          ...base,
          type: "vless-reality",
          uuid: input.credentials.uuid,
          flow: "xtls-rprx-vision",
          tls: {
            serverName: typeof input.options.serverName === "string" ? input.options.serverName : "addons.mozilla.org",
            reality: { publicKey: input.credentials.publicKey, shortId: input.credentials.shortId },
          },
        }
        : null;
    case "anytls-reality":
      return typeof input.credentials.password === "string"
        && typeof input.credentials.publicKey === "string"
        && typeof input.credentials.shortId === "string"
        ? {
          ...base,
          type: "anytls-reality",
          password: input.credentials.password,
          tls: {
            serverName: typeof input.options.serverName === "string" ? input.options.serverName : "addons.mozilla.org",
            reality: { publicKey: input.credentials.publicKey, shortId: input.credentials.shortId },
          },
        }
        : null;
    case "vmess-ws": {
      if (typeof input.credentials.uuid !== "string") return null;
      const path = typeof input.options.path === "string" ? input.options.path : "/vmess";
      const host = input.viaCloudflare
        ? input.server
        : typeof input.options.host === "string" && input.options.host.length > 0
          ? input.options.host
          : undefined;
      return {
        ...base,
        type: "vmess-ws",
        uuid: input.credentials.uuid,
        ...(input.viaCloudflare ? { tls: { serverName: input.server } } : {}),
        transport: host ? { type: "ws", path, host } : { type: "ws", path },
      };
    }
  }
}

export function pendingHop(
  nodeId: string,
  tunnelId: string,
  entryTunnelId: string,
  type: DesiredTunnelType,
  port: number,
): DesiredHop {
  return {
    nodeId,
    tunnelId,
    tag: hopTag(entryTunnelId, tunnelId),
    type,
    status: "pending",
    port,
  };
}
