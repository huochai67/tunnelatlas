import { authenticateAgent } from "./auth";
import {
  deprovisionFrontend, frontendTarget, leaseFresh, originAuthority, providerMessage, provisionFrontend,
  type CloudflareFrontendRow, ConfigError, ProviderError,
} from "./cloudflare";
import { decryptJson, encryptJson, randomId, randomToken, sha256Hex } from "./crypto";
import { externallyReachableEndpoint, observedAddress, validFrontendAddress } from "./endpoints";
import { bearer, HttpError, json, problem, readJson } from "./http";
import { encodeSubscription, type SubscriptionTunnel } from "./subscription";
import type { CloudflareFrontendState, EnrollmentBody, Env, ReportBody } from "./types";
import { validateEnrollment, validateReport } from "./validation";

const RESOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

interface EnrollmentToken {
  hash: string;
  token: string;
  createdAt: string;
  expiresAt: string;
}

function requireToken(request: Request, expected: string): void {
  if (!expected || bearer(request) !== expected) throw new HttpError(401, "Invalid bearer token");
}

function resourceId(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); }
  catch { throw new HttpError(400, "Invalid resource ID"); }
  if (!RESOURCE_ID.test(decoded)) throw new HttpError(400, "Invalid resource ID");
  return decoded;
}

function tunnelIdParam(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); }
  catch { throw new HttpError(400, "Invalid tunnel ID"); }
  if (!decoded || decoded.length > 128 || decoded.includes("/")) throw new HttpError(400, "Invalid tunnel ID");
  return decoded;
}

function transportPath(metadata: unknown): string {
  const meta = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown> : {};
  const transport = meta.transport && typeof meta.transport === "object" && !Array.isArray(meta.transport)
    ? meta.transport as Record<string, unknown> : {};
  return typeof transport.path === "string" ? transport.path : "";
}

function cloudflareStatus(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof ConfigError) throw new HttpError(503, error.message);
  if (error instanceof ProviderError) throw new HttpError(502, `Cloudflare: ${error.message}`);
  console.error("cloudflare provisioning failed", error);
  throw new HttpError(502, "Cloudflare provisioning failed");
}

function preferredFrontendAddress(env: Env): string | null {
  const value = env.CLOUDFLARE_PREFERRED_ADDRESS?.trim();
  if (!value) return null;
  if (!validFrontendAddress(value)) {
    console.error("ignoring invalid CLOUDFLARE_PREFERRED_ADDRESS", value);
    return null;
  }
  return value;
}

async function claimFrontend(
  env: Env,
  nodeId: string,
  tunnelId: string,
  status: "provisioning" | "deleting",
  insert: { hostname: string; zoneName: string; sourceEndpoint: string; sourcePath: string } | null,
): Promise<{ row: CloudflareFrontendRow | null; operationId: string }> {
  const row = await env.DB.prepare("SELECT * FROM tunnel_cloudflare_frontends WHERE node_id = ? AND tunnel_id = ?")
    .bind(nodeId, tunnelId).first<CloudflareFrontendRow>();
  if (row && (row.status === "provisioning" || row.status === "deleting") && row.operation_id && leaseFresh(row.updated_at)) {
    throw new HttpError(409, "A Cloudflare operation is already in progress");
  }
  const operationId = randomToken(24);
  const now = new Date().toISOString();
  if (!row) {
    if (!insert) throw new HttpError(409, "Cloudflare frontend not found");
    await env.DB.prepare(
      `INSERT OR IGNORE INTO tunnel_cloudflare_frontends
       (node_id, tunnel_id, hostname, zone_id, zone_name, status, operation_id, source_endpoint, source_path, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, 'provisioning', ?, ?, ?, ?, ?)`,
    ).bind(nodeId, tunnelId, insert.hostname, insert.zoneName, operationId, insert.sourceEndpoint, insert.sourcePath, now, now).run();
  }
  await env.DB.prepare(
    `UPDATE tunnel_cloudflare_frontends SET status = ?, operation_id = ?, updated_at = ? WHERE node_id = ? AND tunnel_id = ?`,
  ).bind(status, operationId, now, nodeId, tunnelId).run();
  return { row, operationId };
}

