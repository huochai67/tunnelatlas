import { describe, expect, it } from "vitest";
import { bytesToBase64Url, sha256Hex } from "../src/crypto";
import worker from "../src/index";
import type { DesiredConfig, Env, ReportBody } from "../src/types";

interface DBRow {
  [key: string]: unknown;
}

function testEnv(options?: {
  node?: DBRow;
  tunnelConfigs?: DBRow[];
  observedTunnels?: DBRow[];
  frontends?: DBRow[];
}) {
  const node = options?.node ?? {
    id: "node_1",
    name: "Node 1",
    public_key: "",
    last_sequence: 0,
    config_version: 1,
    applied_config_version: null,
    config_apply_error: null,
    labels_json: "{}",
    agent_version: "0.1.0",
    last_seen_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
  const configs = new Map<string, DBRow>();
  for (const c of options?.tunnelConfigs ?? []) configs.set(`${c.node_id}:${c.id}`, { ...c });

  const observed = new Map<string, DBRow>();
  for (const o of options?.observedTunnels ?? []) observed.set(`${o.node_id}:${o.id}`, { ...o });

  const frontends = new Map<string, DBRow>();
  for (const f of options?.frontends ?? []) frontends.set(`${f.node_id}:${f.tunnel_id}`, { ...f });

  const calls: Array<{ sql: string; values: unknown[] }> = [];

  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...values: unknown[]) {
          bound = values;
          calls.push({ sql, values: bound });
          return stmt;
        },
        async first<T>() {
          if (sql.includes("SELECT config_version FROM nodes WHERE id = ?")) {
            return { config_version: node.config_version } as T;
          }
          if (sql.includes("SELECT id, config_version, applied_config_version FROM nodes WHERE id = ?") ||
              sql.includes("SELECT config_version, applied_config_version FROM nodes WHERE id = ?")) {
            return {
              id: node.id,
              config_version: node.config_version,
              applied_config_version: node.applied_config_version,
            } as T;
          }
          if (sql.includes("FROM nodes WHERE id = ?")) {
            return node as T;
          }
          if (sql.includes("FROM tunnel_configs WHERE node_id = ? AND id = ?")) {
            const key = `${bound[0]}:${bound[1]}`;
            return (configs.get(key) ?? null) as T;
          }
          if (sql.includes("FROM tunnels WHERE node_id = ? AND id = ?")) {
            const key = `${bound[0]}:${bound[1]}`;
            return (observed.get(key) ?? null) as T;
          }
          if (sql.includes("FROM tunnel_cloudflare_frontends WHERE node_id = ? AND tunnel_id = ?")) {
            const key = `${bound[0]}:${bound[1]}`;
            return (frontends.get(key) ?? null) as T;
          }
          return null as T;
        },
        async all<T>() {
          calls.push({ sql, values: bound });
          if (sql.includes("FROM tunnel_configs WHERE node_id = ?")) {
            const nodeId = bound[0];
            const results = [...configs.values()].filter((c) => c.node_id === nodeId);
            return { results } as { results: T[] };
          }
          if (sql.includes("FROM tunnel_cloudflare_frontends WHERE node_id = ?")) {
            const nodeId = bound[0];
            const results = [...frontends.values()].filter((f) => f.node_id === nodeId);
            return { results } as { results: T[] };
          }
          if (sql.includes("SELECT tc.id, tc.node_id")) {
            // adminOverview desiredResult
            return { results: [...configs.values()].map((c) => ({
              ...c,
              node_name: node.name,
              config_version: node.config_version,
              applied_config_version: node.applied_config_version,
              observed_status: observed.get(`${c.node_id}:${c.id}`)?.status ?? null,
              observed_endpoint: observed.get(`${c.node_id}:${c.id}`)?.endpoint ?? null,
              observed_metadata_json: observed.get(`${c.node_id}:${c.id}`)?.metadata_json ?? null,
              observed_authentication_ciphertext: observed.get(`${c.node_id}:${c.id}`)?.authentication_ciphertext ?? null,
              observed_last_seen_at: observed.get(`${c.node_id}:${c.id}`)?.last_seen_at ?? null,
              cf_hostname: null, cf_status: null, cf_source_endpoint: null, cf_source_path: null, cf_last_error: null, cf_updated_at: null,
            })) } as { results: T[] };
          }
          if (sql.includes("FROM tunnels t") && sql.includes("WHERE n.applied_config_version IS NULL AND tc.id IS NULL")) {
            // adminOverview legacyResult
            if (node.applied_config_version !== null) return { results: [] } as { results: T[] };
            const legacy = [...observed.values()].filter((o) => !configs.has(`${o.node_id}:${o.id}`));
            return { results: legacy.map((o) => ({
              ...o,
              node_name: node.name,
              cf_hostname: null, cf_status: null, cf_source_endpoint: null, cf_source_path: null, cf_last_error: null, cf_updated_at: null,
            })) } as { results: T[] };
          }
          if (sql.includes("FROM nodes n ORDER BY n.name")) {
            // adminOverview nodesResult
            return { results: [node] } as { results: T[] };
          }
          if (sql.includes("FROM tunnels t JOIN nodes n")) {
            // publicTunnelQuery
            let results: DBRow[] = [];
            for (const [key, o] of observed) {
              const cfg = configs.get(key);
              if (node.applied_config_version !== null && !cfg) continue;
              const subEnabled = node.applied_config_version !== null ? cfg?.subscription_enabled : o.subscription_enabled;
              results.push({
                ...o,
                name: cfg?.name ?? o.name,
                subscription_enabled: subEnabled,
                node_name: node.name,
                cf_hostname: null, cf_status: null, cf_source_endpoint: null, cf_source_path: null, cf_last_error: null, cf_updated_at: null,
              });
            }
            if (sql.includes("subscription_enabled = 1")) {
              results = results.filter((r) => r.subscription_enabled === 1);
            }
            return { results } as { results: T[] };
          }
          return { results: [] } as { results: T[] };
        },
        async run() {
          calls.push({ sql, values: bound });
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
    async batch(statements: unknown[]) {
      for (const s of statements as Array<{ bind: (...args: unknown[]) => unknown }>) {
        // executed
      }
      return (statements as unknown[]).map(() => ({ meta: { changes: 1 } }));
    },
  };

  return {
    node,
    configs,
    observed,
    frontends,
    calls,
    env: {
      ADMIN_TOKEN: "admin-token",
      READ_TOKEN: "read-token",
      ENROLLMENT_PEPPER: "pepper",
      CREDENTIALS_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      DB: db,
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ZONE_NAME: "example.com",
    } as unknown as Env,
  };
}

