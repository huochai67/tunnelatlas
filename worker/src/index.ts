import { authenticateAgent } from "./auth";
import { decryptJson, encryptJson, randomId, randomToken, sha256Hex } from "./crypto";
import { externallyReachableEndpoint, observedAddress } from "./endpoints";
import { bearer, HttpError, json, problem, readJson } from "./http";
import { encodeSubscription, type SubscriptionTunnel } from "./subscription";
import type { EnrollmentBody, Env, ReportBody } from "./types";
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

async function report(request: Request, env: Env): Promise<Response> {
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

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE nodes SET last_sequence = ?, last_seen_at = ?, agent_version = ?, labels_json = ?
       WHERE id = ? AND public_key = ? AND last_sequence < ?`,
    ).bind(agent.sequence, now, body.agentVersion, JSON.stringify(body.labels ?? {}), agent.id, agent.public_key, agent.sequence),
  ];
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
  return {
    id: row.id, nodeId: row.node_id, nodeName: row.node_name,
    name: row.name, kind: row.kind, endpoint: row.endpoint, protocol: row.protocol,
    status: row.status, metadata: JSON.parse(String(row.metadata_json)), authentication,
    lastSeenAt: row.last_seen_at,
  };
}

function tunnelQuery(filter: boolean, onlineOnly: boolean): string {
  return `SELECT t.id, t.node_id, t.name, t.kind, t.endpoint, t.protocol, t.status,
    t.metadata_json, t.authentication_ciphertext, t.last_seen_at, n.name AS node_name
    FROM tunnels t JOIN nodes n ON n.id = t.node_id
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
  const tunnels = await Promise.all(result.results.map(async (row): Promise<SubscriptionTunnel> => {
    const tunnel = await tunnelFromRow(row, env);
    return {
      nodeName: String(tunnel.nodeName),
      authentication: tunnel.authentication,
      endpoint: String(tunnel.endpoint),
      metadata: tunnel.metadata,
      name: String(tunnel.name),
      protocol: String(tunnel.protocol),
      status: tunnel.status,
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

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") return json({ status: "ok" });
  if (request.method === "POST" && url.pathname === "/v1/admin/nodes") return createNode(request, env);
  if (request.method === "GET" && url.pathname === "/v1/admin/overview") return adminOverview(request, env);
  const enrollmentMatch = url.pathname.match(/^\/v1\/admin\/nodes\/([^/]+)\/enrollment-tokens$/);
  if (request.method === "POST" && enrollmentMatch) return createEnrollmentToken(request, env, enrollmentMatch[1]);
  const resetMatch = url.pathname.match(/^\/v1\/admin\/nodes\/([^/]+)\/enrollment:reset$/);
  if (request.method === "POST" && resetMatch) return resetEnrollment(request, env, resetMatch[1]);
  const nodeMatch = url.pathname.match(/^\/v1\/admin\/nodes\/([^/]+)$/);
  if (request.method === "DELETE" && nodeMatch) return deleteNode(request, env, nodeMatch[1]);
  if (request.method === "POST" && url.pathname === "/v1/enrollments:exchange") return exchangeEnrollment(request, env);
  if (request.method === "POST" && url.pathname === "/v1/agent/report") return report(request, env);
  if (request.method === "GET" && url.pathname === "/v1/tunnels") return listTunnels(request, env);
  if (request.method === "GET" && url.pathname === "/v1/subscription") return nodeSubscription(request, env);
  return problem(404, "Not Found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await route(request, env); }
    catch (error) {
      if (error instanceof HttpError) return problem(error.status, error.message);
      console.error("unhandled request error", error);
      return problem(500, "Internal Server Error");
    }
  },
} satisfies ExportedHandler<Env>;
