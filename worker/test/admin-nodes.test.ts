import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

interface DatabaseCall {
  sql: string;
  values: unknown[];
}

function cloudflareOk(result: unknown, status = 200): Response {
  return new Response(JSON.stringify({ success: true, result }), { status, headers: { "Content-Type": "application/json" } });
}

function cloudflareError(status: number, messages: string[]): Response {
  return new Response(JSON.stringify({
    success: false,
    errors: messages.map((message) => ({ code: 0, message })),
  }), { status, headers: { "Content-Type": "application/json" } });
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

function frontendRow(nodeId = "node_one", tunnelId = "inbound-1"): Record<string, unknown> {
  return {
    node_id: nodeId,
    tunnel_id: tunnelId,
    hostname: "ta-00000000000000000000.example.com",
    zone_id: "zone_1",
    zone_name: "example.com",
    status: "active",
    operation_id: null,
    dns_record_id: "dns_1",
    config_ruleset_id: "cfg_ruleset_1",
    config_rule_id: "cfg_rule_1",
    origin_ruleset_id: "org_ruleset_1",
    origin_rule_id: "org_rule_1",
    source_endpoint: "203.0.113.8:10086",
    source_path: "/vmess",
    last_error: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
  };
}

function testEnv(
  firstRows: Array<Record<string, unknown> | null> = [],
  frontendRows: Array<Record<string, unknown>> = [],
) {
  const calls: DatabaseCall[] = [];
  const rows = [...firstRows];
  const frontends = new Map<string, Record<string, unknown>>();
  for (const row of frontendRows) frontends.set(`${row.node_id}\u0000${row.tunnel_id}`, row);
  const db = {
    prepare(sql: string) {
      const call = { sql, values: [] as unknown[] };
      const statement = {
        bind(...values: unknown[]) { call.values = values; calls.push(call); return statement; },
        async first() {
          if (sql.includes("tunnel_cloudflare_frontends")) {
            const nodeId = call.values[0] as string;
            const tunnelId = call.values[1] as string;
            return frontends.get(`${nodeId}\u0000${tunnelId}`) ?? null;
          }
          return rows.shift() ?? null;
        },
        async all() {
          if (sql.includes("tunnel_cloudflare_frontends")) return { results: [...frontends.values()] };
          return { results: [] };
        },
        async run() { return { meta: { changes: 1 } }; },
      };
      return statement;
    },
    async batch(statements: unknown[]) {
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
  return {
    calls,
    env: {
      ADMIN_TOKEN: "admin-token",
      READ_TOKEN: "read-token",
      ENROLLMENT_PEPPER: "pepper",
      DB: db,
      CLOUDFLARE_API_TOKEN: "cf-token",
      CLOUDFLARE_ZONE_NAME: "example.com",
    } as unknown as Env,
  };
}

function adminRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`https://atlas.example${path}`, {
    method,
    headers: { Authorization: "Bearer admin-token", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("admin node management", () => {
  it("creates a pending node with a random ID and first enrollment token", async () => {
    const { env, calls } = testEnv();
    const response = await worker.fetch(adminRequest("/v1/admin/nodes", "POST", { name: "洛杉矶节点" }), env);
    const body = await response.json() as Record<string, any>;

    expect(response.status).toBe(201);
    expect(body.node).toMatchObject({ name: "洛杉矶节点", connectionStatus: "pending" });
    expect(body.node.id).toMatch(/^node_/);
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    expect(calls.some((call) => call.sql.includes("INSERT INTO nodes"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("INSERT INTO enrollment_tokens"))).toBe(true);
  });

  it("allows duplicate display names while generating distinct node IDs", async () => {
    const first = await worker.fetch(adminRequest("/v1/admin/nodes", "POST", { name: "edge" }), testEnv().env);
    const second = await worker.fetch(adminRequest("/v1/admin/nodes", "POST", { name: "edge" }), testEnv().env);
    const firstBody = await first.json() as Record<string, any>;
    const secondBody = await second.json() as Record<string, any>;

    expect(firstBody.node.name).toBe("edge");
    expect(secondBody.node.name).toBe("edge");
    expect(firstBody.node.id).not.toBe(secondBody.node.id);
  });

  it("reissues a token only for a pending node and invalidates older tokens", async () => {
    const { env, calls } = testEnv([{ id: "node_one", public_key: null }]);
    const response = await worker.fetch(adminRequest("/v1/admin/nodes/node_one/enrollment-tokens", "POST"), env);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ nodeId: "node_one" });
    expect(calls.some((call) => call.sql.includes("SET enrollment_generation"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("DELETE FROM enrollment_tokens"))).toBe(true);
  });

  it("resets an enrolled node while preserving its ID and name", async () => {
    const { env, calls } = testEnv([{ id: "node_one", name: "edge", public_key: "old-key" }]);
    const response = await worker.fetch(adminRequest("/v1/admin/nodes/node_one/enrollment:reset", "POST"), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      node: { id: "node_one", name: "edge", connectionStatus: "pending" },
    });
    expect(calls.some((call) => call.sql.includes("public_key = NULL"))).toBe(true);
    expect(calls.some((call) => call.sql.includes("DELETE FROM tunnels"))).toBe(true);
  });

  it("deprovisions tracked frontends before resetting a node", async () => {
    const cf = mockCloudflare((_path, method) => (method === "DELETE" ? cloudflareOk({ id: "gone" }) : null));
    const { env, calls } = testEnv(
      [{ id: "node_one", name: "edge", public_key: "old-key" }],
      [frontendRow()],
    );
    const response = await worker.fetch(adminRequest("/v1/admin/nodes/node_one/enrollment:reset", "POST"), env);

    expect(response.status).toBe(200);
    const frontendDeleteIndex = calls.findIndex((call) => call.sql.includes("DELETE FROM tunnel_cloudflare_frontends"));
    const nodeResetIndex = calls.findIndex((call) => call.sql.includes("public_key = NULL"));
    expect(frontendDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(nodeResetIndex).toBeGreaterThan(frontendDeleteIndex);
    cf.restore();
  });

  it("aborts node reset when Cloudflare cleanup fails, preserving tracking", async () => {
    const cf = mockCloudflare(() => cloudflareError(500, ["upstream down"]));
    const { env, calls } = testEnv(
      [{ id: "node_one", name: "edge", public_key: "old-key" }],
      [frontendRow()],
    );
    const response = await worker.fetch(adminRequest("/v1/admin/nodes/node_one/enrollment:reset", "POST"), env);

    expect(response.status).toBe(502);
    expect(calls.some((call) => call.sql.includes("public_key = NULL"))).toBe(false);
    expect(calls.some((call) => call.sql.includes("SET status = 'error'"))).toBe(true);
    cf.restore();
  });

  it("deletes a node and rejects removed legacy routes", async () => {
    const { env, calls } = testEnv([{ id: "node_old", name: "old-node" }]);
    const response = await worker.fetch(adminRequest("/v1/admin/nodes/node_old", "DELETE"), env);
    const legacySite = await worker.fetch(adminRequest("/v1/admin/sites/site-old", "DELETE"), env);
    const legacyAgent = await worker.fetch(adminRequest("/v1/admin/agents/agent-old", "DELETE"), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, id: "node_old", name: "old-node" });
    expect(calls.some((call) => call.sql.includes("DELETE FROM nodes"))).toBe(true);
    expect(legacySite.status).toBe(404);
    expect(legacyAgent.status).toBe(404);
  });

  it("deprovisions tracked frontends before deleting a node", async () => {
    const cf = mockCloudflare((_path, method) => (method === "DELETE" ? cloudflareOk({ id: "gone" }) : null));
    const { env, calls } = testEnv([{ id: "node_one", name: "edge" }], [frontendRow()]);
    const response = await worker.fetch(adminRequest("/v1/admin/nodes/node_one", "DELETE"), env);

    expect(response.status).toBe(200);
    const frontendDeleteIndex = calls.findIndex((call) => call.sql.includes("DELETE FROM tunnel_cloudflare_frontends"));
    const nodeDeleteIndex = calls.findIndex((call) => call.sql.includes("DELETE FROM nodes"));
    expect(frontendDeleteIndex).toBeGreaterThanOrEqual(0);
    expect(nodeDeleteIndex).toBeGreaterThan(frontendDeleteIndex);
    cf.restore();
  });

  it("aborts node deletion when Cloudflare cleanup fails, preserving tracking", async () => {
    const cf = mockCloudflare(() => cloudflareError(500, ["upstream down"]));
    const { env, calls } = testEnv([{ id: "node_one", name: "edge" }], [frontendRow()]);
    const response = await worker.fetch(adminRequest("/v1/admin/nodes/node_one", "DELETE"), env);

    expect(response.status).toBe(502);
    expect(calls.some((call) => call.sql.includes("DELETE FROM nodes"))).toBe(false);
    cf.restore();
  });

  it("requires ADMIN_TOKEN before touching the database", async () => {
    const { env, calls } = testEnv();
    const response = await worker.fetch(new Request("https://atlas.example/v1/admin/nodes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "edge" }),
    }), env);

    expect(response.status).toBe(401);
    expect(calls).toEqual([]);
  });
});
