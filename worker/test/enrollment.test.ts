import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

function environment(changes = 1, row: Record<string, unknown> = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      const call = { sql, values: [] as unknown[] };
      const statement = {
        bind(...values: unknown[]) { call.values = values; calls.push(call); return statement; },
        async first() {
          return {
            node_id: "node_one",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            used_at: null,
            public_key: null,
            ...row,
          };
        },
      };
      return statement;
    },
    async batch(statements: unknown[]) { return statements.map(() => ({ meta: { changes } })); },
  };
  return {
    calls,
    env: { ENROLLMENT_PEPPER: "pepper", DB: db } as unknown as Env,
  };
}

function enrollmentRequest(): Request {
  return new Request("https://atlas.example/v1/enrollments:exchange", {
    method: "POST",
    headers: { Authorization: "Enrollment one-time-token", "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      platform: { os: "linux", arch: "x86_64", agentVersion: "0.0.9" },
      labels: { region: "lax" },
    }),
  });
}

describe("node enrollment exchange", () => {
  it("claims the node bound to the token without site or name fields", async () => {
    const { env, calls } = environment();
    const response = await worker.fetch(enrollmentRequest(), env);

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ agentId: "node_one" });
    const claim = calls.find((call) => call.sql.includes("UPDATE nodes SET public_key"));
    expect(claim?.values).toContain("node_one");
    expect(claim?.sql).toContain("enrollment_generation");
  });

  it("rejects a concurrent second claim", async () => {
    const { env } = environment(0);
    const response = await worker.fetch(enrollmentRequest(), env);
    expect(response.status).toBe(409);
  });

  it("rejects expired tokens and nodes that are already enrolled", async () => {
    const expired = await worker.fetch(enrollmentRequest(), environment(1, {
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    }).env);
    const enrolled = await worker.fetch(enrollmentRequest(), environment(1, { public_key: "existing-key" }).env);

    expect(expired.status).toBe(401);
    expect(enrolled.status).toBe(409);
  });
});
