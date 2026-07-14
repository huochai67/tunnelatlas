import { authenticateAgent } from "./auth";
import { randomId, randomToken, sha256Hex } from "./crypto";
import { bearer, HttpError, json, problem, readJson } from "./http";
import type { EnrollmentBody, Env, ReportBody } from "./types";
import { validateEnrollment, validateReport } from "./validation";

function requireToken(request: Request, expected: string): void {
  if (!expected || bearer(request) !== expected) throw new HttpError(401, "Invalid bearer token");
}

async function createSite(request: Request, env: Env): Promise<Response> {
  requireToken(request, env.ADMIN_TOKEN);
  const body = await readJson<{ id: string; name: string }>(request);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(body.id) || !body.name?.trim()) throw new HttpError(400, "Invalid site");
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO sites (id, name, created_at) VALUES (?, ?, ?)").bind(body.id, body.name.trim(), now).run();
  return json({ id: body.id, name: body.name.trim(), createdAt: now }, 201);
}

async function createEnrollmentToken(request: Request, env: Env, siteId: string): Promise<Response> {
  requireToken(request, env.ADMIN_TOKEN);
  if (!(await env.DB.prepare("SELECT id FROM sites WHERE id = ?").bind(siteId).first())) throw new HttpError(404, "Site not found");
  const token = randomToken();
  const hash = await sha256Hex(`${env.ENROLLMENT_PEPPER}:${token}`);
  const now = new Date();
  const expires = new Date(now.getTime() + 10 * 60_000);
  await env.DB.prepare("INSERT INTO enrollment_tokens (token_hash, site_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(hash, siteId, expires.toISOString(), now.toISOString()).run();
  return json({ token, siteId, expiresAt: expires.toISOString() }, 201);
}

async function exchangeEnrollment(request: Request, env: Env): Promise<Response> {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Enrollment ")) throw new HttpError(401, "Missing enrollment token");
  const tokenHash = await sha256Hex(`${env.ENROLLMENT_PEPPER}:${authorization.slice(11)}`);
  const body = await readJson<EnrollmentBody>(request);
  validateEnrollment(body);
  const token = await env.DB.prepare(
    "SELECT site_id, expires_at, used_at FROM enrollment_tokens WHERE token_hash = ?",
  ).bind(tokenHash).first<{ site_id: string; expires_at: string; used_at: string | null }>();
  if (!token || token.used_at || Date.parse(token.expires_at) <= Date.now() || token.site_id !== body.siteId) {
    throw new HttpError(401, "Enrollment token is invalid or expired");
  }
  const now = new Date().toISOString();
  const agentId = randomId("agent");
  const consumed = await env.DB.prepare(
    "UPDATE enrollment_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING site_id",
  ).bind(now, tokenHash, now).first<{ site_id: string }>();
  if (!consumed || consumed.site_id !== body.siteId) throw new HttpError(409, "Enrollment token was already consumed");
  await env.DB.prepare(
    "INSERT INTO agents (id, site_id, name, public_key, platform_json, labels_json, agent_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(agentId, body.siteId, body.name, body.publicKey, JSON.stringify(body.platform), JSON.stringify(body.labels ?? {}), body.platform.agentVersion, now).run();
  return json({ agentId }, 201);
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

  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      "UPDATE agents SET last_sequence = ?, last_seen_at = ?, agent_version = ?, labels_json = ? WHERE id = ? AND last_sequence < ?",
    ).bind(agent.sequence, now, body.agentVersion, JSON.stringify(body.labels ?? {}), agent.id, agent.sequence),
  ];
  for (const tunnel of body.tunnels) {
    statements.push(env.DB.prepare(
      `INSERT INTO tunnels (id, agent_id, site_id, name, kind, endpoint, protocol, status, metadata_json, last_seen_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM agents WHERE id = ? AND last_sequence = ?
       ON CONFLICT(agent_id, id) DO UPDATE SET name=excluded.name, kind=excluded.kind,
         endpoint=excluded.endpoint, protocol=excluded.protocol, status=excluded.status,
         metadata_json=excluded.metadata_json, last_seen_at=excluded.last_seen_at`,
    ).bind(tunnel.id, agent.id, agent.site_id, tunnel.name, tunnel.kind, tunnel.endpoint, tunnel.protocol,
      tunnel.status, JSON.stringify(tunnel.metadata ?? {}), now, agent.id, agent.sequence));
  }
  const ids = body.tunnels.map((tunnel) => tunnel.id);
  if (ids.length === 0) {
    statements.push(env.DB.prepare(
      "DELETE FROM tunnels WHERE agent_id = ? AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND last_sequence = ?)",
    ).bind(agent.id, agent.id, agent.sequence));
  } else {
    statements.push(env.DB.prepare(
      `DELETE FROM tunnels WHERE agent_id = ? AND id NOT IN (${ids.map(() => "?").join(",")})
       AND EXISTS (SELECT 1 FROM agents WHERE id = ? AND last_sequence = ?)`,
    ).bind(agent.id, ...ids, agent.id, agent.sequence));
  }
  const results = await env.DB.batch(statements);
  if (Number(results[0]?.meta.changes ?? 0) !== 1) throw new HttpError(409, "A newer report was accepted first");
  return json({ acceptedSequence: agent.sequence, serverTime: now });
}

