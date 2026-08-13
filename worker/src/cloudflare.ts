import { sha256Hex } from "./crypto";
import { parseOriginEndpoint, validWebSocketPath, type OriginEndpoint } from "./endpoints";
import { HttpError } from "./http";
import type { Env } from "./types";

const LEASE_FRESH_MS = 5 * 60_000;
const ZONE_HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export interface CloudflareFrontendRow {
  node_id: string;
  tunnel_id: string;
  hostname: string;
  zone_id: string;
  zone_name: string;
  status: string;
  operation_id: string | null;
  dns_record_id: string | null;
  config_ruleset_id: string | null;
  config_rule_id: string | null;
  origin_ruleset_id: string | null;
  origin_rule_id: string | null;
  source_endpoint: string;
  source_path: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export class ProviderError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(sanitizeProviderMessage(message));
  }
}

export class ConfigError extends Error {}

export function sanitizeProviderMessage(value: string): string {
  const cleaned = value.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}

export function leaseFresh(updatedAt: string): boolean {
  const time = Date.parse(updatedAt);
  return Number.isFinite(time) && Date.now() - time < LEASE_FRESH_MS;
}

export function originAuthority(origin: OriginEndpoint): string {
  const host = origin.host.includes(":") ? `[${origin.host}]` : origin.host;
  return `${host}:${origin.port}`;
}