async function makeSignedReport(
  bodyObj: ReportBody,
  keyPair: CryptoKeyPair,
  nodeId = "node_1",
  sequence = 1,
): Promise<Request> {
  const body = JSON.stringify(bodyObj);
  const contentHash = await sha256Hex(body);
  const timestamp = new Date().toISOString();
  const canonical = `POST\n/v1/agent/report\n${timestamp}\n${sequence}\n${contentHash}`;
  const signature = bytesToBase64Url(
    new Uint8Array(await crypto.subtle.sign("Ed25519", keyPair.privateKey, new TextEncoder().encode(canonical))),
  );
  return new Request("https://atlas.example/v1/agent/report", {
    method: "POST",
    headers: {
      "X-Agent-ID": nodeId,
      "X-Timestamp": timestamp,
      "X-Sequence": String(sequence),
      "X-Content-SHA256": contentHash,
      "X-Signature": signature,
      "Content-Type": "application/json",
    },
    body,
  });
}

describe("POST /v1/agent/report desired-state reconciliation", () => {
  it("processes bootstrap report with appliedConfigVersion: null without mutating tunnels", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pubKey = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));

    const { env, calls, node } = testEnv({
      node: {
        id: "node_1",
        name: "Node 1",
        public_key: pubKey,
        last_sequence: 0,
        config_version: 2,
        applied_config_version: null,
        config_apply_error: null,
      },
      tunnelConfigs: [{
        node_id: "node_1",
        id: "t_1",
        name: "ss-1",
        type: "shadowsocks",
        listen: "::",
        port: 8388,
        public_host: null,
        options_json: JSON.stringify({ method: "2022-blake3-aes-128-gcm" }),
        credential_generation: 1,
        subscription_enabled: 1,
      }],
      observedTunnels: [{
        node_id: "node_1",
        id: "legacy_1",
        name: "legacy",
        kind: "sing-box/inbound",
        endpoint: "203.0.113.1:8388",
        protocol: "shadowsocks",
        status: "healthy",
        metadata_json: "{}",
        authentication_ciphertext: null,
        last_seen_at: new Date().toISOString(),
        subscription_enabled: 1,
      }],
    });

    const reportBody: ReportBody = {
      agentVersion: "0.2.0",
      appliedConfigVersion: null,
      configApplyError: "sing_box_start_failed",
      tunnels: [],
    };

    const req = await makeSignedReport(reportBody, keyPair, "node_1", 1);
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    const data = await res.json() as { desiredConfig: DesiredConfig };
    expect(data.desiredConfig.version).toBe(2);
    expect(data.desiredConfig.tunnels).toHaveLength(1);
    expect(data.desiredConfig.tunnels[0].id).toBe("t_1");

    // Must not delete or insert observed tunnels
    expect(calls.some((c) => c.sql.includes("DELETE FROM tunnels"))).toBe(false);
    expect(calls.some((c) => c.sql.includes("INSERT INTO tunnels"))).toBe(false);
  });

  it("processes numeric appliedConfigVersion snapshot: ignores unconfigured tunnels and upserts desired", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pubKey = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));

    const { env, calls } = testEnv({
      node: {
        id: "node_1",
        name: "Node 1",
        public_key: pubKey,
        last_sequence: 0,
        config_version: 3,
        applied_config_version: 2,
        config_apply_error: null,
      },
      tunnelConfigs: [{
        node_id: "node_1",
        id: "t_1",
        name: "ss-1",
        type: "shadowsocks",
        listen: "::",
        port: 8388,
        public_host: null,
        options_json: JSON.stringify({ method: "2022-blake3-aes-128-gcm" }),
        credential_generation: 1,
        subscription_enabled: 1,
      }],
      observedTunnels: [{
        node_id: "node_1",
        id: "legacy_orphaned",
        name: "old",
        kind: "sing-box/inbound",
        endpoint: "203.0.113.1:9000",
        protocol: "shadowsocks",
        status: "healthy",
        metadata_json: "{}",
        authentication_ciphertext: null,
        last_seen_at: new Date().toISOString(),
        subscription_enabled: 1,
      }],
    });

    const reportBody: ReportBody = {
      agentVersion: "0.2.0",
      appliedConfigVersion: 3,
      configApplyError: null,
      tunnels: [
        {
          id: "t_1",
          name: "ss-1",
          kind: "sing-box/inbound",
          endpoint: "[::]:8388",
          protocol: "shadowsocks",
          status: "healthy",
          authentication: { method: "2022-blake3-aes-128-gcm", password: "pwd" },
        },
        {
          id: "stale_unconfigured",
          name: "deleted_by_admin",
          kind: "sing-box/inbound",
          endpoint: "[::]:9999",
          protocol: "shadowsocks",
          status: "healthy",
          authentication: { method: "2022-blake3-aes-128-gcm", password: "pwd" },
        },
      ],
    };

    const req = await makeSignedReport(reportBody, keyPair, "node_1", 1);
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(200);

    const data = await res.json() as { desiredConfig: DesiredConfig };
    expect(data.desiredConfig.version).toBe(3);

    // Upsert contains EXISTS tunnel_configs check
    const insertCall = calls.find((c) => c.sql.includes("INSERT INTO tunnels"));
    expect(insertCall).toBeDefined();
    expect(insertCall?.sql).toContain("EXISTS (SELECT 1 FROM tunnel_configs tc");

    // Deletes tunnels not in acceptedIds
    const deleteCall = calls.find((c) => c.sql.includes("DELETE FROM tunnels WHERE node_id = ? AND id NOT IN"));
    expect(deleteCall).toBeDefined();
  });

  it("rejects appliedConfigVersion greater than node config_version with 400", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pubKey = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)));

    const { env } = testEnv({
      node: {
        id: "node_1",
        name: "Node 1",
        public_key: pubKey,
        last_sequence: 0,
        config_version: 2,
        applied_config_version: null,
      },
    });

    const reportBody: ReportBody = {
      agentVersion: "0.2.0",
      appliedConfigVersion: 5,
      tunnels: [],
    };

    const req = await makeSignedReport(reportBody, keyPair, "node_1", 1);
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(400);
    expect((await res.json() as Record<string, unknown>).title).toBe("Invalid appliedConfigVersion");
  });
});