async function listTunnels(request: Request, env: Env): Promise<Response> {
  const token = bearer(request);
  if (!token || (token !== env.READ_TOKEN && token !== env.ADMIN_TOKEN)) throw new HttpError(401, "Invalid bearer token");
  const url = new URL(request.url);
  const siteId = url.searchParams.get("siteId");
  const offlineSeconds = Math.max(30, Number(env.AGENT_OFFLINE_SECONDS ?? 180));
  const cutoff = new Date(Date.now() - offlineSeconds * 1000).toISOString();
  const query = `SELECT t.id, t.agent_id, t.site_id, t.name, t.kind, t.endpoint, t.protocol,
    t.status, t.metadata_json, t.last_seen_at, a.name AS agent_name
    FROM tunnels t JOIN agents a ON a.id = t.agent_id
    WHERE a.revoked_at IS NULL AND a.last_seen_at >= ? ${siteId ? "AND t.site_id = ?" : ""}
    ORDER BY t.site_id, t.name LIMIT 1000`;
  const statement = siteId ? env.DB.prepare(query).bind(cutoff, siteId) : env.DB.prepare(query).bind(cutoff);
  const result = await statement.all<Record<string, unknown>>();
  const tunnels = result.results.map((row) => ({
    id: row.id, agentId: row.agent_id, agentName: row.agent_name, siteId: row.site_id,
    name: row.name, kind: row.kind, endpoint: row.endpoint, protocol: row.protocol,
    status: row.status, metadata: JSON.parse(String(row.metadata_json)), lastSeenAt: row.last_seen_at,
  }));
  return json({ tunnels, serverTime: new Date().toISOString() });
}

async function adminOverview(request: Request, env: Env): Promise<Response> {
  requireToken(request, env.ADMIN_TOKEN);
  const offlineSeconds = Math.max(30, Number(env.AGENT_OFFLINE_SECONDS ?? 180));
  const now = Date.now();
  const [sitesResult, agentsResult, tunnelsResult] = await Promise.all([
    env.DB.prepare("SELECT id, name, created_at FROM sites ORDER BY name LIMIT 500").all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT a.id, a.site_id, a.name, a.labels_json, a.agent_version, a.last_seen_at, a.created_at, a.revoked_at,
       COUNT(t.id) AS tunnel_count
       FROM agents a LEFT JOIN tunnels t ON t.agent_id = a.id
       GROUP BY a.id ORDER BY a.name LIMIT 1000`,
    ).all<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT t.id, t.agent_id, t.site_id, t.name, t.kind, t.endpoint, t.protocol,
       t.status, t.metadata_json, t.last_seen_at, a.name AS agent_name
       FROM tunnels t JOIN agents a ON a.id = t.agent_id
       WHERE a.revoked_at IS NULL ORDER BY t.site_id, t.name LIMIT 1000`,
    ).all<Record<string, unknown>>(),
  ]);
  const agents = agentsResult.results.map((row) => {
    const ageSeconds = row.last_seen_at ? Math.max(0, (now - Date.parse(String(row.last_seen_at))) / 1000) : Number.POSITIVE_INFINITY;
    const connectionStatus = row.revoked_at ? "revoked" : ageSeconds <= offlineSeconds / 2 ? "online" : ageSeconds <= offlineSeconds ? "stale" : "offline";
    return {
      id: row.id, siteId: row.site_id, name: row.name, labels: JSON.parse(String(row.labels_json)),
      agentVersion: row.agent_version, lastSeenAt: row.last_seen_at, createdAt: row.created_at,
      revokedAt: row.revoked_at, tunnelCount: Number(row.tunnel_count), connectionStatus,
    };
  });
  const tunnels = tunnelsResult.results.map((row) => ({
    id: row.id, agentId: row.agent_id, agentName: row.agent_name, siteId: row.site_id,
    name: row.name, kind: row.kind, endpoint: row.endpoint, protocol: row.protocol,
    status: row.status, metadata: JSON.parse(String(row.metadata_json)), lastSeenAt: row.last_seen_at,
  }));
  return json({
    sites: sitesResult.results.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at })),
    agents,
    tunnels,
    offlineSeconds,
    serverTime: new Date(now).toISOString(),
  });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") return json({ status: "ok" });
  if (request.method === "POST" && url.pathname === "/v1/admin/sites") return createSite(request, env);
  if (request.method === "GET" && url.pathname === "/v1/admin/overview") return adminOverview(request, env);
  const enrollmentMatch = url.pathname.match(/^\/v1\/admin\/sites\/([^/]+)\/enrollment-tokens$/);
  if (request.method === "POST" && enrollmentMatch) return createEnrollmentToken(request, env, decodeURIComponent(enrollmentMatch[1]));
  if (request.method === "POST" && url.pathname === "/v1/enrollments:exchange") return exchangeEnrollment(request, env);
  if (request.method === "POST" && url.pathname === "/v1/agent/report") return report(request, env);
  if (request.method === "GET" && url.pathname === "/v1/tunnels") return listTunnels(request, env);
  return problem(404, "Not Found");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await route(request, env); }
    catch (error) {
      if (error instanceof HttpError) return problem(error.status, error.message);
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) return problem(409, "Resource already exists");
      console.error("unhandled request error", error);
      return problem(500, "Internal Server Error");
    }
  },
} satisfies ExportedHandler<Env>;