export interface FrontendTarget {
  hostname: string;
  origin: OriginEndpoint;
  path: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function frontendTarget(
  nodeId: string,
  tunnelId: string,
  zoneName: string,
  tunnel: { protocol: string; endpoint: string; metadata: unknown },
): Promise<FrontendTarget> {
  const zone = zoneName.trim().replace(/\.+$/, "");
  if (!zone || !ZONE_HOSTNAME.test(zone)) throw new ConfigError("Cloudflare is not configured");
  if (typeof tunnel.protocol !== "string" || tunnel.protocol.toLowerCase() !== "vmess") {
    throw new HttpError(409, "Only VMess tunnels can use a Cloudflare frontend");
  }
  const transport = record(record(tunnel.metadata).transport);
  if (transport.type !== "ws") throw new HttpError(409, "Tunnel transport must be WebSocket");
  const path = transport.path;
  if (typeof path !== "string" || !validWebSocketPath(path)) throw new HttpError(409, "Invalid WebSocket path");
  const origin = parseOriginEndpoint(tunnel.endpoint);
  if (!origin) throw new HttpError(409, "Origin endpoint must be a public IPv4, IPv6, or hostname with a port");
  const label = `ta-${(await sha256Hex(`${nodeId}:${tunnelId}`)).slice(0, 20)}`;
  const hostname = `${label}.${zone}`;
  const host = transport.host;
  if (typeof host === "string" && host.length > 0 && host !== hostname) {
    throw new HttpError(409, `Tunnel transport host "${host}" must match the generated hostname ${hostname}`);
  }
  return { hostname, origin, path };
}

interface CloudflareEnvelope<T> {
  success: boolean;
  result?: T;
  errors?: Array<{ code: number; message: string }>;
}

async function cloudflareFetch<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  if (!env.CLOUDFLARE_API_TOKEN) throw new ConfigError("Cloudflare is not configured");
  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
        ...(init.headers ?? {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch {
    throw new ProviderError("Cloudflare API unreachable");
  }
  const text = await response.text();
  let envelope: CloudflareEnvelope<T> | null = null;
  try { envelope = text ? JSON.parse(text) as CloudflareEnvelope<T> : null; } catch { envelope = null; }
  if (!response.ok || !envelope || envelope.success !== true) {
    const detail = envelope?.errors?.map((error) => error.message).filter(Boolean).join("; ");
    throw new ProviderError(detail || `HTTP ${response.status}`, response.status);
  }
  return envelope.result as T;
}

export function providerMessage(error: unknown): string {
  if (error instanceof HttpError || error instanceof ProviderError || error instanceof ConfigError) return error.message;
  return "Cloudflare provisioning failed";
}

async function resolveZone(env: Env): Promise<{ id: string; name: string }> {
  const zoneName = String(env.CLOUDFLARE_ZONE_NAME ?? "").trim().replace(/\.+$/, "");
  if (!zoneName || !ZONE_HOSTNAME.test(zoneName)) throw new ConfigError("Cloudflare is not configured");
  const zones = await cloudflareFetch<Array<{ id?: string; name?: string }>>(env, `/zones?name=${encodeURIComponent(zoneName)}&status=active`);
  const zone = Array.isArray(zones)
    ? zones.find((candidate) => String(candidate.name ?? "").toLowerCase() === zoneName.toLowerCase())
    : null;
  if (!zone?.id) throw new ProviderError(`No active Cloudflare zone named "${zoneName}"`);
  return { id: String(zone.id), name: zoneName };
}

async function ensureWebSockets(env: Env, zoneId: string): Promise<void> {
  const settings = await cloudflareFetch<{ value?: string }>(env, `/zones/${zoneId}/settings/websockets`);
  if (settings?.value === "on") return;
  await cloudflareFetch(env, `/zones/${zoneId}/settings/websockets`, { method: "PATCH", body: JSON.stringify({ value: "on" }) });
}

interface DnsRecord {
  id?: string;
  name?: string;
  type?: string;
  content?: string;
  comment?: string | null;
}

function sameName(a: string, b: string): boolean {
  return a.replace(/\.+$/, "").toLowerCase() === b.replace(/\.+$/, "").toLowerCase();
}

async function updateOrKeepDns(
  env: Env, zoneId: string, record: DnsRecord, origin: OriginEndpoint, comment: string,
): Promise<string> {
  const id = String(record.id);
  if (record.type === origin.recordType && record.content === origin.host) return id;
  if (record.type !== origin.recordType) {
    await cloudflareFetch(env, `/zones/${zoneId}/dns_records/${id}`, { method: "DELETE" });
  } else {
    const updated = await cloudflareFetch<DnsRecord>(env, `/zones/${zoneId}/dns_records/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ content: origin.host, ttl: 1, proxied: true, comment }),
    });
    if (!updated?.id) throw new ProviderError("DNS record update returned no ID");
    return String(updated.id);
  }
  const created = await cloudflareFetch<DnsRecord>(env, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify({ type: origin.recordType, name: record.name ?? origin.host, content: origin.host, ttl: 1, proxied: true, comment }),
  });
  if (!created?.id) throw new ProviderError("DNS record creation returned no ID");
  return String(created.id);
}

async function reconcileDnsRecord(
  env: Env,
  zoneId: string,
  origin: OriginEndpoint,
  hostname: string,
  nodeId: string,
  tunnelId: string,
  storedId: string | null,
): Promise<string> {
  const comment = `tunnelatlas:${nodeId}:${tunnelId}`;
  if (storedId) {
    try {
      const record = await cloudflareFetch<DnsRecord>(env, `/zones/${zoneId}/dns_records/${storedId}`);
      if (record?.id) return await updateOrKeepDns(env, zoneId, record, origin, comment);
    } catch (error) {
      if (!(error instanceof ProviderError && error.status === 404)) throw error;
    }
  }
  const records = await cloudflareFetch<DnsRecord[]>(env, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(hostname)}`);
  const list = Array.isArray(records) ? records : [];
  const owned = list.filter((record) => record.comment === comment);
  if (owned.length > 0) return await updateOrKeepDns(env, zoneId, owned[0], origin, comment);
  if (list.some((record) => record.name && sameName(record.name, hostname))) {
    throw new HttpError(409, `DNS name ${hostname} already exists and is not owned by this tunnel`);
  }
  const created = await cloudflareFetch<DnsRecord>(env, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify({ type: origin.recordType, name: hostname, content: origin.host, ttl: 1, proxied: true, comment }),
  });
  if (!created?.id) throw new ProviderError("DNS record creation returned no ID");
  return String(created.id);
}

interface ZoneRule {
  id?: string;
  ref?: string;
  expression?: string;
  action?: string;
}

interface ZoneRuleset {
  id?: string;
  rules?: ZoneRule[];
}

async function getEntrypoint(env: Env, zoneId: string, phase: string): Promise<ZoneRuleset | null> {
  try {
    const ruleset = await cloudflareFetch<ZoneRuleset>(env, `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`);
    return ruleset?.id ? ruleset : null;
  } catch (error) {
    if (error instanceof ProviderError && (error.status === 400 || error.status === 404)) return null;
    throw error;
  }
}

async function ensureEntrypoint(env: Env, zoneId: string, phase: string, name: string): Promise<ZoneRuleset> {
  const existing = await getEntrypoint(env, zoneId, phase);
  if (existing) return existing;
  try {
    const created = await cloudflareFetch<ZoneRuleset>(env, `/zones/${zoneId}/rulesets`, {
      method: "POST",
      body: JSON.stringify({ name, kind: "zone", phase, rules: [] }),
    });
    if (!created?.id) throw new ProviderError("Ruleset creation returned no ID");
    return created;
  } catch (error) {
    if (error instanceof ProviderError && error.status === 409) {
      const raced = await getEntrypoint(env, zoneId, phase);
      if (raced) return raced;
    }
    throw error;
  }
}

export interface ZoneRuleSpec {
  ref: string;
  expression: string;
  action: string;
  action_parameters: Record<string, unknown>;
}

async function upsertZoneRule(
  env: Env,
  zoneId: string,
  phase: string,
  rulesetName: string,
  rule: ZoneRuleSpec,
  stored: { rulesetId: string | null; ruleId: string | null },
): Promise<{ rulesetId: string; ruleId: string }> {
  const ruleset = await ensureEntrypoint(env, zoneId, phase, rulesetName);
  const rulesetId = String(ruleset.id);
  let target: ZoneRule | null = null;
  if (stored.ruleId) {
    target = (ruleset.rules ?? []).find((candidate) => candidate.id === stored.ruleId) ?? null;
  }
  if (!target) target = (ruleset.rules ?? []).find((candidate) => candidate.ref === rule.ref) ?? null;
  const body = { expression: rule.expression, action: rule.action, action_parameters: rule.action_parameters };
  if (target?.id) {
    const updated = await cloudflareFetch<ZoneRule>(env, `/zones/${zoneId}/rulesets/${rulesetId}/rules/${target.id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    if (!updated?.id) throw new ProviderError("Rule update returned no ID");
    return { rulesetId, ruleId: String(updated.id) };
  }
  const created = await cloudflareFetch<ZoneRule>(env, `/zones/${zoneId}/rulesets/${rulesetId}/rules`, {
    method: "POST",
    body: JSON.stringify({ ...body, ref: rule.ref }),
  });
  if (!created?.id) throw new ProviderError("Rule creation returned no ID");
  return { rulesetId, ruleId: String(created.id) };
}

async function persistFrontend(
  env: Env, nodeId: string, tunnelId: string, operationId: string, changes: Record<string, unknown>,
): Promise<void> {
  const entries = Object.entries(changes);
  const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
  await env.DB.prepare(
    `UPDATE tunnel_cloudflare_frontends SET ${assignments}, updated_at = ? WHERE node_id = ? AND tunnel_id = ? AND operation_id = ?`,
  ).bind(...entries.map(([, value]) => value), new Date().toISOString(), nodeId, tunnelId, operationId).run();
}

export interface ProvisionInput {
  nodeId: string;
  tunnelId: string;
  operationId: string;
  target: FrontendTarget;
}

export async function provisionFrontend(env: Env, input: ProvisionInput): Promise<void> {
  const { nodeId, tunnelId, operationId, target } = input;
  const row = await env.DB.prepare("SELECT * FROM tunnel_cloudflare_frontends WHERE node_id = ? AND tunnel_id = ?")
    .bind(nodeId, tunnelId).first<CloudflareFrontendRow>();
  if (!row || row.operation_id !== operationId) throw new HttpError(409, "Cloudflare operation superseded");
  try {
    const zone = await resolveZone(env);
    await persistFrontend(env, nodeId, tunnelId, operationId, { zone_id: zone.id, zone_name: zone.name });
    await ensureWebSockets(env, zone.id);
    const dnsRecordId = await reconcileDnsRecord(env, zone.id, target.origin, target.hostname, nodeId, tunnelId, row.dns_record_id);
    await persistFrontend(env, nodeId, tunnelId, operationId, { dns_record_id: dnsRecordId });
    const label = target.hostname.slice(0, target.hostname.indexOf("."));
    const config = await upsertZoneRule(env, zone.id, "http_config_settings", "TunnelAtlas SSL", {
      ref: `ta-config-${label.slice(3)}`,
      expression: `(http.host eq "${target.hostname}")`,
      action: "set_config",
      action_parameters: { ssl: "flexible" },
    }, { rulesetId: row.config_ruleset_id, ruleId: row.config_rule_id });
    await persistFrontend(env, nodeId, tunnelId, operationId, { config_ruleset_id: config.rulesetId, config_rule_id: config.ruleId });
    const origin = await upsertZoneRule(env, zone.id, "http_request_origin", "TunnelAtlas origin ports", {
      ref: `ta-origin-${label.slice(3)}`,
      expression: `(http.host eq "${target.hostname}" and http.request.uri.path eq "${target.path}")`,
      action: "route",
      action_parameters: { origin: { port: target.origin.port } },
    }, { rulesetId: row.origin_ruleset_id, ruleId: row.origin_rule_id });
    await persistFrontend(env, nodeId, tunnelId, operationId, { origin_ruleset_id: origin.rulesetId, origin_rule_id: origin.ruleId });
    await env.DB.prepare(
      `UPDATE tunnel_cloudflare_frontends SET status = 'active', operation_id = NULL, last_error = NULL,
       source_endpoint = ?, source_path = ?, updated_at = ? WHERE node_id = ? AND tunnel_id = ? AND operation_id = ?`,
    ).bind(originAuthority(target.origin), target.path, new Date().toISOString(), nodeId, tunnelId, operationId).run();
  } catch (error) {
    await env.DB.prepare(
      `UPDATE tunnel_cloudflare_frontends SET status = 'error', operation_id = NULL, last_error = ?, updated_at = ?
       WHERE node_id = ? AND tunnel_id = ? AND operation_id = ?`,
    ).bind(providerMessage(error), new Date().toISOString(), nodeId, tunnelId, operationId).run();
    throw error;
  }
}

export async function deprovisionFrontend(env: Env, row: CloudflareFrontendRow, operationId: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    if (row.origin_rule_id) {
      await cloudflareFetch(env, `/zones/${row.zone_id}/rulesets/${row.origin_ruleset_id}/rules/${row.origin_rule_id}`, { method: "DELETE" })
        .catch((error) => { if (!(error instanceof ProviderError && error.status === 404)) throw error; });
    }
    if (row.config_rule_id) {
      await cloudflareFetch(env, `/zones/${row.zone_id}/rulesets/${row.config_ruleset_id}/rules/${row.config_rule_id}`, { method: "DELETE" })
        .catch((error) => { if (!(error instanceof ProviderError && error.status === 404)) throw error; });
    }
    if (row.dns_record_id) {
      await cloudflareFetch(env, `/zones/${row.zone_id}/dns_records/${row.dns_record_id}`, { method: "DELETE" })
        .catch((error) => { if (!(error instanceof ProviderError && error.status === 404)) throw error; });
    }
    await env.DB.prepare(
      "DELETE FROM tunnel_cloudflare_frontends WHERE node_id = ? AND tunnel_id = ? AND operation_id = ?",
    ).bind(row.node_id, row.tunnel_id, operationId).run();
  } catch (error) {
    await env.DB.prepare(
      `UPDATE tunnel_cloudflare_frontends SET status = 'error', operation_id = NULL, last_error = ?, updated_at = ?
       WHERE node_id = ? AND tunnel_id = ? AND operation_id = ?`,
    ).bind(providerMessage(error), now, row.node_id, row.tunnel_id, operationId).run();
    throw error;
  }
}