async function publicFrontendState(env: Env, nodeId: string, tunnelId: string): Promise<CloudflareFrontendState> {
  const row = await env.DB.prepare(
    "SELECT hostname, status, source_endpoint, last_error, updated_at FROM tunnel_cloudflare_frontends WHERE node_id = ? AND tunnel_id = ?",
  ).bind(nodeId, tunnelId).first<Record<string, unknown>>();
  return {
    hostname: row ? String(row.hostname) : "",
    status: row ? String(row.status) : "error",
    sourceEndpoint: row ? String(row.source_endpoint) : "",
    error: row?.last_error ? String(row.last_error) : null,
    updatedAt: row?.updated_at ? String(row.updated_at) : null,
  };
}

async function provisionCloudflare(
  request: Request, env: Env, encodedNodeId: string, encodedTunnelId: string,
): Promise<Response> {
  requireToken(request, env.ADMIN_TOKEN);
  const nodeId = resourceId(encodedNodeId);
  const tunnelId = tunnelIdParam(encodedTunnelId);
  const zoneName = env.CLOUDFLARE_ZONE_NAME;
  if (!env.CLOUDFLARE_API_TOKEN || !zoneName) throw new HttpError(503, "Cloudflare frontend is not configured");
  const tunnel = await env.DB.prepare("SELECT protocol, endpoint, metadata_json FROM tunnels WHERE node_id = ? AND id = ?")
    .bind(nodeId, tunnelId).first<{ protocol: string; endpoint: string; metadata_json: string }>();
  if (!tunnel) throw new HttpError(404, "Tunnel not found");
  const target = await frontendTarget(nodeId, tunnelId, zoneName, {
    protocol: tunnel.protocol,
    endpoint: tunnel.endpoint,
    metadata: JSON.parse(tunnel.metadata_json),
  });
  const { operationId } = await claimFrontend(env, nodeId, tunnelId, "provisioning", {
    hostname: target.hostname,
    zoneName: zoneName.trim().replace(/\.+$/, ""),
    sourceEndpoint: originAuthority(target.origin),
    sourcePath: target.path,
  });
  try {
    await provisionFrontend(env, { nodeId, tunnelId, operationId, target });
  } catch (error) {
    throw cloudflareStatus(error);
  }
  return json({ frontend: await publicFrontendState(env, nodeId, tunnelId) });
}

async function deprovisionCloudflare(
  request: Request, env: Env, encodedNodeId: string, encodedTunnelId: string,
): Promise<Response> {
  requireToken(request, env.ADMIN_TOKEN);
  const nodeId = resourceId(encodedNodeId);
  const tunnelId = tunnelIdParam(encodedTunnelId);
  const row = await env.DB.prepare("SELECT * FROM tunnel_cloudflare_frontends WHERE node_id = ? AND tunnel_id = ?")
    .bind(nodeId, tunnelId).first<CloudflareFrontendRow>();
  if (!row) throw new HttpError(404, "Cloudflare frontend not found");
  const { operationId } = await claimFrontend(env, nodeId, tunnelId, "deleting", null);
  try {
    await deprovisionFrontend(env, row, operationId);
  } catch (error) {
    throw cloudflareStatus(error);
  }
  return json({ deleted: true, nodeId, tunnelId });
}

async function deprovisionAllFrontends(env: Env, nodeId: string): Promise<void> {
  const result = await env.DB.prepare("SELECT * FROM tunnel_cloudflare_frontends WHERE node_id = ?")
    .bind(nodeId).all<CloudflareFrontendRow>();
  for (const row of result.results) {
    const { operationId } = await claimFrontend(env, nodeId, row.tunnel_id, "deleting", null);
    try {
      await deprovisionFrontend(env, row, operationId);
    } catch (error) {
      throw cloudflareStatus(error);
    }
  }
}

async function enrollmentToken(env: Env): Promise<EnrollmentToken> {
  const token = randomToken();
  const hash = await sha256Hex(`${env.ENROLLMENT_PEPPER}:${token}`);
  const now = new Date();
  return {
    hash,
    token,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
  };
}

