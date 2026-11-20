import { bytesToBase64Url } from "./crypto";
import { ipFamily, listenSupportsIpv4, listenSupportsIpv6, stripBrackets } from "./endpoints";
import type { SubscriptionIpMode } from "./types";

export type SubscriptionIpFilter = "v4" | "v6" | "dual";

export interface SubscriptionOptions {
  ipFilter?: SubscriptionIpFilter | null;
}

export interface SubscriptionTunnel {
  nodeName: string;
  authentication: unknown;
  endpoint: string;
  metadata: unknown;
  name: string;
  protocol: string;
  status: unknown;
  cloudflare?: {
    hostname: string;
    status: string;
    address?: string | null;
    ipv6Address?: string | null;
  } | null;
  subscriptionName?: string | null;
  listen?: string | null;
  port?: number | null;
  publicHost?: string | null;
  publicIpv6?: string | null;
  subscriptionIpMode?: SubscriptionIpMode | null;
  observedIpv4?: string | null;
  observedIpv6?: string | null;
}

interface Endpoint {
  host: string;
  port: number;
}

interface ResolvedTarget {
  endpoint: Endpoint;
  labelSuffix?: string;
  cfAddress?: string | null;
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
  const bare = stripBrackets(host);
  const port = Number(portText);
  if (!bare || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: bare, port };
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

function displayName(
  tunnel: SubscriptionTunnel,
  user?: Credentials,
  index?: number,
  labelSuffix?: string,
): string {
  const base = tunnel.subscriptionName?.trim() || `${tunnel.nodeName}/${tunnel.name}`;
  const userName = user && (text(user.name) ?? text(user.username));
  const raw = userName
    ? `${base}/${userName}`
    : index === undefined
      ? base
      : `${base}/${index + 1}`;
  return labelSuffix ? `${raw} ${labelSuffix}` : raw;
}

function fragment(name: string): string {
  return `#${encodeURIComponent(name)}`;
}

function isWildcardHost(host: string): boolean {
  const bare = stripBrackets(host);
  return bare === "::" || bare === "0.0.0.0";
}

function resolveDirectTargets(
  tunnel: SubscriptionTunnel,
  reportedEndpoint: Endpoint,
  ipFilter: SubscriptionIpFilter | null,
): ResolvedTarget[] {
  const mode: SubscriptionIpMode = tunnel.subscriptionIpMode ?? "auto";
  const port = tunnel.port ?? reportedEndpoint.port;
  const listen = tunnel.listen ?? "::";
  const reportedFamily = ipFamily(reportedEndpoint.host);
  const reportedUsable = !isWildcardHost(reportedEndpoint.host);

  const explicitPublicHost = tunnel.publicHost?.trim() ? stripBrackets(tunnel.publicHost) : null;
  const explicitPublicHostFamily = explicitPublicHost ? ipFamily(explicitPublicHost) : null;
  const explicitPublicIpv6 = tunnel.publicIpv6?.trim() ? stripBrackets(tunnel.publicIpv6) : null;

  const v4Candidate: Endpoint | null = (() => {
    if (explicitPublicHost && explicitPublicHostFamily !== "ipv6") {
      return { host: explicitPublicHost, port };
    }
    if (listenSupportsIpv4(listen) && tunnel.observedIpv4?.trim()) {
      return { host: tunnel.observedIpv4.trim(), port };
    }
    if (reportedUsable && reportedFamily !== "ipv6") {
      return reportedEndpoint;
    }
    return null;
  })();

  const v6Candidate: Endpoint | null = (() => {
    if (explicitPublicIpv6) {
      return { host: explicitPublicIpv6, port };
    }
    if (explicitPublicHost && explicitPublicHostFamily === "ipv6") {
      return { host: explicitPublicHost, port };
    }
    if (listenSupportsIpv6(listen) && tunnel.observedIpv6?.trim()) {
      return { host: stripBrackets(tunnel.observedIpv6), port };
    }
    if (reportedUsable && reportedFamily === "ipv6") {
      return reportedEndpoint;
    }
    return null;
  })();

  const dualPair = (): ResolvedTarget[] => {
    if (v4Candidate && v6Candidate && v4Candidate.host !== v6Candidate.host) {
      const v4Suffix = ipFamily(v4Candidate.host) === "ipv4" ? "[IPv4]" : undefined;
      return [
        { endpoint: v4Candidate, labelSuffix: v4Suffix },
        { endpoint: v6Candidate, labelSuffix: "[IPv6]" },
      ];
    }
    if (v4Candidate) return [{ endpoint: v4Candidate }];
    if (v6Candidate) return [{ endpoint: v6Candidate }];
    return [];
  };

  if (ipFilter === "v6") {
    if (mode === "ipv4") return [];
    return v6Candidate ? [{ endpoint: v6Candidate }] : [];
  }
  if (ipFilter === "v4") {
    if (mode === "ipv6") return [];
    return v4Candidate ? [{ endpoint: v4Candidate }] : [];
  }
  if (ipFilter === "dual") {
    if (mode === "ipv4") return v4Candidate ? [{ endpoint: v4Candidate }] : [];
    if (mode === "ipv6") return v6Candidate ? [{ endpoint: v6Candidate }] : [];
    return dualPair();
  }

  switch (mode) {
    case "ipv4":
      return v4Candidate ? [{ endpoint: v4Candidate }] : [];
    case "ipv6":
      return v6Candidate ? [{ endpoint: v6Candidate }] : [];
    case "dual":
      return dualPair();
    case "auto":
    default:
      return [{ endpoint: reportedEndpoint }];
  }
}

function resolveCloudflareTargets(
  tunnel: SubscriptionTunnel,
  reportedEndpoint: Endpoint,
  ipFilter: SubscriptionIpFilter | null,
): ResolvedTarget[] {
  const mode: SubscriptionIpMode = tunnel.subscriptionIpMode ?? "auto";
  const frontend = tunnel.cloudflare!;
  const preferred = frontend.address?.trim() ? stripBrackets(frontend.address) : null;
  const preferredFamily = preferred ? ipFamily(preferred) : null;
  const preferredV6 = frontend.ipv6Address?.trim()
    ? stripBrackets(frontend.ipv6Address)
    : preferredFamily === "ipv6"
      ? preferred
      : null;
  const preferredV4 = preferred && preferredFamily !== "ipv6" ? preferred : null;

  const dualCf = (): ResolvedTarget[] => {
    if (preferredV4 && preferredV6 && preferredV4 !== preferredV6) {
      return [
        { endpoint: reportedEndpoint, labelSuffix: "[IPv4]", cfAddress: preferredV4 },
        { endpoint: reportedEndpoint, labelSuffix: "[IPv6]", cfAddress: preferredV6 },
      ];
    }
    return [{ endpoint: reportedEndpoint, cfAddress: preferred ?? preferredV6 ?? null }];
  };

  if (ipFilter === "v6") {
    if (mode === "ipv4") return [];
    return [{ endpoint: reportedEndpoint, cfAddress: preferredV6 ?? null }];
  }
  if (ipFilter === "v4") {
    if (mode === "ipv6") return [];
    return [{ endpoint: reportedEndpoint, cfAddress: preferredV4 ?? null }];
  }
  if (ipFilter === "dual") {
    if (mode === "ipv4") return [{ endpoint: reportedEndpoint, cfAddress: preferredV4 ?? null }];
    if (mode === "ipv6") return [{ endpoint: reportedEndpoint, cfAddress: preferredV6 ?? null }];
    return dualCf();
  }

  switch (mode) {
    case "ipv4":
      return [{ endpoint: reportedEndpoint, cfAddress: preferredV4 ?? null }];
    case "ipv6":
      return [{ endpoint: reportedEndpoint, cfAddress: preferredV6 ?? null }];
    case "dual":
      return dualCf();
    case "auto":
    default:
      return [{ endpoint: reportedEndpoint, cfAddress: preferred }];
  }
}

function shadowsocksUris(
  tunnel: SubscriptionTunnel,
  target: ResolvedTarget,
  authentication: Credentials,
): string[] {
  const method = text(authentication.method);
  const password = text(authentication.password);
  if (!method || !password) return [];
  const userInfo = bytesToBase64Url(encoder.encode(`${method}:${password}`));
  return [`ss://${userInfo}@${authority(target.endpoint)}${fragment(displayName(tunnel, undefined, undefined, target.labelSuffix))}`];
}

function userUris(
  tunnel: SubscriptionTunnel,
  target: ResolvedTarget,
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
    return [`${scheme}://${value}@${authority(target.endpoint)}${parameters}${fragment(displayName(tunnel, user, index, target.labelSuffix))}`];
  });
}

