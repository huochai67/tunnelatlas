import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

interface DatabaseCall {
  sql: string;
  values: unknown[];
}

function testEnv(rows: { agent?: Record<string, unknown> | null; site?: Record<string, unknown> | null } = {}) {
  const calls: DatabaseCall[] = [];
  const db = {
    prepare(sql: string) {
      const call = { sql, values: [] as unknown[] };
      const statement = {
        bind(...values: unknown[]) { call.values = values; calls.push(call); return statement; },
        async first() {
          if (sql.includes("DELETE FROM agents")) return rows.agent ?? null;
          if (sql.includes("DELETE FROM sites")) return rows.site ?? null;
          return null;
        },
      };
      return statement;
    },
  };
  return {
    calls,
    env: { ADMIN_TOKEN: "admin-token", READ_TOKEN: "read-token", DB: db } as unknown as Env,
  };
}

function adminDelete(path: string): Request {
  return new Request(`https://atlas.example${path}`, {
    method: "DELETE",
    headers: { Authorization: "Bearer admin-token" },
  });
}

describe("admin deletion", () => {
  it("deletes an Agent by ID", async () => {
    const { env, calls } = testEnv({ agent: { id: "agent_old", site_id: "site-home", name: "old-node" } });
    const response = await worker.fetch(adminDelete("/v1/admin/agents/agent_old"), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, id: "agent_old", siteId: "site-home", name: "old-node" });
    expect(calls).toEqual([{ sql: expect.stringContaining("DELETE FROM agents"), values: ["agent_old"] }]);
  });

  it("deletes a site by ID", async () => {
    const { env, calls } = testEnv({ site: { id: "site-old", name: "旧站点" } });
    const response = await worker.fetch(adminDelete("/v1/admin/sites/site-old"), env);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, id: "site-old", name: "旧站点" });
    expect(calls).toEqual([{ sql: expect.stringContaining("DELETE FROM sites"), values: ["site-old"] }]);
  });

  it("requires ADMIN_TOKEN before touching the database", async () => {
    const { env, calls } = testEnv({ agent: { id: "agent_old", site_id: "site-home", name: "old-node" } });
    const missing = await worker.fetch(new Request("https://atlas.example/v1/admin/agents/agent_old", { method: "DELETE" }), env);
    const readOnly = await worker.fetch(new Request("https://atlas.example/v1/admin/agents/agent_old", {
      method: "DELETE",
      headers: { Authorization: "Bearer read-token" },
    }), env);
    const malformed = await worker.fetch(new Request("https://atlas.example/v1/admin/agents/not%20valid", { method: "DELETE" }), env);

    expect(missing.status).toBe(401);
    expect(readOnly.status).toBe(401);
    expect(malformed.status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("returns 404 for missing resources and 400 for invalid IDs", async () => {
    const { env } = testEnv();
    const missing = await worker.fetch(adminDelete("/v1/admin/sites/site-missing"), env);
    const invalid = await worker.fetch(adminDelete("/v1/admin/agents/not%20valid"), env);

    expect(missing.status).toBe(404);
    expect(invalid.status).toBe(400);
  });
});