async function createNode(request: Request, env: Env): Promise<Response> {
  requireToken(request, env.ADMIN_TOKEN);
  const body = await readJson<{ name: string }>(request);
  const name = body && typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 255) throw new HttpError(400, "Invalid node name");
  const id = randomId("node");
  const createdAt = new Date().toISOString();
  const enrollment = await enrollmentToken(env);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO nodes (id, name, enrollment_generation, created_at) VALUES (?, ?, ?, ?)")
      .bind(id, name, enrollment.hash, createdAt),
    env.DB.prepare("INSERT INTO enrollment_tokens (token_hash, node_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(enrollment.hash, id, enrollment.expiresAt, enrollment.createdAt),
  ]);
  return json({
    node: { id, name, connectionStatus: "pending", createdAt },
    token: enrollment.token,
    expiresAt: enrollment.expiresAt,
  }, 201);
}

async function createEnrollmentToken(request: Request, env: Env, encodedNodeId: string): Promise<Response> {
  requireToken(request, env.ADMIN_TOKEN);
  const nodeId = resourceId(encodedNodeId);
  const node = await env.DB.prepare("SELECT id, public_key FROM nodes WHERE id = ?").bind(nodeId)
    .first<{ id: string; public_key: string | null }>();
  if (!node) throw new HttpError(404, "Node not found");
  if (node.public_key) throw new HttpError(409, "Node is already enrolled");
  const enrollment = await enrollmentToken(env);
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE nodes SET enrollment_generation = ? WHERE id = ? AND public_key IS NULL")
      .bind(enrollment.hash, nodeId),
    env.DB.prepare(
      "DELETE FROM enrollment_tokens WHERE node_id = ? AND EXISTS (SELECT 1 FROM nodes WHERE id = ? AND enrollment_generation = ?)",
    ).bind(nodeId, nodeId, enrollment.hash),
    env.DB.prepare(
      `INSERT INTO enrollment_tokens (token_hash, node_id, expires_at, created_at)
       SELECT ?, id, ?, ? FROM nodes WHERE id = ? AND public_key IS NULL AND enrollment_generation = ?`,
    ).bind(enrollment.hash, enrollment.expiresAt, enrollment.createdAt, nodeId, enrollment.hash),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[2]?.meta.changes ?? 0) !== 1) {
    throw new HttpError(409, "Node enrollment state changed");
  }
  return json({ token: enrollment.token, nodeId, expiresAt: enrollment.expiresAt }, 201);
}

