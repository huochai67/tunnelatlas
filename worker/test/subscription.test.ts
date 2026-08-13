import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { bytesToBase64Url, encryptJson } from "../src/crypto";
import { encodeSubscription, subscriptionUris, type SubscriptionTunnel } from "../src/subscription";
import type { Env } from "../src/types";

function tunnel(overrides: Partial<SubscriptionTunnel> = {}): SubscriptionTunnel {
  return {
    nodeName: "edge-01",
    authentication: { method: "2022-blake3-aes-128-gcm", password: "secret" },
    endpoint: "proxy.example.com:8388",
    metadata: {},
    name: "public",
    protocol: "shadowsocks",
    status: "healthy",
    ...overrides,
  };
}

describe("node subscription", () => {
  it("encodes healthy nodes as a base64 list of standard URIs", () => {
    const tunnels = [
      tunnel(),
      tunnel({
        authentication: { users: [{ name: "alice", uuid: "client-uuid", flow: "xtls-rprx-vision" }] },
        endpoint: "[2001:db8::1]:443",
        metadata: {
          tls: {
            enabled: true,
            serverName: "addons.mozilla.org",
            reality: { enabled: true, publicKey: "reality-public-key", shortId: "0123456789abcdef" },
          },
        },
        name: "vless",
        protocol: "vless",
      }),
    ];
    const uris = subscriptionUris(tunnels);
    expect(uris).toHaveLength(2);
    expect(uris[0]).toMatch(/^ss:\/\/[A-Za-z0-9_-]+@proxy\.example\.com:8388#/);
    expect(uris[1]).toBe("vless://client-uuid@[2001:db8::1]:443?encryption=none&flow=xtls-rprx-vision&security=reality&sni=addons.mozilla.org&fp=chrome&pbk=reality-public-key&sid=0123456789abcdef#edge-01%2Fvless%2Falice");
    expect(new TextDecoder().decode(Uint8Array.from(atob(encodeSubscription(tunnels)), (character) => character.charCodeAt(0))))
      .toBe(uris.join("\n"));
  });

  it("omits unhealthy, unsupported, and incomplete nodes", () => {
    expect(subscriptionUris([
      tunnel({ status: "failed" }),
      tunnel({ protocol: "socks" }),
      tunnel({ authentication: {} }),
      tunnel({
        protocol: "vless",
        authentication: { users: [{ uuid: "client-uuid" }] },
        metadata: { tls: { reality: { enabled: true } } },
      }),
    ])).toEqual([]);
  });

  it("creates links for every Agent-managed protocol", () => {
    const tls = { enabled: true, serverName: "www.bing.com", alpn: ["h3"], insecure: true };
    const reality = {
      enabled: true,
      serverName: "addons.mozilla.org",
      reality: { enabled: true, publicKey: "public-key", shortId: "0123456789abcdef" },
    };
    const uris = subscriptionUris([
      tunnel({ protocol: "hysteria2", endpoint: "proxy.example.com:20001", authentication: { users: [{ password: "hy2-secret" }] }, metadata: { tls } }),
      tunnel({ protocol: "tuic", endpoint: "proxy.example.com:20002", authentication: { users: [{ uuid: "tuic-uuid", password: "tuic-secret" }] }, metadata: { tls, congestionControl: "bbr" } }),
      tunnel({ protocol: "anytls", endpoint: "proxy.example.com:20003", authentication: { users: [{ name: "tunnelatlas", password: "anytls-secret" }] }, metadata: { tls: reality } }),
      tunnel({ protocol: "vmess", endpoint: "proxy.example.com:20004", authentication: { users: [{ uuid: "vmess-uuid" }] }, metadata: { transport: { type: "ws", path: "/vmess", host: "cdn.example.com" } } }),
    ]);
    expect(uris).toHaveLength(4);
    expect(uris[0]).toMatch(/^hysteria2:\/\//);
    expect(uris[1]).toMatch(/^tuic:\/\//);
    expect(uris[2]).toMatch(/^anytls:\/\//);
    expect(uris[3]).toMatch(/^vmess:\/\//);
  });

  function decodeVmess(uri: string): Record<string, string> {
    const encoded = uri.slice("vmess://".length);
    const json = new TextDecoder().decode(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)));
    return JSON.parse(json) as Record<string, string>;
  }

  function vmessTunnel(overrides: Partial<SubscriptionTunnel> = {}): SubscriptionTunnel {
    return tunnel({
      protocol: "vmess",
      endpoint: "203.0.113.8:10086",
      authentication: { users: [{ uuid: "vmess-uuid" }] },
      metadata: { transport: { type: "ws", path: "/vmess", host: "" } },
      ...overrides,
    });
  }

  it("overlays an active Cloudflare frontend on the VMess-WS URI", () => {
    const uris = subscriptionUris([vmessTunnel({
      cloudflare: { hostname: "ta-0123456789abcdef0123.example.com", status: "active" },
    })]);
    expect(uris).toHaveLength(1);
    expect(decodeVmess(uris[0])).toEqual({
      v: "2",
      ps: "edge-01/public/1",
      add: "ta-0123456789abcdef0123.example.com",
      port: "443",
      id: "vmess-uuid",
      aid: "0",
      scy: "auto",
      net: "ws",
      type: "none",
      host: "ta-0123456789abcdef0123.example.com",
      path: "/vmess",
      tls: "tls",
      sni: "ta-0123456789abcdef0123.example.com",
    });
  });

  it("keeps the direct endpoint for provisioning, deleting, error, and missing frontends", () => {
    for (const status of ["provisioning", "deleting", "error"]) {
      const uris = subscriptionUris([vmessTunnel({
        cloudflare: { hostname: "ta-0123456789abcdef0123.example.com", status },
      })]);
      const node = decodeVmess(uris[0]);
      expect(node).toMatchObject({
        add: "203.0.113.8",
        port: "10086",
        host: "",
        tls: "",
      });
      expect(node.sni).toBeUndefined();
    }
    const without = subscriptionUris([vmessTunnel({ cloudflare: null })]);
    expect(decodeVmess(without[0])).toMatchObject({ add: "203.0.113.8", port: "10086", tls: "" });
  });

  it("uses the preferred address as add while keeping host and SNI", () => {
    const uris = subscriptionUris([vmessTunnel({
      cloudflare: { hostname: "ta-0123456789abcdef0123.example.com", status: "active", address: "104.16.132.229" },
    })]);
    expect(uris).toHaveLength(1);
    const node = decodeVmess(uris[0]);
    expect(node.add).toBe("104.16.132.229");
    expect(node.host).toBe("ta-0123456789abcdef0123.example.com");
    expect(node.sni).toBe("ta-0123456789abcdef0123.example.com");
    expect(node.port).toBe("443");
    expect(node.tls).toBe("tls");
    expect(node.path).toBe("/vmess");
  });

  it("ignores the preferred address unless the frontend is active", () => {
    for (const status of ["provisioning", "deleting", "error"]) {
      const uris = subscriptionUris([vmessTunnel({
        cloudflare: { hostname: "ta-0123456789abcdef0123.example.com", status, address: "104.16.132.229" },
      })]);
      expect(decodeVmess(uris[0])).toMatchObject({ add: "203.0.113.8", port: "10086", tls: "" });
      expect(decodeVmess(uris[0]).sni).toBeUndefined();
    }
  });

  it("preserves UUID, display name, and reported path when the frontend is active", () => {
    const uris = subscriptionUris([vmessTunnel({
      name: "edge",
      authentication: { users: [{ name: "alice", uuid: "keep-uuid" }] },
      cloudflare: { hostname: "ta-0123456789abcdef0123.example.com", status: "active" },
    })]);
    const node = decodeVmess(uris[0]);
    expect(node.id).toBe("keep-uuid");
    expect(node.ps).toBe("edge-01/edge/alice");
    expect(node.path).toBe("/vmess");
    expect(node.net).toBe("ws");
  });

  it("leaves non-VMess URIs untouched by frontend data", () => {
    const base = tunnel({ protocol: "shadowsocks" });
    const plain = subscriptionUris([base])[0];
    const withFrontend = subscriptionUris([{ ...base, cloudflare: { hostname: "ta-x.example.com", status: "active" } }])[0];
    expect(withFrontend).toBe(plain);
  });

  it("accepts READ_TOKEN from the bearer header or URL query only", async () => {
    const env = {
      ADMIN_TOKEN: "admin-token",
      READ_TOKEN: "read-token",
      DB: {
        prepare: () => {
          const statement = {
            bind: () => statement,
            all: async () => ({ results: [] }),
          };
          return statement;
        },
      },
    } as unknown as Env;

    const missing = await worker.fetch(new Request("https://atlas.example/v1/subscription"), env);
    expect(missing.status).toBe(401);
    const admin = await worker.fetch(new Request("https://atlas.example/v1/subscription", {
      headers: { Authorization: "Bearer admin-token" },
    }), env);
    expect(admin.status).toBe(401);
    const adminQuery = await worker.fetch(new Request("https://atlas.example/v1/subscription?token=admin-token"), env);
    expect(adminQuery.status).toBe(401);
    const badQuery = await worker.fetch(new Request("https://atlas.example/v1/subscription?token=wrong"), env);
    expect(badQuery.status).toBe(401);
    const allowedHeader = await worker.fetch(new Request("https://atlas.example/v1/subscription", {
      headers: { Authorization: "Bearer read-token" },
    }), env);
    expect(allowedHeader.status).toBe(200);
    expect(await allowedHeader.text()).toBe("");
    const allowedQuery = await worker.fetch(new Request("https://atlas.example/v1/subscription?nodeId=node_one&token=read-token"), env);
    expect(allowedQuery.status).toBe(200);
    expect(await allowedQuery.text()).toBe("");
    const duplicateQuery = await worker.fetch(new Request("https://atlas.example/v1/subscription?token=read-token&token=read-token"), env);
    expect(duplicateQuery.status).toBe(401);
  });

  async function subscriptionEnv(frontend: { hostname: string; status: string } | null, overrides: Partial<Env> = {}): Promise<Env> {
    const key = bytesToBase64Url(new Uint8Array(32).fill(7));
    const row: Record<string, unknown> = {
      id: "inbound-1", node_id: "node_one", name: "public", kind: "sing-box/inbound",
      endpoint: "203.0.113.8:10086", protocol: "vmess", status: "healthy",
      metadata_json: JSON.stringify({ transport: { type: "ws", path: "/vmess" } }),
      authentication_ciphertext: await encryptJson({ users: [{ uuid: "vmess-uuid" }] }, key, "node_one:inbound-1"),
      last_seen_at: new Date().toISOString(),
      node_name: "edge-01",
      cf_hostname: frontend?.hostname ?? null,
      cf_status: frontend?.status ?? null,
      cf_source_endpoint: "203.0.113.8:10086",
      cf_source_path: "/vmess",
      cf_last_error: null,
      cf_updated_at: new Date().toISOString(),
    };
    const db = {
      prepare: () => {
        const statement = {
          bind: () => statement,
          all: async () => ({ results: [row] }),
        };
        return statement;
      },
    } as unknown as D1Database;
    return {
      ADMIN_TOKEN: "admin-token",
      READ_TOKEN: "read-token",
      ENROLLMENT_PEPPER: "pepper",
      CREDENTIALS_KEY: key,
      DB: db,
      ...overrides,
    } as unknown as Env;
  }

  async function subscriptionVmessNode(env: Env): Promise<Record<string, string>> {
    const response = await worker.fetch(new Request("https://atlas.example/v1/subscription", {
      headers: { Authorization: "Bearer read-token" },
    }), env);
    expect(response.status).toBe(200);
    const text = new TextDecoder().decode(Uint8Array.from(atob(await response.text()), (character) => character.charCodeAt(0)));
    return decodeVmess(text.trim().split("\n")[0]);
  }

  it("issues the preferred address from the environment for active frontends", async () => {
    const node = await subscriptionVmessNode(await subscriptionEnv(
      { hostname: "ta-0123456789abcdef0123.example.com", status: "active" },
      { CLOUDFLARE_PREFERRED_ADDRESS: "104.16.132.229" },
    ));
    expect(node.add).toBe("104.16.132.229");
    expect(node.host).toBe("ta-0123456789abcdef0123.example.com");
    expect(node.sni).toBe("ta-0123456789abcdef0123.example.com");
    expect(node.port).toBe("443");
  });

  it("falls back to the frontend hostname without the environment variable", async () => {
    const node = await subscriptionVmessNode(await subscriptionEnv({ hostname: "ta-0123456789abcdef0123.example.com", status: "active" }));
    expect(node.add).toBe("ta-0123456789abcdef0123.example.com");
  });

  it("ignores invalid preferred addresses from the environment", async () => {
    const node = await subscriptionVmessNode(await subscriptionEnv(
      { hostname: "ta-0123456789abcdef0123.example.com", status: "active" },
      { CLOUDFLARE_PREFERRED_ADDRESS: "192.168.1.1" },
    ));
    expect(node.add).toBe("ta-0123456789abcdef0123.example.com");
  });
});
