import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { bytesToBase64Url, sha256Hex } from "../src/crypto";
import type { Env } from "../src/types";

// --- minimal in-memory D1 that understands the statements this worker emits ---

type Row = Record<string, unknown>;

class FakeD1 {
  nodes = new Map<string, Row>();
  tunnels = new Map<string, Row>();
  frontends = new Map<string, Row>();
  calls: Array<{ sql: string; values: unknown[] }> = [];
  changes = 1;

  private key(nodeId: string, tunnelId: string): string {
    return `${nodeId}\u0000${tunnelId}`;
  }

  private tableFor(sql: string): "frontends" | "tunnels" | "nodes" | null {
    if (sql.includes("tunnel_cloudflare_frontends")) return "frontends";
    if (sql.includes("FROM tunnels") && !sql.includes("JOIN nodes")) return "tunnels";
    if (sql.includes("FROM nodes")) return "nodes";
    return null;
  }

  private whereOf(sql: string): string {
    const start = sql.indexOf("WHERE ") + 6;
    let end = sql.length;
    for (const marker of [" ORDER BY ", " LIMIT "]) {
      const at = sql.indexOf(marker, start);
      if (at >= 0) end = Math.min(end, at);
    }
    return sql.slice(start, end);
  }

  private matches(where: string, values: unknown[], row: Row): boolean {
    let index = 0;
    for (const clause of where.split(" AND ").map((part) => part.trim()).filter(Boolean)) {
      const equals = clause.match(/^([a-z_]+) = \?$/);
      if (equals) {
        if (String(row[equals[1]]) !== String(values[index++])) return false;
        continue;
      }
      if (/^[a-z_]+ IS NOT NULL$/.test(clause)) {
        const column = clause.split(" ")[0];
        if (row[column] === null || row[column] === undefined) return false;
        continue;
      }
      throw new Error(`unsupported WHERE clause: ${clause}`);
    }
    return true;
  }

  private rowsOf(table: "frontends" | "tunnels" | "nodes"): Row[] {
    if (table === "frontends") return [...this.frontends.values()];
    if (table === "tunnels") return [...this.tunnels.values()];
    return [...this.nodes.values()];
  }

  private parseAssignments(setClause: string, values: unknown[]): { assignments: Array<[string, unknown]>; used: number } {
    const assignments: Array<[string, unknown]> = [];
    let index = 0;
    for (const part of setClause.split(",")) {
      const match = part.trim().match(/^([a-z_]+) = (.+)$/);
      if (!match) throw new Error(`unsupported SET clause: ${part}`);
      const [, key, raw] = match;
      if (raw === "?") assignments.push([key, values[index++]]);
      else if (raw === "NULL") assignments.push([key, null]);
      else if (raw.startsWith("'") && raw.endsWith("'")) assignments.push([key, raw.slice(1, -1)]);
      else throw new Error(`unsupported SET value: ${raw}`);
    }
    return { assignments, used: index };
  }

  private first(sql: string, values: unknown[]): Row | null {
    const table = this.tableFor(sql);
    if (!table) return null;
    const where = this.whereOf(sql);
    for (const row of this.rowsOf(table)) {
      if (this.matches(where, values, row)) {
        if (sql.includes("SELECT 1 AS present")) return { present: 1 };
        return row;
      }
    }
    return null;
  }

  private all(sql: string, values: unknown[]): Row[] {
    const table = this.tableFor(sql);
    if (!table) return [];
    const where = this.whereOf(sql);
    return this.rowsOf(table).filter((row) => this.matches(where, values, row));
  }