async function resetEnrollment(request: Request, env: Env, encodedNodeId: string): Promise<Response> {
  requireToken(request, env.ADMIN_TOKEN);
  const nodeId = resourceId(encodedNodeId);
  const node = await env.DB.prepare("SELECT id, name, public_key FROM nodes WHERE id = ?").bind(nodeId)
    .first<{ id: string; name: string; public_key: string | null }>();
  if (!node) throw new HttpError(404, "Node not found");
  if (!node.public_key) throw new HttpError(409, "Node is not enrolled");
  await deprovisionAllFrontends(env, nodeId);
  const enrollment = await enrollmentToken(env);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE nodes SET public_key = NULL, platform_json = NULL, labels_json = '{}', agent_version = NULL,
       last_sequence = 0, last_seen_at = NULL, enrolled_at = NULL, enrollment_generation = ?
       WHERE id = ? AND public_key = ?`,
    ).bind(enrollment.hash, nodeId, node.public_key),
    env.DB.prepare(
      "DELETE FROM enrollment_tokens WHERE node_id = ? AND EXISTS (SELECT 1 FROM nodes WHERE id = ? AND enrollment_generation = ?)",
    ).bind(nodeId, nodeId, enrollment.hash),
    env.DB.prepare(
      "DELETE FROM tunnels WHERE node_id = ? AND EXISTS (SELECT 1 FROM nodes WHERE id = ? AND enrollment_generation = ?)",
    ).bind(nodeId, nodeId, enrollment.hash),
    env.DB.prepare(
      `INSERT INTO enrollment_tokens (token_hash, node_id, expires_at, created_at)
       SELECT ?, id, ?, ? FROM nodes WHERE id = ? AND enrollment_generation = ?`,
    ).bind(enrollment.hash, enrollment.expiresAt, enrollment.createdAt, nodeId, enrollment.hash),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[3]?.meta.changes ?? 0) !== 1) {
    throw new HttpError(409, "Node enrollment state changed");
  }
  return json({
    node: { id: node.id, name: node.name, connectionStatus: "pending" },
    token: enrollment.token,
    expiresAt: enrollment.expiresAt,
  });
}

async function deleteNode(request: Request, env: Env, encodedNodeId: string): Promise<Response> {
  requireToken(request, env.ADMIN_TOKEN);
  const nodeId = resourceId(encodedNodeId);
  await deprovisionAllFrontends(env, nodeId);
  const deleted = await env.DB.prepare("DELETE FROM nodes WHERE id = ? RETURNING id, name")
    .bind(nodeId).first<{ id: string; name: string }>();
  if (!deleted) throw new HttpError(404, "Node not found");
  return json({ deleted: true, id: deleted.id, name: deleted.name });
}

async function exchangeEnrollment(request: Request, env: Env): Promise<Response> {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Enrollment ")) throw new HttpError(401, "Missing enrollment token");
  const tokenHash = await sha256Hex(`${env.ENROLLMENT_PEPPER}:${authorization.slice(11)}`);
  const body = await readJson<EnrollmentBody>(request);
  validateEnrollment(body);
  const token = await env.DB.prepare(
    `SELECT e.node_id, e.expires_at, e.used_at, n.public_key
     FROM enrollment_tokens e JOIN nodes n ON n.id = e.node_id
     WHERE e.token_hash = ? AND n.enrollment_generation = e.token_hash`,
  ).bind(tokenHash).first<{ node_id: string; expires_at: string; used_at: string | null; public_key: string | null }>();
  if (!token || token.used_at || Date.parse(token.expires_at) <= Date.now()) {
    throw new HttpError(401, "Enrollment token is invalid or expired");
  }
  if (token.public_key) throw new HttpError(409, "Node is already enrolled");
  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE nodes SET public_key = ?, platform_json = ?, labels_json = ?, agent_version = ?, enrolled_at = ?,
       enrollment_generation = NULL WHERE id = ? AND public_key IS NULL AND enrollment_generation = ?
       AND EXISTS (SELECT 1 FROM enrollment_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?)`,
    ).bind(body.publicKey, JSON.stringify(body.platform), JSON.stringify(body.labels ?? {}), body.platform.agentVersion,
      now, token.node_id, tokenHash, tokenHash, now),
    env.DB.prepare(
      `UPDATE enrollment_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
       AND EXISTS (SELECT 1 FROM nodes WHERE id = ? AND public_key = ?)`,
    ).bind(now, tokenHash, now, token.node_id, body.publicKey),
  ]);
  if (Number(results[0]?.meta.changes ?? 0) !== 1 || Number(results[1]?.meta.changes ?? 0) !== 1) {
    throw new HttpError(409, "Enrollment token was already consumed");
  }
  return json({ agentId: token.node_id }, 201);
}

async function reconcileReprovision(env: Env, row: CloudflareFrontendRow, operationId: string): Promise<void> {
  const current = await env.DB.prepare("SELECT * FROM tunnel_cloudflare_frontends WHERE node_id = ? AND tunnel_id = ?")
    .bind(row.node_id, row.tunnel_id).first<CloudflareFrontendRow>();
  if (!current || current.status !== "provisioning" || current.operation_id !== operationId) return;
  const tunnel = await env.DB.prepare("SELECT protocol, endpoint, metadata_json FROM tunnels WHERE node_id = ? AND id = ?")
    .bind(row.node_id, row.tunnel_id).first<{ protocol: string; endpoint: string; metadata_json: string }>();
  if (!tunnel) {
    await deprovisionWithLease(env, current, operationId);
    return;
  }
  try {
    const target = await frontendTarget(row.node_id, row.tunnel_id, env.CLOUDFLARE_ZONE_NAME ?? "", {
      protocol: tunnel.protocol,
      endpoint: tunnel.endpoint,
      metadata: JSON.parse(tunnel.metadata_json),
    });
    await provisionFrontend(env, { nodeId: row.node_id, tunnelId: row.tunnel_id, operationId, target });
  } catch (error) {
    await env.DB.prepare(
      `UPDATE tunnel_cloudflare_frontends SET status = 'error', operation_id = NULL, last_error = ?, updated_at = ?
       WHERE node_id = ? AND tunnel_id = ? AND operation_id = ?`,
    ).bind(providerMessage(error), new Date().toISOString(), row.node_id, row.tunnel_id, operationId).run();
  }
}

