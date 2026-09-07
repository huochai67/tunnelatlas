import {
  clientAuthentication,
  credentialsContext,
  hopEndpoint,
  hostedMetadata,
  parseStoredCredentials,
  pendingHop,
  readyHop,
} from "./credentials";
import { decryptJson } from "./crypto";
import { HttpError } from "./http";
import type { DesiredHop, DesiredTunnel, DesiredTunnelType, Env, HopRef, StoredCredentials, TunnelConfigRow } from "./types";
import { desiredTunnelFromRow } from "./validation";
export interface HopRow {
  entry_node_id: string;
  entry_tunnel_id: string;
  position: number;
  hop_node_id: string;
  hop_tunnel_id: string;
}

interface HopTargetRow {
  node_id: string;
  id: string;
  type: DesiredTunnelType;
  port: number;
  public_host: string | null;
  options_json: string;
  credentials_ciphertext: string | null;
  observed_endpoint: string | null;
  cf_hostname: string | null;
  cf_status: string | null;
}

export function hopRefsEqual(left: HopRef[], right: HopRef[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((hop, index) => hop.nodeId === right[index]?.nodeId && hop.tunnelId === right[index]?.tunnelId);
}

export async function loadHopRefs(env: Env, nodeId: string, tunnelId: string): Promise<HopRef[]> {
  const result = await env.DB.prepare(
    `SELECT hop_node_id, hop_tunnel_id FROM tunnel_hops
     WHERE entry_node_id = ? AND entry_tunnel_id = ?
     ORDER BY position`,
  ).bind(nodeId, tunnelId).all<{ hop_node_id: string; hop_tunnel_id: string }>();
  return result.results.map((row) => ({ nodeId: row.hop_node_id, tunnelId: row.hop_tunnel_id }));
}

export async function assertHopGraph(
  env: Env,
  entryNodeId: string,
  entryTunnelId: string,
  hops: HopRef[],
): Promise<void> {
  if (hops.length > 3) throw new HttpError(400, "A tunnel can chain at most 3 hops");
  const seen = new Set<string>();
  for (const hop of hops) {
    const key = `${hop.nodeId}:${hop.tunnelId}`;
    if (seen.has(key)) throw new HttpError(400, "Duplicate hop");
    seen.add(key);
    if (hop.nodeId === entryNodeId) throw new HttpError(400, "Hops must be on a different node");
    if (hop.tunnelId === entryTunnelId && hop.nodeId === entryNodeId) {
      throw new HttpError(400, "A tunnel cannot hop to itself");
    }
    const target = await env.DB.prepare(
      "SELECT node_id, id FROM tunnel_configs WHERE node_id = ? AND id = ?",
    ).bind(hop.nodeId, hop.tunnelId).first<{ node_id: string; id: string }>();
    if (!target) throw new HttpError(404, "Hop tunnel not found");
  }

  const all = await env.DB.prepare(
    "SELECT entry_node_id, entry_tunnel_id, hop_node_id, hop_tunnel_id FROM tunnel_hops",
  ).all<HopRow>();
  const graph = new Map<string, string[]>();
  for (const row of all.results) {
    const from = `${row.entry_node_id}:${row.entry_tunnel_id}`;
    if (from === `${entryNodeId}:${entryTunnelId}`) continue;
    const list = graph.get(from) ?? [];
    list.push(`${row.hop_node_id}:${row.hop_tunnel_id}`);
    graph.set(from, list);
  }
  graph.set(`${entryNodeId}:${entryTunnelId}`, hops.map((hop) => `${hop.nodeId}:${hop.tunnelId}`));

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node)) throw new HttpError(400, "Hop chain contains a cycle");
    if (visited.has(node)) return;
    visiting.add(node);
    for (const next of graph.get(node) ?? []) visit(next);
    visiting.delete(node);
    visited.add(node);
  };
  visit(`${entryNodeId}:${entryTunnelId}`);
}