  private run(sql: string, values: unknown[]): number {
    if (sql.includes("UPDATE tunnel_cloudflare_frontends")) {
      const setMatch = sql.match(/SET ([\s\S]+?)\s+WHERE ([\s\S]+)$/);
      if (!setMatch) throw new Error(`unsupported UPDATE: ${sql}`);
      const { assignments, used } = this.parseAssignments(setMatch[1], values);
      let changed = 0;
      for (const [keyRow, row] of this.frontends) {
        if (this.matches(setMatch[2], values.slice(used), row)) {
          for (const [key, value] of assignments) row[key] = value;
          changed += 1;
        }
      }
      return changed;
    }
    if (sql.includes("INSERT OR IGNORE INTO tunnel_cloudflare_frontends")) {
      const match = sql.match(/INSERT OR IGNORE INTO tunnel_cloudflare_frontends\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/);
      if (!match) throw new Error(`unsupported INSERT: ${sql}`);
      const columns = match[1].split(",").map((column) => column.trim());
      const placeholders = match[2].split(",").map((column) => column.trim());
      const row: Row = {};
      let index = 0;
      for (let i = 0; i < columns.length; i += 1) {
        const placeholder = placeholders[i];
        if (placeholder === "?") row[columns[i]] = values[index++];
        else if (placeholder === "NULL") row[columns[i]] = null;
        else if (placeholder.startsWith("'")) row[columns[i]] = placeholder.slice(1, -1);
        else throw new Error(`unsupported INSERT value: ${placeholder}`);
      }
      const keyRow = this.key(String(row.node_id), String(row.tunnel_id));
      if (this.frontends.has(keyRow)) return 0;
      this.frontends.set(keyRow, row);
      return 1;
    }
    if (sql.includes("DELETE FROM tunnel_cloudflare_frontends")) {
      const whereMatch = sql.match(/WHERE ([\s\S]+)$/);
      if (!whereMatch) throw new Error(`unsupported DELETE: ${sql}`);
      let changed = 0;
      for (const [keyRow, row] of this.frontends) {
        if (this.matches(whereMatch[1], values, row)) {
          this.frontends.delete(keyRow);
          changed += 1;
        }
      }
      return changed;
    }
    if (sql.includes("INSERT INTO tunnels")) {
      const match = sql.match(/INSERT INTO tunnels\s*\(([^)]+)\)/);
      if (!match) throw new Error(`unsupported INSERT: ${sql}`);
      const columns = match[1].split(",").map((column) => column.trim());
      const row: Row = {};
      for (let i = 0; i < columns.length; i += 1) row[columns[i]] = values[i];
      this.tunnels.set(this.key(String(row.node_id), String(row.id)), row);
      return 1;
    }
    if (sql.includes("DELETE FROM tunnels")) {
      const nodeId = String(values[0]);
      if (sql.includes("id NOT IN")) {
        const kept = values.slice(1, values.length - 3).map(String);
        for (const [keyRow, row] of this.tunnels) {
          if (String(row.node_id) === nodeId && !kept.includes(String(row.id))) this.tunnels.delete(keyRow);
        }
      } else {
        for (const [keyRow, row] of this.tunnels) {
          if (String(row.node_id) === nodeId) this.tunnels.delete(keyRow);
        }
      }
      return 1;
    }
    if (sql.includes("UPDATE nodes")) return this.changes;
    throw new Error(`unsupported run: ${sql}`);
  }

  prepare(sql: string) {
    const call = { sql, values: [] as unknown[] };
    const statement = {
      bind: (...values: unknown[]) => { call.values = values; this.calls.push(call); return statement; },
      first: async () => this.first(sql, call.values),
      all: async () => ({ results: this.all(sql, call.values) }),
      run: async () => ({ meta: { changes: this.run(sql, call.values) } }),
    };
    return statement;
  }

  async batch(statements: Array<{ run: () => Promise<{ meta: { changes: number } }> }>) {
    return Promise.all(statements.map(async (statement) => statement.run()));
  }
}

// --- Cloudflare API mock ---