describe("GET /v1/admin/overview with managed and legacy tunnels", () => {
  it("returns managed tunnels with desired fields and legacy tunnels separately", async () => {
    const { env } = testEnv({
      node: {
        id: "node_1",
        name: "Node 1",
        public_key: "key",
        config_version: 2,
        applied_config_version: null, // null bootstrap
        config_apply_error: "invalid_desired_config",
        labels_json: "{}",
        agent_version: "0.2.0",
        last_seen_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      },
      tunnelConfigs: [{
        node_id: "node_1",
        id: "desired_1",
        name: "ss-managed",
        type: "shadowsocks",
        listen: "::",
        port: 8388,
        public_host: null,
        options_json: JSON.stringify({ method: "2022-blake3-aes-128-gcm" }),
        credential_generation: 1,
        subscription_enabled: 1,
      }],
      observedTunnels: [{
        node_id: "node_1",
        id: "legacy_1",
        name: "old-local",
        kind: "sing-box/inbound",
        endpoint: "203.0.113.1:9000",
        protocol: "hysteria2",
        status: "healthy",
        metadata_json: "{}",
        authentication_ciphertext: null,
        last_seen_at: new Date().toISOString(),
        subscription_enabled: 1,
      }],
    });

    const res = await worker.fetch(new Request("https://atlas.example/v1/admin/overview", {
      headers: { Authorization: "Bearer admin-token" },
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { nodes: Array<Record<string, unknown>>; tunnels: Array<Record<string, unknown>> };

    expect(body.nodes).toHaveLength(1);
    expect(body.nodes[0].configVersion).toBe(2);
    expect(body.nodes[0].appliedConfigVersion).toBeNull();
    expect(body.nodes[0].configApplyError).toBe("invalid_desired_config");

    expect(body.tunnels).toHaveLength(2);
    const managed = body.tunnels.find((t) => t.id === "desired_1");
    expect(managed?.managed).toBe(true);
    expect(managed?.type).toBe("shadowsocks");

    const legacy = body.tunnels.find((t) => t.id === "legacy_1");
    expect(legacy?.managed).toBe(false);
    expect(legacy?.name).toBe("old-local");
  });
});

describe("POST /v1/admin/nodes/{nodeId}/enrollment:reset", () => {
  it("clears observed tunnels and resets applied_config_version while preserving desired configs", async () => {
    const { env, calls } = testEnv({
      node: {
        id: "node_1",
        name: "Node 1",
        public_key: "enrolled_key",
        config_version: 5,
        applied_config_version: 5,
      },
    });

    const res = await worker.fetch(new Request("https://atlas.example/v1/admin/nodes/node_1/enrollment:reset", {
      method: "POST",
      headers: { Authorization: "Bearer admin-token" },
    }), env);
    expect(res.status).toBe(200);

    const updateNode = calls.find((c) => c.sql.includes("UPDATE nodes SET public_key = NULL"));
    expect(updateNode).toBeDefined();
    expect(updateNode?.sql).toContain("applied_config_version = NULL");
    expect(updateNode?.sql).toContain("config_apply_error = NULL");

    const deleteTunnels = calls.find((c) => c.sql.includes("DELETE FROM tunnels"));
    expect(deleteTunnels).toBeDefined();

    // Must NOT delete tunnel_configs
    expect(calls.some((c) => c.sql.includes("DELETE FROM tunnel_configs"))).toBe(false);
  });
});
