import { bytesToBase64Url } from "./crypto";

export interface SubscriptionTunnel {
  nodeName: string;
  authentication: unknown;
  endpoint: string;
  metadata: unknown;
  name: string;
  protocol: string;
  status: unknown;
}

interface Endpoint {
  host: string;
  port: number;
}

type Credentials = Record<string, unknown>;

const encoder = new TextEncoder();

function bytesToBase64(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function utf8Base64(value: string): string {
  return bytesToBase64(encoder.encode(value));
}

function parseEndpoint(value: string): Endpoint | null {
  const bracketed = value.match(/^\[([^\]]+)]:(\d+)$/);
  if (bracketed) return validEndpoint(bracketed[1], bracketed[2]);
  const separator = value.lastIndexOf(":");
  if (separator <= 0) return null;
  return validEndpoint(value.slice(0, separator), value.slice(separator + 1));
}

function validEndpoint(host: string, portText: string): Endpoint | null {
  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

function authority(endpoint: Endpoint): string {
  const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host;
  return `${host}:${endpoint.port}`;
}

function record(value: unknown): Credentials {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Credentials : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function users(authentication: Credentials): Credentials[] {
  return Array.isArray(authentication.users) ? authentication.users.map(record) : [];
}

function displayName(tunnel: SubscriptionTunnel, user?: Credentials, index?: number): string {
  const base = `${tunnel.nodeName}/${tunnel.name}`;
  const userName = user && (text(user.name) ?? text(user.username));
  if (userName) return `${base}/${userName}`;
  return index === undefined ? base : `${base}/${index + 1}`;
}

function fragment(name: string): string {
  return `#${encodeURIComponent(name)}`;
}

function shadowsocksUris(tunnel: SubscriptionTunnel, endpoint: Endpoint, authentication: Credentials): string[] {
  const method = text(authentication.method);
  const password = text(authentication.password);
  if (!method || !password) return [];
  const userInfo = bytesToBase64Url(encoder.encode(`${method}:${password}`));
  return [`ss://${userInfo}@${authority(endpoint)}${fragment(displayName(tunnel))}`];
}

function userUris(
  tunnel: SubscriptionTunnel,
  endpoint: Endpoint,
  authentication: Credentials,
  scheme: string,
  credential: (user: Credentials) => string | null,
  query: string | ((user: Credentials) => string | null) = "",
): string[] {
  return users(authentication).flatMap((user, index) => {
    const value = credential(user);
    if (!value) return [];
    const parameters = typeof query === "function" ? query(user) : query;
    if (parameters === null) return [];
    return [`${scheme}://${value}@${authority(endpoint)}${parameters}${fragment(displayName(tunnel, user, index))}`];
  });
}

function vmessUris(tunnel: SubscriptionTunnel, endpoint: Endpoint, authentication: Credentials): string[] {
  const transport = record(record(tunnel.metadata).transport);
  return users(authentication).flatMap((user, index) => {
    const uuid = text(user.uuid);
    if (!uuid) return [];
    const node = {
      v: "2",
      ps: displayName(tunnel, user, index),
      add: endpoint.host,
      port: String(endpoint.port),
      id: uuid,
      aid: "0",
      scy: "auto",
      net: text(transport.type) ?? "tcp",
      type: "none",
      host: text(transport.host) ?? "",
      path: text(transport.path) ?? "",
      tls: "",
    };
    return [`vmess://${utf8Base64(JSON.stringify(node))}`];
  });
}

function tunnelUris(tunnel: SubscriptionTunnel): string[] {
  if (tunnel.status !== "healthy") return [];
  const endpoint = parseEndpoint(tunnel.endpoint);
  if (!endpoint) return [];
  const authentication = record(tunnel.authentication);
  const metadata = record(tunnel.metadata);
  const tls = record(metadata.tls);
  const reality = record(tls.reality);
  switch (tunnel.protocol.toLowerCase()) {
    case "shadowsocks":
      return shadowsocksUris(tunnel, endpoint, authentication);
    case "vless":
      return userUris(tunnel, endpoint, authentication, "vless", (user) => text(user.uuid), (user) => {
        const parameters = new URLSearchParams({ encryption: "none" });
        const flow = text(user.flow);
        if (flow) parameters.set("flow", flow);
        if (reality.enabled === true) {
          const serverName = text(tls.serverName);
          const publicKey = text(reality.publicKey);
          const shortId = text(reality.shortId);
          if (!serverName || !publicKey || !shortId) return null;
          parameters.set("security", "reality");
          parameters.set("sni", serverName);
          parameters.set("fp", "chrome");
          parameters.set("pbk", publicKey);
          parameters.set("sid", shortId);
        }
        return `?${parameters}`;
      });
    case "trojan":
      return userUris(tunnel, endpoint, authentication, "trojan", (user) => {
        const password = text(user.password);
        return password ? encodeURIComponent(password) : null;
      });
    case "hysteria2":
      return userUris(tunnel, endpoint, authentication, "hysteria2", (user) => {
        const password = text(user.password) ?? text(user.token);
        return password ? encodeURIComponent(password) : null;
      }, () => tlsQuery(tls));
    case "tuic":
      return userUris(tunnel, endpoint, authentication, "tuic", (user) => {
        const uuid = text(user.uuid);
        const password = text(user.password);
        return uuid && password ? `${encodeURIComponent(uuid)}:${encodeURIComponent(password)}` : null;
      }, () => {
        const parameters = new URLSearchParams();
        const congestionControl = text(metadata.congestionControl);
        if (congestionControl) parameters.set("congestion_control", congestionControl);
        appendTlsParameters(parameters, tls);
        return parameters.size > 0 ? `/?${parameters}` : "";
      });
    case "anytls":
      return userUris(tunnel, endpoint, authentication, "anytls", (user) => {
        const password = text(user.password);
        return password ? encodeURIComponent(password) : null;
      }, () => {
        const parameters = new URLSearchParams();
        if (reality.enabled === true) {
          const serverName = text(tls.serverName);
          const publicKey = text(reality.publicKey);
          const shortId = text(reality.shortId);
          if (!serverName || !publicKey || !shortId) return null;
          parameters.set("security", "reality");
          parameters.set("sni", serverName);
          parameters.set("fp", "chrome");
          parameters.set("pbk", publicKey);
          parameters.set("sid", shortId);
        }
        return parameters.size > 0 ? `/?${parameters}` : "";
      });
    case "vmess":
      return vmessUris(tunnel, endpoint, authentication);
    default:
      return [];
  }
}

function appendTlsParameters(parameters: URLSearchParams, tls: Credentials): void {
  const serverName = text(tls.serverName);
  if (serverName) parameters.set("sni", serverName);
  const alpn = Array.isArray(tls.alpn) ? tls.alpn.filter((value): value is string => typeof value === "string") : [];
  if (alpn.length > 0) parameters.set("alpn", alpn.join(","));
  if (tls.insecure === true) parameters.set("insecure", "1");
}

function tlsQuery(tls: Credentials): string {
  const parameters = new URLSearchParams();
  appendTlsParameters(parameters, tls);
  return parameters.size > 0 ? `/?${parameters}` : "";
}

export function subscriptionUris(tunnels: SubscriptionTunnel[]): string[] {
  return tunnels.flatMap(tunnelUris);
}

export function encodeSubscription(tunnels: SubscriptionTunnel[]): string {
  return utf8Base64(subscriptionUris(tunnels).join("\n"));
}
