import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

interface DatabaseCall {
  sql: string;
  values: unknown[];
}

function testEnv(firstRows: Array<Record<string, unknown> | null> = []) {
  const calls: DatabaseCall[] = [];
  const rows = [...firstRows];
  const db = {
    prepare(sql: string) {
      const call = { sql, values: [] as unknown[] };
      const statement = {
        bind(...values: unknown[]) { call.values = values; calls.push(call); return statement; },
        async first() { return rows.shift() ?? null; },
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