interface CfRequest {
  path: string;
  method: string;
  body: unknown;
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

function mockCloudflare(handler: (request: CfRequest) => Response | null) {
  const requests: CfRequest[] = [];
  const fetchMock = (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const request = {
      path: url.pathname.replace(/^\/client\/v4/, "") + url.search,
      method: (init?.method ?? "GET").toUpperCase(),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    requests.push(request);
    const response = handler(request);
    if (response) return Promise.resolve(response);
    return Promise.reject(new Error(`unhandled Cloudflare request: ${request.method} ${request.path}`));
  };
  vi.stubGlobal("fetch", fetchMock);
  return { requests, restore: () => vi.unstubAllGlobals() };
}

afterEach(() => vi.unstubAllGlobals());

function happyPathHandler() {
  return (request: CfRequest): Response | null => {
    const { path, method } = request;
    if (path === "/zones?name=example.com&status=active") return cloudflareOk([{ id: "zone_1", name: "example.com" }]);
    if (path === "/zones/zone_1/settings/websockets") {
      return method === "GET" ? cloudflareOk({ id: "websockets", value: "off" }) : cloudflareOk({ id: "websockets", value: "on" });
    }
    if (path.startsWith("/zones/zone_1/dns_records?name=")) return cloudflareOk([]);
    if (path === "/zones/zone_1/dns_records") return cloudflareOk({ id: "dns_1" });
    if (path.startsWith("/zones/zone_1/dns_records/")) return cloudflareOk({ id: path.split("/").pop() });
    if (path === "/zones/zone_1/rulesets/phases/http_config_settings/entrypoint") {
      return cloudflareError(404, ["entrypoint does not exist"]);
    }
    if (path === "/zones/zone_1/rulesets/phases/http_request_origin/entrypoint") {
      return cloudflareError(404, ["entrypoint does not exist"]);
    }
    if (path === "/zones/zone_1/rulesets") {
      const phase = String((request.body as Row | null)?.phase ?? "");
      return cloudflareOk({ id: phase === "http_config_settings" ? "cfg_ruleset_1" : "org_ruleset_1", rules: [] });
    }
    const ruleCreate = path.match(/^\/zones\/zone_1\/rulesets\/([^/]+)\/rules$/);
    if (ruleCreate) return cloudflareOk({ id: ruleCreate[1] === "cfg_ruleset_1" ? "cfg_rule_1" : "org_rule_1" });
    if (path.includes("/rules/")) return cloudflareOk({ id: path.split("/").pop() });
    return null;
  };
}

// --- fixtures ---

function frontendRow(overrides: Partial<Row> = {}): Row {
  return {
    node_id: "node_one",
    tunnel_id: "inbound-1",
    hostname: "ta-00000000000000000000.example.com",
    zone_id: "zone_1",
    zone_name: "example.com",
    status: "active",
    operation_id: null,
    dns_record_id: null,
    config_ruleset_id: null,
    config_rule_id: null,
    origin_ruleset_id: null,
    origin_rule_id: null,
    source_endpoint: "203.0.113.8:10086",
    source_path: "/vmess",
    last_error: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

function seedFrontend(db: FakeD1, overrides: Partial<Row> = {}) {
  const row = frontendRow(overrides);
  db.frontends.set(`${row.node_id}\u0000${row.tunnel_id}`, row);
  return row;
}

function seedTunnel(db: FakeD1, overrides: Partial<Row> = {}) {
  db.tunnels.set("node_one\u0000inbound-1", {
    id: "inbound-1",
    node_id: "node_one",
    name: "public",
    kind: "sing-box/inbound",
    endpoint: "203.0.113.8:10086",
    protocol: "vmess",
    status: "healthy",
    metadata_json: JSON.stringify({ transport: { type: "ws", path: "/vmess" } }),
    authentication_ciphertext: null,
    last_seen_at: new Date().toISOString(),
    ...overrides,
  });
}

function envFor(db: FakeD1, overrides: Partial<Env> = {}): Env {
  return {
    ADMIN_TOKEN: "admin-token",
    READ_TOKEN: "read-token",
    ENROLLMENT_PEPPER: "pepper",
    CREDENTIALS_KEY: bytesToBase64Url(new Uint8Array(32).fill(7)),
    DB: db,
    CLOUDFLARE_API_TOKEN: "cf-token",
    CLOUDFLARE_ZONE_NAME: "example.com",
    ...overrides,
  } as unknown as Env;
}

function adminRequest(path: string, method: string): Request {
  return new Request(`https://atlas.example${path}`, {
    method,
    headers: { Authorization: "Bearer admin-token" },
  });
}

function frontendPath(nodeId = "node_one", tunnelId = "inbound-1"): string {
  return `/v1/admin/nodes/${encodeURIComponent(nodeId)}/tunnels/${encodeURIComponent(tunnelId)}/cloudflare`;
}

async function tunnelHostname(): Promise<string> {
  const digest = await sha256Hex("node_one:inbound-1");
  return `ta-${digest.slice(0, 20)}.example.com`;
}

function testContext() {
  const pending: Array<Promise<void>> = [];
  return {
    ctx: { waitUntil: (promise: Promise<unknown>) => { pending.push(promise as Promise<void>); } } as unknown as ExecutionContext,
    drain: async () => {
      while (pending.length > 0) {
        const batch = pending.splice(0);
        await Promise.all(batch);
      }
    },
  };
}

async function signedReport(db: FakeD1, tunnels: unknown[], sequence = 1): Promise<Request> {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  db.nodes.set("node_one", { id: "node_one", public_key: publicKey, last_sequence: 0 });
  const body = JSON.stringify({ agentVersion: "0.0.9", tunnels });
  const contentHash = await sha256Hex(body);
  const timestamp = new Date().toISOString();
  const canonical = `POST\n/v1/agent/report\n${timestamp}\n${sequence}\n${contentHash}`;
  const signature = bytesToBase64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(canonical))));
  return new Request("https://atlas.example/v1/agent/report", {
    method: "POST",
    headers: {
      "X-Agent-ID": "node_one",
      "X-Timestamp": timestamp,
      "X-Sequence": String(sequence),
      "X-Content-SHA256": contentHash,
      "X-Signature": signature,
      "Content-Type": "application/json",
    },
    body,
  });
}

function vmessReportTunnel(endpoint: string, path = "/vmess"): Record<string, unknown> {
  return {
    id: "inbound-1",
    name: "public",
    kind: "sing-box/inbound",
    endpoint,
    protocol: "vmess",
    status: "healthy",
    metadata: { transport: { type: "ws", path } },
    authentication: { users: [{ uuid: "vmess-uuid" }] },
  };
}

// --- provisioning ---

describe("Cloudflare frontend provisioning", () => {
  it("creates a proxied DNS record, enables WebSockets, and installs both rules", async () => {
    const db = new FakeD1();
    seedTunnel(db);
    const cf = mockCloudflare(happyPathHandler());
    const hostname = await tunnelHostname();

    const response = await worker.fetch(adminRequest(frontendPath(), "PUT"), envFor(db));
    const body = await response.json() as Record<string, any>;

    expect(response.status).toBe(200);
    expect(body.frontend).toMatchObject({ hostname, status: "active", sourceEndpoint: "203.0.113.8:10086" });
    expect(body.frontend.error).toBeNull();

    const dnsPost = cf.requests.find((request) => request.path === "/zones/zone_1/dns_records" && request.method === "POST");
    expect(dnsPost?.body).toEqual({
      type: "A",
      name: hostname,
      content: "203.0.113.8",
      ttl: 1,
      proxied: true,
      comment: "tunnelatlas:node_one:inbound-1",
    });
    const wsPatch = cf.requests.find((request) => request.path === "/zones/zone_1/settings/websockets" && request.method === "PATCH");
    expect(wsPatch?.body).toEqual({ value: "on" });
    const configRule = cf.requests.find((request) => request.path === "/zones/zone_1/rulesets/cfg_ruleset_1/rules" && request.method === "POST");
    expect(configRule?.body).toEqual({
      expression: `(http.host eq "${hostname}")`,
      action: "set_config",
      action_parameters: { ssl: "flexible" },
      ref: `ta-config-${hostname.slice(3, 23)}`,
    });
    const originRule = cf.requests.find((request) => request.path === "/zones/zone_1/rulesets/org_ruleset_1/rules" && request.method === "POST");
    expect(originRule?.body).toEqual({
      expression: `(http.host eq "${hostname}" and http.request.uri.path eq "/vmess")`,
      action: "route",
      action_parameters: { origin: { port: 10086 } },
      ref: `ta-origin-${hostname.slice(3, 23)}`,
    });

    const row = db.frontends.get("node_one\u0000inbound-1");
    expect(row).toMatchObject({
      status: "active",
      dns_record_id: "dns_1",
      config_ruleset_id: "cfg_ruleset_1",
      config_rule_id: "cfg_rule_1",
      origin_ruleset_id: "org_ruleset_1",
      origin_rule_id: "org_rule_1",
      source_endpoint: "203.0.113.8:10086",
      source_path: "/vmess",
      zone_id: "zone_1",
    });
    expect(row?.operation_id).toBeNull();
    expect(row?.last_error).toBeNull();
    cf.restore();
  });

  it("returns 503 when Cloudflare variables are not configured", async () => {
    const db = new FakeD1();
    seedTunnel(db);
    const cf = mockCloudflare(happyPathHandler());
    const response = await worker.fetch(
      adminRequest(frontendPath(), "PUT"),
      envFor(db, { CLOUDFLARE_API_TOKEN: undefined, CLOUDFLARE_ZONE_NAME: undefined }),
    );
    expect(response.status).toBe(503);
    expect(cf.requests).toEqual([]);
    cf.restore();
  });

  it("rejects non-VMess, non-WebSocket, and invalid tunnels with 409", async () => {
    const cases: Array<Partial<Row>> = [
      { protocol: "vless" },
      { metadata_json: JSON.stringify({ transport: { type: "grpc", path: "/vmess" } }) },
      { metadata_json: JSON.stringify({ transport: { type: "ws", path: "vmess" } }) },
      { endpoint: "192.168.1.5:10086" },
      { endpoint: "[::]:10086" },
      { endpoint: "10.0.0.5:10086" },
      { endpoint: "not a host:10086" },
    ];
    for (const overrides of cases) {
      const db = new FakeD1();
      seedTunnel(db, overrides);
      const cf = mockCloudflare(happyPathHandler());
      const response = await worker.fetch(adminRequest(frontendPath(), "PUT"), envFor(db));
      expect(response.status).toBe(409);
      expect(cf.requests).toEqual([]);
      expect(db.frontends.size).toBe(0);
      cf.restore();
    }
  });

  it("rejects a legacy transport host that differs from the generated hostname", async () => {
    const db = new FakeD1();
    seedTunnel(db, { metadata_json: JSON.stringify({ transport: { type: "ws", path: "/vmess", host: "cdn.example.com" } }) });
    const cf = mockCloudflare(happyPathHandler());
    const response = await worker.fetch(adminRequest(frontendPath(), "PUT"), envFor(db));
    expect(response.status).toBe(409);
    const body = await response.json() as Record<string, string>;
    expect(body.title).toContain("must match the generated hostname");
    expect(cf.requests).toEqual([]);
    cf.restore();
  });

  it("returns 404 when the tunnel row does not exist", async () => {
    const db = new FakeD1();
    const cf = mockCloudflare(happyPathHandler());
    const response = await worker.fetch(adminRequest(frontendPath(), "PUT"), envFor(db));
    expect(response.status).toBe(404);
    expect(cf.requests).toEqual([]);
    cf.restore();
  });

  it("rejects an unowned DNS record with 409 and keeps the row in error", async () => {
    const db = new FakeD1();
    seedTunnel(db);
    const hostname = await tunnelHostname();
    const cf = mockCloudflare((request) => {
      if (request.path.startsWith("/zones/zone_1/dns_records?name=")) {
        return cloudflareOk([{ id: "dns_foreign", name: `${hostname}.`, type: "A", content: "198.51.100.9", comment: null }]);
      }
      return happyPathHandler()(request);
    });
    const response = await worker.fetch(adminRequest(frontendPath(), "PUT"), envFor(db));
    expect(response.status).toBe(409);
    const row = db.frontends.get("node_one\u0000inbound-1");
    expect(row?.status).toBe("error");
    expect(String(row?.last_error)).toContain("already exists");
    cf.restore();
  });

  it("returns 502 with a sanitized message when the provider fails", async () => {
    const db = new FakeD1();
    seedTunnel(db);
    const cf = mockCloudflare(() => cloudflareError(400, ["ruleset quota exceeded for this zone", "second error"]));
    const response = await worker.fetch(adminRequest(frontendPath(), "PUT"), envFor(db));
    expect(response.status).toBe(502);
    const body = await response.json() as Record<string, string>;
    expect(body.title).toContain("ruleset quota exceeded for this zone; second error");
    const row = db.frontends.get("node_one\u0000inbound-1");
    expect(row?.status).toBe("error");
    expect(String(row?.last_error)).toContain("quota");
    cf.restore();
  });

  it("resumes a partial provisioning by stored IDs without duplicating resources", async () => {
    const db = new FakeD1();
    seedTunnel(db);
    const hostname = await tunnelHostname();
    seedFrontend(db, {
      status: "error",
      operation_id: null,
      dns_record_id: "dns_1",
      config_ruleset_id: "cfg_ruleset_1",
      config_rule_id: "cfg_rule_1",
      hostname,
    });
    const cf = mockCloudflare((request) => {
      if (request.path === "/zones/zone_1/dns_records/dns_1") {
        return cloudflareOk({ id: "dns_1", name: hostname, type: "A", content: "203.0.113.8", comment: "tunnelatlas:node_one:inbound-1" });
      }
      if (request.path === "/zones/zone_1/rulesets/phases/http_config_settings/entrypoint") {
        return cloudflareOk({ id: "cfg_ruleset_1", rules: [{ id: "cfg_rule_1", ref: "ta-config-x" }] });
      }
      if (request.path === "/zones/zone_1/rulesets/phases/http_request_origin/entrypoint") {
        return cloudflareOk({ id: "org_ruleset_1", rules: [] });
      }
      if (request.path === "/zones/zone_1/rulesets/cfg_ruleset_1/rules/cfg_rule_1") {
        return cloudflareOk({ id: "cfg_rule_1" });
      }
      return happyPathHandler()(request);
    });

    const response = await worker.fetch(adminRequest(frontendPath(), "PUT"), envFor(db));
    expect(response.status).toBe(200);

    const dnsPosts = cf.requests.filter((request) => request.path === "/zones/zone_1/dns_records" && request.method === "POST");
    expect(dnsPosts).toHaveLength(0);
    expect(cf.requests.some((request) => request.path === "/zones/zone_1/rulesets/cfg_ruleset_1/rules/cfg_rule_1" && request.method === "PATCH")).toBe(true);
    expect(cf.requests.some((request) => request.path === "/zones/zone_1/rulesets/org_ruleset_1/rules" && request.method === "POST")).toBe(true);
    const row = db.frontends.get("node_one\u0000inbound-1");
    expect(row?.status).toBe("active");
    cf.restore();
  });

  it("rejects a concurrent fresh lease with 409", async () => {
    const db = new FakeD1();
    seedTunnel(db);
    seedFrontend(db, {
      status: "provisioning",
      operation_id: "op-in-flight",
      updated_at: new Date().toISOString(),
    });
    const cf = mockCloudflare(happyPathHandler());
    const response = await worker.fetch(adminRequest(frontendPath(), "PUT"), envFor(db));
    expect(response.status).toBe(409);
    expect(cf.requests).toEqual([]);
    cf.restore();
  });

  it("takes over a stale lease and proceeds", async () => {
    const db = new FakeD1();
    seedTunnel(db);
    seedFrontend(db, {
      status: "provisioning",
      operation_id: "op-stale",
      updated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const cf = mockCloudflare(happyPathHandler());
    const response = await worker.fetch(adminRequest(frontendPath(), "PUT"), envFor(db));
    expect(response.status).toBe(200);
    expect(cf.requests.some((request) => request.path === "/zones?name=example.com&status=active")).toBe(true);
    cf.restore();
  });
});

// --- deprovisioning ---

describe("Cloudflare frontend deprovisioning", () => {
  it("removes the origin rule, config rule, and DNS record before deleting tracking", async () => {
    const db = new FakeD1();
    const hostname = await tunnelHostname();
    seedFrontend(db, {
      hostname,
      dns_record_id: "dns_1",
      config_ruleset_id: "cfg_ruleset_1",
      config_rule_id: "cfg_rule_1",
      origin_ruleset_id: "org_ruleset_1",
      origin_rule_id: "org_rule_1",
    });
    const cf = mockCloudflare(happyPathHandler());

    const response = await worker.fetch(adminRequest(frontendPath(), "DELETE"), envFor(db));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true, nodeId: "node_one", tunnelId: "inbound-1" });

    const deletes = cf.requests.filter((request) => request.method === "DELETE").map((request) => request.path);
    expect(deletes).toEqual([
      "/zones/zone_1/rulesets/org_ruleset_1/rules/org_rule_1",
      "/zones/zone_1/rulesets/cfg_ruleset_1/rules/cfg_rule_1",
      "/zones/zone_1/dns_records/dns_1",
    ]);
    expect(db.frontends.size).toBe(0);
    cf.restore();
  });

  it("treats already-missing resources as gone and finishes cleanup", async () => {
    const db = new FakeD1();
    seedFrontend(db, {
      dns_record_id: "dns_1",
      config_ruleset_id: "cfg_ruleset_1",
      config_rule_id: "cfg_rule_1",
      origin_ruleset_id: "org_ruleset_1",
      origin_rule_id: "org_rule_1",
    });
    const cf = mockCloudflare((request) => {
      if (request.method === "DELETE") return cloudflareError(404, ["record not found"]);
      return happyPathHandler()(request);
    });

    const response = await worker.fetch(adminRequest(frontendPath(), "DELETE"), envFor(db));
    expect(response.status).toBe(200);
    expect(db.frontends.size).toBe(0);
    cf.restore();
  });

  it("returns 404 when there is no tracked frontend", async () => {
    const db = new FakeD1();
    const cf = mockCloudflare(happyPathHandler());
    const response = await worker.fetch(adminRequest(frontendPath(), "DELETE"), envFor(db));
    expect(response.status).toBe(404);
    expect(cf.requests).toEqual([]);
    cf.restore();
  });
});

// --- report reconciliation ---

describe("Agent report reconciliation", () => {
  it("marks a changed endpoint provisioning and resynchronizes after the report", async () => {
    const db = new FakeD1();
    const hostname = await tunnelHostname();
    seedFrontend(db, { hostname, dns_record_id: "dns_1" });
    const cf = mockCloudflare(happyPathHandler());
    const { ctx, drain } = testContext();

    const request = await signedReport(db, [vmessReportTunnel("203.0.113.9:10086")]);
    const response = await worker.fetch(request, envFor(db), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ acceptedSequence: 1 });

    const marking = db.calls.find((call) => call.sql.includes("SET status = 'provisioning'"));
    expect(marking).toBeDefined();
    expect(marking?.values).toContain("203.0.113.9:10086");
    expect(marking?.values).toContain("/vmess");

    await drain();
    const dnsPost = cf.requests.find((request) => request.path === "/zones/zone_1/dns_records" && request.method === "POST");
    expect(dnsPost?.body).toMatchObject({ type: "A", content: "203.0.113.9", proxied: true });
    const row = db.frontends.get("node_one\u0000inbound-1");
    expect(row).toMatchObject({ status: "active", source_endpoint: "203.0.113.9:10086" });
    expect(row?.operation_id).toBeNull();
    cf.restore();
  });

  it("deprovisions rows whose tunnel disappeared from the report", async () => {
    const db = new FakeD1();
    const hostname = await tunnelHostname();
    seedFrontend(db, {
      hostname,
      dns_record_id: "dns_1",
      config_ruleset_id: "cfg_ruleset_1",
      config_rule_id: "cfg_rule_1",
      origin_ruleset_id: "org_ruleset_1",
      origin_rule_id: "org_rule_1",
    });
    const cf = mockCloudflare(happyPathHandler());
    const { ctx, drain } = testContext();

    const request = await signedReport(db, []);
    const response = await worker.fetch(request, envFor(db), ctx);
    expect(response.status).toBe(200);

    const marking = db.calls.find((call) => call.sql.includes("SET status = 'deleting'"));
    expect(marking).toBeDefined();

    await drain();
    const deletes = cf.requests.filter((request) => request.method === "DELETE").map((request) => request.path);
    expect(deletes).toHaveLength(3);
    expect(db.frontends.size).toBe(0);
    cf.restore();
  });

  it("keeps an unchanged frontend active without touching Cloudflare", async () => {
    const db = new FakeD1();
    const hostname = await tunnelHostname();
    seedFrontend(db, { hostname, dns_record_id: "dns_1" });
    const cf = mockCloudflare(happyPathHandler());
    const { ctx, drain } = testContext();

    const request = await signedReport(db, [vmessReportTunnel("203.0.113.8:10086")]);
    const response = await worker.fetch(request, envFor(db), ctx);
    expect(response.status).toBe(200);
    expect(db.calls.some((call) => call.sql.includes("SET status = 'provisioning'"))).toBe(false);
    await drain();
    expect(cf.requests).toEqual([]);
    expect(db.frontends.get("node_one\u0000inbound-1")?.status).toBe("active");
    cf.restore();
  });

  it("never fails the Agent report when Cloudflare reconciliation fails", async () => {
    const db = new FakeD1();
    const hostname = await tunnelHostname();
    seedFrontend(db, { hostname, dns_record_id: "dns_1" });
    const cf = mockCloudflare(() => cloudflareError(500, ["upstream exploded"]));
    const { ctx, drain } = testContext();

    const request = await signedReport(db, [vmessReportTunnel("203.0.113.9:10086")]);
    const response = await worker.fetch(request, envFor(db), ctx);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ acceptedSequence: 1 });

    await drain();
    const row = db.frontends.get("node_one\u0000inbound-1");
    expect(row?.status).toBe("error");
    expect(String(row?.last_error)).toContain("upstream exploded");
    expect(row?.dns_record_id).toBe("dns_1");
    cf.restore();
  });
});