async function deprovisionWithLease(env: Env, row: CloudflareFrontendRow, operationId: string): Promise<void> {
  try {
    await deprovisionFrontend(env, row, operationId);
  } catch (error) {
    // deprovisionFrontend persists status=error itself; keep tracking for admin retry
    console.error("cloudflare deprovision failed", error);
  }
}

async function reconcileDeprovision(env: Env, row: CloudflareFrontendRow, operationId: string): Promise<void> {
  const current = await env.DB.prepare("SELECT * FROM tunnel_cloudflare_frontends WHERE node_id = ? AND tunnel_id = ?")
    .bind(row.node_id, row.tunnel_id).first<CloudflareFrontendRow>();
  if (!current || current.status !== "deleting" || current.operation_id !== operationId) return;
  const reappeared = await env.DB.prepare("SELECT 1 AS present FROM tunnels WHERE node_id = ? AND id = ?")
    .bind(row.node_id, row.tunnel_id).first<{ present: number }>();
  if (reappeared) {
    await env.DB.prepare(
      `UPDATE tunnel_cloudflare_frontends SET status = 'active', operation_id = NULL, updated_at = ?
       WHERE node_id = ? AND tunnel_id = ? AND operation_id = ?`,
    ).bind(new Date().toISOString(), row.node_id, row.tunnel_id, operationId).run();
    return;
  }
  await deprovisionWithLease(env, current, operationId);
}

