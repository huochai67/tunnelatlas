import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

interface DatabaseCall {
  sql: string;
  values: unknown[];
}

function mockCloudflare(handler: (path: string, method: string) => Response | null) {
  const fetchMock = (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/client\/v4/, "") + url.search;
    const method = (init?.method ?? "GET").toUpperCase();
    const response = handler(path, method);
    if (response) return Promise.resolve(response);
    return Promise.reject(new Error(`unhandled Cloudflare request: ${method} ${path}`));
  };
  vi.stubGlobal("fetch", fetchMock);
  return { restore: () => vi.unstubAllGlobals() };
}

afterEach(() => vi.unstubAllGlobals());

function testEnv(options?: {
  nodeExists?: boolean;
  tunnelCount?: number;
  existingTunnels?: Array<Record<string, unknown>>;
  existingFrontends?: Array<Record<string, unknown>>;
}) {
  const nodeExists = options?.nodeExists ?? true;
  const tunnelCount = options?.tunnelCount ?? 0;
  const tunnels = options?.existingTunnels ?? [];
  const frontends = options?.existingFrontends ?? [];

  const calls: DatabaseCall[] = [];
  const db = {
    prepare(sql: string) {
      const call = { sql, values: [] as unknown[] };
      const statement = {
        bind(...values: unknown[]) {
          call.values = values;
          calls.push(call);
          return statement;
        },
        async first<T>() {
          if (sql.includes("FROM nodes WHERE id = ?")) {
            return (nodeExists ? { id: call.values[0], config_version: 1 } : null) as T | null;
          }
          if (sql.includes("COUNT(*) AS count FROM tunnel_configs")) {
            return { count: tunnelCount } as T | null;
          }
          if (sql.includes("id != ?")) {
            const excludeId = call.values[1];
            const name = call.values[2];
            const port = call.values[3];
            const match = tunnels.find((t) => t.id !== excludeId && (t.name === name || t.port === port));
            return (match ?? null) as T | null;
          }
          if (sql.includes("FROM tunnel_configs WHERE node_id = ? AND (name = ? OR port = ?)")) {
            const name = call.values[1];
            const port = call.values[2];
            const match = tunnels.find((t) => t.name === name || t.port === port);
            return (match ?? null) as T | null;
          }
          if (sql.includes("FROM tunnel_configs WHERE node_id = ? AND id = ?")) {
            const nodeId = call.values[0];
            const id = call.values[1];
            const match = tunnels.find((t) => t.node_id === nodeId && t.id === id);
            return (match ?? null) as T | null;
          }
          if (sql.includes("FROM tunnel_cloudflare_frontends WHERE node_id = ? AND tunnel_id = ?")) {
            const nodeId = call.values[0];
            const tunnelId = call.values[1];
            const match = frontends.find((f) => f.node_id === nodeId && f.tunnel_id === tunnelId);
            return (match ?? null) as T | null;
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(statements: unknown[]) {
      return (statements as unknown[]).map(() => ({ meta: { changes: 1 } }));
    },
  };

  return {
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

function adminReq(path: string, method: string, body?: unknown): Request {
  return new Request(`https://atlas.example${path}`, {
    method,
    headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("POST /v1/admin/nodes/{nodeId}/tunnels", () => {
  it("requires admin token", async () => {
    const { env } = testEnv();
    const req = new Request("https://atlas.example/v1/admin/nodes/node_1/tunnels", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "t1", type: "shadowsocks", port: 8388 }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 404 when node does not exist", async () => {
    const { env } = testEnv({ nodeExists: false });
    const res = await worker.fetch(adminReq("/v1/admin/nodes/node_1/tunnels", "POST", {
      name: "t1",
      type: "shadowsocks",
      port: 8388,
    }), env);
    expect(res.status).toBe(404);
    expect((await res.json() as Record<string, unknown>).title).toBe("Node not found");
  });

  it("returns 409 when capacity limit reached", async () => {
    const { env } = testEnv({ tunnelCount: 64 });
    const res = await worker.fetch(adminReq("/v1/admin/nodes/node_1/tunnels", "POST", {
      name: "t1",
      type: "shadowsocks",
      port: 8388,
    }), env);
    expect(res.status).toBe(409);
    expect((await res.json() as Record<string, unknown>).title).toBe("Tunnel limit reached");
  });

  it("returns 409 on duplicate name or port", async () => {
    const { env } = testEnv({
      existingTunnels: [{ name: "existing_name", port: 8388, node_id: "node_1", id: "tun_1" }],
    });
    const resName = await worker.fetch(adminReq("/v1/admin/nodes/node_1/tunnels", "POST", {
      name: "existing_name",
      type: "shadowsocks",
      port: 9000,
    }), env);
    expect(resName.status).toBe(409);
    expect((await resName.json() as Record<string, unknown>).title).toBe("Tunnel name already exists");

    const resPort = await worker.fetch(adminReq("/v1/admin/nodes/node_1/tunnels", "POST", {
      name: "other_name",
      type: "shadowsocks",
      port: 8388,
    }), env);
    expect(resPort.status).toBe(409);
    expect((await resPort.json() as Record<string, unknown>).title).toBe("Tunnel port already in use");
  });

  it("creates tunnel and increments config_version", async () => {
    const { env, calls } = testEnv();
    const res = await worker.fetch(adminReq("/v1/admin/nodes/node_1/tunnels", "POST", {
      name: "new_tun",
      type: "shadowsocks",
      port: 8388,
    }), env);
    expect(res.status).toBe(201);
    const body = await res.json() as { tunnel: Record<string, unknown> };
    expect(body.tunnel.name).toBe("new_tun");
    expect(body.tunnel.type).toBe("shadowsocks");
    expect(body.tunnel.listen).toBe("::");
    expect(body.tunnel.port).toBe(8388);
    expect(body.tunnel.credentialGeneration).toBe(1);
    expect(body.tunnel.subscriptionEnabled).toBe(true);

    const versionUpdate = calls.find((c) => c.sql.includes("UPDATE nodes SET config_version = config_version + 1"));
    expect(versionUpdate).toBeDefined();
  });
});

describe("PUT /v1/admin/nodes/{nodeId}/tunnels/{tunnelId}", () => {
  const existingTun = {
    node_id: "node_1",
    id: "tun_1",
    name: "old_name",
    type: "shadowsocks",
    listen: "::",
    port: 8388,
    public_host: null,
    options_json: JSON.stringify({ method: "2022-blake3-aes-128-gcm" }),
    credential_generation: 1,
    subscription_enabled: 1,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };

  it("returns 404 if tunnel configuration does not exist", async () => {
    const { env } = testEnv({ existingTunnels: [] });
    const res = await worker.fetch(adminReq("/v1/admin/nodes/node_1/tunnels/tun_1", "PUT", {
      name: "new_name",
      type: "shadowsocks",
      port: 8388,
    }), env);
    expect(res.status).toBe(404);
    expect((await res.json() as Record<string, unknown>).title).toBe("Tunnel configuration not found");
  });

  it("returns 409 if name or port conflicts with another tunnel", async () => {
    const { env } = testEnv({
      existingTunnels: [
        existingTun,
        { node_id: "node_1", id: "tun_2", name: "other_name", port: 9000 },
      ],
    });
    const res = await worker.fetch(adminReq("/v1/admin/nodes/node_1/tunnels/tun_1", "PUT", {
      name: "other_name",
      type: "shadowsocks",
      port: 8388,
    }), env);
    expect(res.status).toBe(409);
    expect((await res.json() as Record<string, unknown>).title).toBe("Tunnel name already exists");
  });

  it("advances credential_generation when protocol type changes", async () => {
    const { env } = testEnv({ existingTunnels: [existingTun] });
    const res = await worker.fetch(adminReq("/v1/admin/nodes/node_1/tunnels/tun_1", "PUT", {
      name: "old_name",
      type: "hysteria2",
      port: 8388,
      serverName: "www.bing.com",
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { tunnel: Record<string, unknown> };
    expect(body.tunnel.credentialGeneration).toBe(2);
  });

  it("advances credential_generation when shadowsocks method changes", async () => {
    const { env } = testEnv({ existingTunnels: [existingTun] });
    const res = await worker.fetch(adminReq("/v1/admin/nodes/node_1/tunnels/tun_1", "PUT", {
      name: "old_name",
      type: "shadowsocks",
      port: 8388,
      method: "2022-blake3-aes-256-gcm",
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { tunnel: Record<string, unknown> };
    expect(body.tunnel.credentialGeneration).toBe(2);
  });

  it("preserves credential_generation on ordinary edits", async () => {
    const { env } = testEnv({ existingTunnels: [existingTun] });
    const res = await worker.fetch(adminReq("/v1/admin/nodes/node_1/tunnels/tun_1", "PUT", {
      name: "renamed",
      type: "shadowsocks",
      port: 8389,
      listen: "0.0.0.0",
      publicHost: "203.0.113.1",
    }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { tunnel: Record<string, unknown> };
    expect(body.tunnel.credentialGeneration).toBe(1);
    expect(body.tunnel.name).toBe("renamed");
    expect(body.tunnel.port).toBe(8389);
  });

  it("does not increment config_version when desired fields are identical", async () => {
    const { env, calls } = testEnv({ existingTunnels: [existingTun] });
    const res = await worker.fetch(adminReq("/v1/admin/nodes/node_1/tunnels/tun_1", "PUT", {
      name: "old_name",
      type: "shadowsocks",
      port: 8388,
      listen: "::",
      method: "2022-blake3-aes-128-gcm",
    }), env);
    expect(res.status).toBe(200);
    const versionUpdate = calls.find((c) => c.sql.includes("UPDATE nodes SET config_version = config_version + 1"));
    expect(versionUpdate).toBeUndefined();
  });
});

describe("POST /v1/admin/nodes/{nodeId}/tunnels/{tunnelId}/credentials:rotate", () => {
  const existingTun = {
    node_id: "node_1",
    id: "tun_1",
    credential_generation: 3,
    updated_at: "2026-08-01T00:00:00Z",
  };

  it("increments credential_generation and config_version", async () => {
    const { env, calls } = testEnv({ existingTunnels: [existingTun] });
    const res = await worker.fetch(adminReq("/v1/admin/nodes/node_1/tunnels/tun_1/credentials:rotate", "POST"), env);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.rotated).toBe(true);
    expect(body.credentialGeneration).toBe(4);

    const versionUpdate = calls.find((c) => c.sql.includes("UPDATE nodes SET config_version = config_version + 1"));
    expect(versionUpdate).toBeDefined();
  });

  it("returns 404 for unknown tunnel", async () => {
    const { env } = testEnv({ existingTunnels: [] });
    const res = await worker.fetch(adminReq("/v1/admin/nodes/node_1/tunnels/tun_unknown/credentials:rotate", "POST"), env);
    expect(res.status).toBe(404);
  });
});

describe("DELETE /v1/admin/nodes/{nodeId}/tunnels/{tunnelId}", () => {
  it("returns 404 before side effects if tunnel is not in tunnel_configs", async () => {
    const { env, calls } = testEnv({ existingTunnels: [] });
    const res = await worker.fetch(adminReq("/v1/admin/nodes/node_1/tunnels/legacy_or_missing", "DELETE"), env);
    expect(res.status).toBe(404);
    expect((await res.json() as Record<string, unknown>).title).toBe("Tunnel configuration not found");
    expect(calls.some((c) => c.sql.includes("DELETE FROM"))).toBe(false);
  });

  it("deletes desired tunnel, matching observed tunnel, and increments config_version", async () => {
    const { env, calls } = testEnv({
      existingTunnels: [{ node_id: "node_1", id: "tun_1", updated_at: "2026-08-01T00:00:00Z" }],
    });
    const res = await worker.fetch(adminReq("/v1/admin/nodes/node_1/tunnels/tun_1", "DELETE"), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, nodeId: "node_1", tunnelId: "tun_1" });

    const deleteDesired = calls.find((c) => c.sql.includes("DELETE FROM tunnel_configs"));
    expect(deleteDesired).toBeDefined();
    const deleteObserved = calls.find((c) => c.sql.includes("DELETE FROM tunnels"));
    expect(deleteObserved).toBeDefined();
    const versionUpdate = calls.find((c) => c.sql.includes("UPDATE nodes SET config_version = config_version + 1"));
    expect(versionUpdate).toBeDefined();
  });

  it("deprovisions tracked Cloudflare frontend before deleting", async () => {
    let cfDeleted = false;
    mockCloudflare((path, method) => {
      if (path.includes("/dns_records/") && method === "DELETE") {
        cfDeleted = true;
        return new Response(JSON.stringify({ success: true, result: { id: "dns_1" } }));
      }
      return null;
    });

    const { env } = testEnv({
      existingTunnels: [{ node_id: "node_1", id: "tun_1", updated_at: "2026-08-01T00:00:00Z" }],
      existingFrontends: [{
        node_id: "node_1",
        tunnel_id: "tun_1",
        hostname: "sub.example.com",
        zone_id: "z1",
        zone_name: "example.com",
        status: "active",
        dns_record_id: "dns_1",
      }],
    });
    const res = await worker.fetch(adminReq("/v1/admin/nodes/node_1/tunnels/tun_1", "DELETE"), env);
    expect(res.status).toBe(200);
    expect(cfDeleted).toBe(true);
  });
});