export function hopReplaceStatements(
  env: Env,
  entryNodeId: string,
  entryTunnelId: string,
  hops: HopRef[],
): D1PreparedStatement[] {
  const statements = [
    env.DB.prepare("DELETE FROM tunnel_hops WHERE entry_node_id = ? AND entry_tunnel_id = ?")
      .bind(entryNodeId, entryTunnelId),
  ];
  hops.forEach((hop, position) => {
    statements.push(
      env.DB.prepare(
        `INSERT INTO tunnel_hops (entry_node_id, entry_tunnel_id, position, hop_node_id, hop_tunnel_id)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(entryNodeId, entryTunnelId, position, hop.nodeId, hop.tunnelId),
    );
  });
  return statements;
}

export async function hopUsage(env: Env, nodeId: string, tunnelId: string): Promise<HopRow | null> {
  return env.DB.prepare(
    "SELECT entry_node_id, entry_tunnel_id, position, hop_node_id, hop_tunnel_id FROM tunnel_hops WHERE hop_node_id = ? AND hop_tunnel_id = ? LIMIT 1",
  ).bind(nodeId, tunnelId).first<HopRow>();
}

export async function dependentEntryNodeIds(env: Env, hopNodeId: string, hopTunnelId: string): Promise<string[]> {
  const result = await env.DB.prepare(
    "SELECT DISTINCT entry_node_id FROM tunnel_hops WHERE hop_node_id = ? AND hop_tunnel_id = ?",
  ).bind(hopNodeId, hopTunnelId).all<{ entry_node_id: string }>();
  return result.results.map((row) => row.entry_node_id);
}

export function bumpNodeVersion(env: Env, nodeId: string): D1PreparedStatement {
  return env.DB.prepare("UPDATE nodes SET config_version = config_version + 1 WHERE id = ?").bind(nodeId);
}

export async function bumpDependentVersions(env: Env, hopNodeId: string, hopTunnelId: string): Promise<void> {
  const nodeIds = await dependentEntryNodeIds(env, hopNodeId, hopTunnelId);
  if (nodeIds.length === 0) return;
  await env.DB.batch(nodeIds.map((nodeId) => bumpNodeVersion(env, nodeId)));
}

async function decryptStored(
  env: Env,
  nodeId: string,
  tunnelId: string,
  ciphertext: string | null | undefined,
): Promise<StoredCredentials | null> {
  if (!ciphertext) return null;
  try {
    return parseStoredCredentials(await decryptJson(ciphertext, env.CREDENTIALS_KEY, credentialsContext(nodeId, tunnelId)));
  } catch {
    return null;
  }
}

export async function loadDesiredTunnels(env: Env, nodeId: string): Promise<DesiredTunnel[]> {
  const configs = await env.DB.prepare(
    "SELECT * FROM tunnel_configs WHERE node_id = ? ORDER BY id",
  ).bind(nodeId).all<TunnelConfigRow>();
  const hopRows = await env.DB.prepare(
    `SELECT h.entry_tunnel_id, h.position, h.hop_node_id, h.hop_tunnel_id,
            hop.type, hop.port, hop.public_host, hop.options_json, hop.credentials_ciphertext,
            t.endpoint AS observed_endpoint,
            cf.hostname AS cf_hostname, cf.status AS cf_status
     FROM tunnel_hops h
     JOIN tunnel_configs hop ON hop.node_id = h.hop_node_id AND hop.id = h.hop_tunnel_id
     LEFT JOIN tunnels t ON t.node_id = hop.node_id AND t.id = hop.id
     LEFT JOIN tunnel_cloudflare_frontends cf ON cf.node_id = hop.node_id AND cf.tunnel_id = hop.id
     WHERE h.entry_node_id = ?
     ORDER BY h.entry_tunnel_id, h.position`,
  ).bind(nodeId).all<HopTargetRow & { entry_tunnel_id: string; position: number; hop_node_id: string; hop_tunnel_id: string }>();

  const hopsByEntry = new Map<string, DesiredHop[]>();
  for (const row of hopRows.results) {
    const options = JSON.parse(row.options_json || "{}") as Record<string, unknown>;
    const credentials = await decryptStored(env, row.hop_node_id, row.hop_tunnel_id, row.credentials_ciphertext);
    const endpoint = hopEndpoint(row.public_host, row.observed_endpoint, row.cf_hostname, row.cf_status, row.port);
    const list = hopsByEntry.get(row.entry_tunnel_id) ?? [];
    if (!credentials || !endpoint) {
      list.push(pendingHop(row.hop_node_id, row.hop_tunnel_id, row.entry_tunnel_id, row.type, row.port));
    } else {
      const resolved = readyHop({
        nodeId: row.hop_node_id,
        tunnelId: row.hop_tunnel_id,
        entryTunnelId: row.entry_tunnel_id,
        type: row.type,
        credentials,
        options,
        server: endpoint.server,
        port: endpoint.port,
        viaCloudflare: endpoint.viaCloudflare,
      });
      list.push(resolved ?? pendingHop(row.hop_node_id, row.hop_tunnel_id, row.entry_tunnel_id, row.type, row.port));
    }
    hopsByEntry.set(row.entry_tunnel_id, list);
  }

  const tunnels: DesiredTunnel[] = [];
  for (const row of configs.results) {
    const tunnel = desiredTunnelFromRow(row);
    const credentials = await decryptStored(env, row.node_id, row.id, row.credentials_ciphertext);
    if (credentials) tunnel.credentials = credentials;
    const hops = hopsByEntry.get(row.id);
    if (hops && hops.length > 0) tunnel.hops = hops;
    tunnels.push(tunnel);
  }
  return tunnels;
}

export async function hostedClientView(
  env: Env,
  row: Record<string, unknown>,
): Promise<{ authentication: Record<string, unknown>; metadata: Record<string, unknown> } | null> {
  if (typeof row.type !== "string") return null;
  const credentials = await decryptStored(
    env,
    String(row.node_id),
    String(row.id),
    row.credentials_ciphertext ? String(row.credentials_ciphertext) : null,
  );
  if (!credentials) return null;
  const options = JSON.parse(String(row.options_json || "{}")) as Record<string, unknown>;
  const type = row.type as DesiredTunnelType;
  const authentication = clientAuthentication(type, credentials, options);
  if (!authentication) return null;
  return { authentication, metadata: hostedMetadata(type, credentials, options) };
}