function vmessUris(
  tunnel: SubscriptionTunnel,
  target: ResolvedTarget,
  authentication: Credentials,
  activeHost: string | null,
): string[] {
  const transport = record(record(tunnel.metadata).transport);
  const customAddress = activeHost && target.cfAddress ? target.cfAddress : null;
  return users(authentication).flatMap((user, index) => {
    const uuid = text(user.uuid);
    if (!uuid) return [];
    const node = {
      v: "2",
      ps: displayName(tunnel, user, index, target.labelSuffix),
      add: customAddress ?? activeHost ?? target.endpoint.host,
      port: activeHost ? "443" : String(target.endpoint.port),
      id: uuid,
      aid: "0",
      scy: "auto",
      net: text(transport.type) ?? "tcp",
      type: "none",
      host: activeHost ?? text(transport.host) ?? "",
      path: text(transport.path) ?? "",
      tls: activeHost ? "tls" : "",
      ...(activeHost ? { sni: activeHost } : {}),
    };
    return [`vmess://${utf8Base64(JSON.stringify(node))}`];
  });
}

function tunnelUris(tunnel: SubscriptionTunnel, ipFilter: SubscriptionIpFilter | null): string[] {
  if (tunnel.status !== "healthy") return [];
  const reportedEndpoint = parseEndpoint(tunnel.endpoint);
  if (!reportedEndpoint) return [];
  const authentication = record(tunnel.authentication);
  const metadata = record(tunnel.metadata);
  const tls = record(metadata.tls);
  const reality = record(tls.reality ?? metadata.reality);
  const protocol = tunnel.protocol.toLowerCase();
  const frontend = tunnel.cloudflare;
  const activeCfHost = protocol === "vmess" && frontend && frontend.status === "active" && frontend.hostname
    ? frontend.hostname
    : null;

  const targets = activeCfHost
    ? resolveCloudflareTargets(tunnel, reportedEndpoint, ipFilter)
    : resolveDirectTargets(tunnel, reportedEndpoint, ipFilter);

  return targets.flatMap((target) => {
    switch (protocol) {
      case "shadowsocks":
        return shadowsocksUris(tunnel, target, authentication);
      case "vless":
        return userUris(tunnel, target, authentication, "vless", (user) => text(user.uuid), (user) => {
          const parameters = new URLSearchParams({ encryption: "none" });
          const flow = text(user.flow);
          if (flow) parameters.set("flow", flow);
          if (reality.enabled === true) {
            const serverName = text(tls.serverName ?? metadata.serverName ?? record(reality).serverName);
            const publicKey = text(reality.publicKey);
            const shortId = text(reality.shortId);
            if (!serverName || !publicKey || !shortId) return null;
            parameters.set("security", "reality");
            parameters.set("sni", serverName);
            parameters.set("fp", "chrome");
            parameters.set("pbk", publicKey);
            parameters.set("sid", shortId);
            parameters.set("type", "tcp");
            parameters.set("headerType", "none");
          }
          return `?${parameters}`;
        });
      case "trojan":
        return userUris(tunnel, target, authentication, "trojan", (user) => {
          const password = text(user.password);
          return password ? encodeURIComponent(password) : null;
        });
      case "hysteria2":
        return userUris(tunnel, target, authentication, "hysteria2", (user) => {
          const password = text(user.password) ?? text(user.token);
          return password ? encodeURIComponent(password) : null;
        }, () => tlsQuery(tls));
      case "tuic":
        return userUris(tunnel, target, authentication, "tuic", (user) => {
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
        return userUris(tunnel, target, authentication, "anytls", (user) => {
          const password = text(user.password);
          return password ? encodeURIComponent(password) : null;
        }, () => {
          const parameters = new URLSearchParams();
          if (reality.enabled === true) {
            const serverName = text(tls.serverName ?? metadata.serverName ?? record(reality).serverName);
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
        return vmessUris(tunnel, target, authentication, activeCfHost);
      default:
        return [];
    }
  });
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

export function subscriptionUris(tunnels: SubscriptionTunnel[], options: SubscriptionOptions = {}): string[] {
  const ipFilter = options.ipFilter ?? null;
  return tunnels.flatMap((tunnel) => tunnelUris(tunnel, ipFilter));
}

export function encodeSubscription(tunnels: SubscriptionTunnel[], options: SubscriptionOptions = {}): string {
  return utf8Base64(subscriptionUris(tunnels, options).join("\n"));
}