async function report(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 256 * 1024) throw new HttpError(413, "Report too large");
  const agent = await authenticateAgent(request, env, bytes);
  let body: ReportBody;
  try { body = JSON.parse(new TextDecoder().decode(bytes)) as ReportBody; }
  catch { throw new HttpError(400, "Invalid JSON body"); }
  validateReport(body);
  const now = new Date().toISOString();
  const tunnels = body.tunnels.filter((tunnel) => tunnel.kind === "sing-box/inbound");
  const encryptedTunnels = await Promise.all(tunnels.map(async (tunnel) => ({
    tunnel: {
      ...tunnel,
      endpoint: externallyReachableEndpoint(tunnel.endpoint, request.headers.get("CF-Connecting-IP")),
    },
    authenticationCiphertext: await encryptJson(tunnel.authentication ?? {}, env.CREDENTIALS_KEY, `${agent.id}:${tunnel.id}`),
  })));
  const reported = new Map<string, { endpoint: string; path: string }>();
  for (const { tunnel } of encryptedTunnels) {
    reported.set(tunnel.id, { endpoint: tunnel.endpoint, path: transportPath(tunnel.metadata) });
  }

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE nodes SET last_sequence = ?, last_seen_at = ?, agent_version = ?, labels_json = ?
       WHERE id = ? AND public_key = ? AND last_sequence < ?`,
    ).bind(agent.sequence, now, body.agentVersion, JSON.stringify(body.labels ?? {}), agent.id, agent.public_key, agent.sequence),
  ];
  const frontendResult = await env.DB.prepare("SELECT * FROM tunnel_cloudflare_frontends WHERE node_id = ?")
    .bind(agent.id).all<CloudflareFrontendRow>();
  const reprovision: Array<{ row: CloudflareFrontendRow; operationId: string }> = [];
  const deprovision: Array<{ row: CloudflareFrontendRow; operationId: string }> = [];
  for (const row of frontendResult.results) {
    const current = reported.get(row.tunnel_id);
    if (!current) {
      if (row.status === "provisioning" || row.status === "deleting") continue;
      const operationId = randomToken(24);
      deprovision.push({ row, operationId });
      statements.push(env.DB.prepare(
        `UPDATE tunnel_cloudflare_frontends SET status = 'deleting', operation_id = ?, updated_at = ? WHERE node_id = ? AND tunnel_id = ?`,
      ).bind(operationId, now, agent.id, row.tunnel_id));
      continue;
    }
    if ((row.status === "active" || row.status === "error")
      && (row.source_endpoint !== current.endpoint || row.source_path !== current.path)) {
      const operationId = randomToken(24);
      reprovision.push({ row, operationId });
      statements.push(env.DB.prepare(
        `UPDATE tunnel_cloudflare_frontends SET status = 'provisioning', operation_id = ?, source_endpoint = ?, source_path = ?, updated_at = ? WHERE node_id = ? AND tunnel_id = ?`,
      ).bind(operationId, current.endpoint, current.path, now, agent.id, row.tunnel_id));
    }
  }
  for (const { tunnel, authenticationCiphertext } of encryptedTunnels) {
    statements.push(env.DB.prepare(
      `INSERT INTO tunnels (id, node_id, name, kind, endpoint, protocol, status, metadata_json, authentication_ciphertext, last_seen_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM nodes WHERE id = ? AND public_key = ? AND last_sequence = ?
       ON CONFLICT(node_id, id) DO UPDATE SET name=excluded.name, kind=excluded.kind,
         endpoint=excluded.endpoint, protocol=excluded.protocol, status=excluded.status,
         metadata_json=excluded.metadata_json, authentication_ciphertext=excluded.authentication_ciphertext,
         last_seen_at=excluded.last_seen_at`,
    ).bind(tunnel.id, agent.id, tunnel.name, tunnel.kind, tunnel.endpoint, tunnel.protocol, tunnel.status,
      JSON.stringify(tunnel.metadata ?? {}), authenticationCiphertext, now, agent.id, agent.public_key, agent.sequence));
  }
  const ids = tunnels.map((tunnel) => tunnel.id);
  if (ids.length === 0) {
    statements.push(env.DB.prepare(
      "DELETE FROM tunnels WHERE node_id = ? AND EXISTS (SELECT 1 FROM nodes WHERE id = ? AND public_key = ? AND last_sequence = ?)",
    ).bind(agent.id, agent.id, agent.public_key, agent.sequence));
  } else {
    statements.push(env.DB.prepare(
      `DELETE FROM tunnels WHERE node_id = ? AND id NOT IN (${ids.map(() => "?").join(",")})
       AND EXISTS (SELECT 1 FROM nodes WHERE id = ? AND public_key = ? AND last_sequence = ?)`,
    ).bind(agent.id, ...ids, agent.id, agent.public_key, agent.sequence));
  }
  const results = await env.DB.batch(statements);
  if (Number(results[0]?.meta.changes ?? 0) !== 1) throw new HttpError(409, "A newer report was accepted first");
  const reconciliation = async (): Promise<void> => {
    try {
      for (const { row, operationId } of reprovision) await reconcileReprovision(env, row, operationId);
      for (const { row, operationId } of deprovision) await reconcileDeprovision(env, row, operationId);
    } catch (error) {
      console.error("cloudflare reconciliation failed", error);
    }
  };
  if (ctx) ctx.waitUntil(reconciliation());
  else void reconciliation();
  return json({
    acceptedSequence: agent.sequence,
    serverTime: now,
    observedAddress: observedAddress(request.headers.get("CF-Connecting-IP")),
  });
}

async function tunnelFromRow(row: Record<string, unknown>, env: Env): Promise<Record<string, unknown>> {
  const authentication = row.authentication_ciphertext
    ? await decryptJson(String(row.authentication_ciphertext), env.CREDENTIALS_KEY, `${row.node_id}:${row.id}`)
    : {};
  const cloudflare: CloudflareFrontendState | null = row.cf_hostname ? {
    hostname: String(row.cf_hostname),
    status: String(row.cf_status),
    sourceEndpoint: String(row.cf_source_endpoint),
    error: row.cf_last_error ? String(row.cf_last_error) : null,
    updatedAt: row.cf_updated_at ? String(row.cf_updated_at) : null,
  } : null;
  return {
    id: row.id, nodeId: row.node_id, nodeName: row.node_name,
    name: row.name, kind: row.kind, endpoint: row.endpoint, protocol: row.protocol,
    status: row.status, metadata: JSON.parse(String(row.metadata_json)), authentication,
    lastSeenAt: row.last_seen_at, cloudflare,
  };
}

function tunnelQuery(filter: boolean, onlineOnly: boolean): string {
  return `SELECT t.id, t.node_id, t.name, t.kind, t.endpoint, t.protocol, t.status,
    t.metadata_json, t.authentication_ciphertext, t.last_seen_at, n.name AS node_name,
    cf.hostname AS cf_hostname, cf.status AS cf_status, cf.source_endpoint AS cf_source_endpoint,
    cf.source_path AS cf_source_path, cf.last_error AS cf_last_error, cf.updated_at AS cf_updated_at
    FROM tunnels t JOIN nodes n ON n.id = t.node_id
    LEFT JOIN tunnel_cloudflare_frontends cf ON cf.node_id = t.node_id AND cf.tunnel_id = t.id
    WHERE n.public_key IS NOT NULL ${onlineOnly ? "AND n.last_seen_at >= ?" : ""} ${filter ? "AND t.node_id = ?" : ""}
    ORDER BY n.name, t.name LIMIT 1000`;
}

async function listTunnels(request: Request, env: Env): Promise<Response> {
  const token = bearer(request);
  if (!token || (token !== env.READ_TOKEN && token !== env.ADMIN_TOKEN)) throw new HttpError(401, "Invalid bearer token");
  const url = new URL(request.url);
  const nodeId = url.searchParams.get("nodeId");
  const offlineSeconds = Math.max(30, Number(env.AGENT_OFFLINE_SECONDS ?? 180));
  const cutoff = new Date(Date.now() - offlineSeconds * 1000).toISOString();
  const statement = nodeId
    ? env.DB.prepare(tunnelQuery(true, true)).bind(cutoff, nodeId)
    : env.DB.prepare(tunnelQuery(false, true)).bind(cutoff);
  const result = await statement.all<Record<string, unknown>>();
  const tunnels = await Promise.all(result.results.map((row) => tunnelFromRow(row, env)));
  return json({ tunnels, serverTime: new Date().toISOString() });
}

async function nodeSubscription(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const queryTokens = url.searchParams.getAll("token");
  const queryToken = queryTokens.length === 1 ? queryTokens[0] : null;
  if (!env.READ_TOKEN || (bearer(request) !== env.READ_TOKEN && queryToken !== env.READ_TOKEN)) {
    throw new HttpError(401, "Invalid subscription token");
  }
  const nodeId = url.searchParams.get("nodeId");
  const offlineSeconds = Math.max(30, Number(env.AGENT_OFFLINE_SECONDS ?? 180));
  const cutoff = new Date(Date.now() - offlineSeconds * 1000).toISOString();
  const statement = nodeId
    ? env.DB.prepare(tunnelQuery(true, true)).bind(cutoff, nodeId)
    : env.DB.prepare(tunnelQuery(false, true)).bind(cutoff);
  const result = await statement.all<Record<string, unknown>>();
  const preferredAddress = preferredFrontendAddress(env);
  const tunnels = await Promise.all(result.results.map(async (row): Promise<SubscriptionTunnel> => {
    const tunnel = await tunnelFromRow(row, env);
    const frontend = tunnel.cloudflare as CloudflareFrontendState | null;
    return {
      nodeName: String(tunnel.nodeName),
      authentication: tunnel.authentication,
      endpoint: String(tunnel.endpoint),
      metadata: tunnel.metadata,
      name: String(tunnel.name),
      protocol: String(tunnel.protocol),
      status: tunnel.status,
      cloudflare: frontend
        ? { hostname: frontend.hostname, status: frontend.status, address: preferredAddress }
        : null,
    };
  }));
  return new Response(encodeSubscription(tunnels), {
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function adminOverview(request: Request, env: Env): Promise<Response> {
  requireToken(request, env.ADMIN_TOKEN);
  const offlineSeconds = Math.max(30, Number(env.AGENT_OFFLINE_SECONDS ?? 180));
  const now = Date.now();
  const [nodesResult, tunnelsResult] = await Promise.all([
    env.DB.prepare(
      `SELECT n.id, n.name, n.labels_json, n.agent_version, n.last_seen_at, n.enrolled_at, n.created_at,
       n.public_key, COUNT(t.id) AS tunnel_count FROM nodes n LEFT JOIN tunnels t ON t.node_id = n.id
       GROUP BY n.id ORDER BY n.name, n.created_at LIMIT 1000`,
    ).all<Record<string, unknown>>(),
    env.DB.prepare(tunnelQuery(false, false)).all<Record<string, unknown>>(),
  ]);
  const nodes = nodesResult.results.map((row) => {
    const ageSeconds = row.last_seen_at ? Math.max(0, (now - Date.parse(String(row.last_seen_at))) / 1000) : Number.POSITIVE_INFINITY;
    const connectionStatus = !row.public_key ? "pending"
      : ageSeconds <= offlineSeconds / 2 ? "online" : ageSeconds <= offlineSeconds ? "stale" : "offline";
    return {
      id: row.id, name: row.name, labels: JSON.parse(String(row.labels_json)), agentVersion: row.agent_version,
      lastSeenAt: row.last_seen_at, enrolledAt: row.enrolled_at, createdAt: row.created_at,
      tunnelCount: Number(row.tunnel_count), connectionStatus,
    };
  });
  const tunnels = await Promise.all(tunnelsResult.results.map((row) => tunnelFromRow(row, env)));
  return json({ nodes, tunnels, offlineSeconds, serverTime: new Date(now).toISOString() });
}

async function route(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") return json({ status: "ok" });
  if (request.method === "POST" && url.pathname === "/v1/admin/nodes") return createNode(request, env);
  if (request.method === "GET" && url.pathname === "/v1/admin/overview") return adminOverview(request, env);
  const enrollmentMatch = url.pathname.match(/^\/v1\/admin\/nodes\/([^/]+)\/enrollment-tokens$/);
  if (request.method === "POST" && enrollmentMatch) return createEnrollmentToken(request, env, enrollmentMatch[1]);
  const resetMatch = url.pathname.match(/^\/v1\/admin\/nodes\/([^/]+)\/enrollment:reset$/);
  if (request.method === "POST" && resetMatch) return resetEnrollment(request, env, resetMatch[1]);
  const cloudflareMatch = url.pathname.match(/^\/v1\/admin\/nodes\/([^/]+)\/tunnels\/([^/]+)\/cloudflare$/);
  if (request.method === "PUT" && cloudflareMatch) return provisionCloudflare(request, env, cloudflareMatch[1], cloudflareMatch[2]);
  if (request.method === "DELETE" && cloudflareMatch) return deprovisionCloudflare(request, env, cloudflareMatch[1], cloudflareMatch[2]);
  const nodeMatch = url.pathname.match(/^\/v1\/admin\/nodes\/([^/]+)$/);
  if (request.method === "DELETE" && nodeMatch) return deleteNode(request, env, nodeMatch[1]);
  if (request.method === "POST" && url.pathname === "/v1/enrollments:exchange") return exchangeEnrollment(request, env);
  if (request.method === "POST" && url.pathname === "/v1/agent/report") return report(request, env, ctx);
  if (request.method === "GET" && url.pathname === "/v1/tunnels") return listTunnels(request, env);
  if (request.method === "GET" && url.pathname === "/v1/subscription") return nodeSubscription(request, env);
  return problem(404, "Not Found");
}

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    try { return await route(request, env, ctx); }
    catch (error) {
      if (error instanceof HttpError) return problem(error.status, error.message);
      console.error("unhandled request error", error);
      return problem(500, "Internal Server Error");
    }
  },
} satisfies ExportedHandler<Env>;
