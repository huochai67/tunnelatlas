import { describe, expect, it } from "vitest";
import {
  desiredTunnelFromRow,
  validateEnrollment,
  validateReport,
  validateTunnelConfigInput,
  validateTunnelPatchInput,
} from "../src/validation";
import type { ConfigApplyErrorCode } from "../src/types";

function report(authentication: unknown) {
  return {
    agentVersion: "0.0.3",
    tunnels: [{
      id: "inbound-1",
      name: "public",
      kind: "sing-box/inbound",
      endpoint: "[::]:443",
      protocol: "vless",
      status: "healthy" as const,
      authentication,
    }],
  };
}

describe("report authentication validation", () => {
  it("accepts allowlisted inbound authentication", () => {
    expect(() => validateReport(report({
      method: "2022-blake3-aes-128-gcm",
      password: "secret",
      users: [{ name: "alice", uuid: "client-uuid", flow: "xtls-rprx-vision" }],
    }))).not.toThrow();
  });

  it("rejects private and unknown fields", () => {
    expect(() => validateReport(report({ private_key: "must-not-upload" }))).toThrow(
      "Invalid tunnel.authentication field",
    );
  });
});

describe("node enrollment validation", () => {
  it("accepts enrollment without site or node names", () => {
    expect(() => validateEnrollment({
      publicKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      platform: { os: "linux", arch: "x86_64", agentVersion: "0.0.9" },
      labels: {},
    })).not.toThrow();
  });
});

describe("report desired config metadata validation", () => {
  it("accepts null or non-negative integer appliedConfigVersion", () => {
    expect(() => validateReport({ ...report(undefined), appliedConfigVersion: null })).not.toThrow();
    expect(() => validateReport({ ...report(undefined), appliedConfigVersion: 0 })).not.toThrow();
    expect(() => validateReport({ ...report(undefined), appliedConfigVersion: 42 })).not.toThrow();
  });

  it("rejects invalid appliedConfigVersion", () => {
    expect(() => validateReport({ ...report(undefined), appliedConfigVersion: -1 })).toThrow("Invalid appliedConfigVersion");
    expect(() => validateReport({ ...report(undefined), appliedConfigVersion: 1.5 })).toThrow("Invalid appliedConfigVersion");
  });

  it("accepts allowlisted configApplyError codes", () => {
    const allowed = [
      "invalid_desired_config",
      "sing_box_validation_failed",
      "sing_box_start_failed",
      "local_apply_failed",
    ] as const;
    for (const code of allowed) {
      expect(() => validateReport({ ...report(undefined), configApplyError: code })).not.toThrow();
    }
  });

  it("rejects arbitrary or raw stderr in configApplyError", () => {
    expect(() => validateReport({ ...report(undefined), configApplyError: "FATAL: sing-box failed" as unknown as ConfigApplyErrorCode })).toThrow(
      "Invalid configApplyError",
    );
  });
});

describe("tunnel config input validation and normalization", () => {
  it("validates and normalizes shadowsocks defaults", () => {
    const result = validateTunnelConfigInput({
      name: "ss_1",
      type: "shadowsocks",
      port: 8388,
    });
    expect(result).toEqual({
      name: "ss_1",
      type: "shadowsocks",
      listen: "::",
      port: 8388,
      publicHost: null,
      options: { method: "2022-blake3-aes-128-gcm" },
      hops: [],
    });
  });

  it("accepts custom shadowsocks method and public host", () => {
    const result = validateTunnelConfigInput({
      name: "ss-custom",
      type: "shadowsocks",
      port: 8388,
      listen: "0.0.0.0",
      publicHost: "203.0.113.1",
      method: "2022-blake3-chacha20-poly1305",
    });
    expect(result.options.method).toBe("2022-blake3-chacha20-poly1305");
    expect(result.publicHost).toBe("203.0.113.1");
    expect(result.listen).toBe("0.0.0.0");
  });

  it("validates and normalizes tuic defaults and options", () => {
    const result = validateTunnelConfigInput({
      name: "tuic-in",
      type: "tuic",
      port: 8443,
    });
    expect(result.options).toEqual({
      serverName: "www.bing.com",
      congestionControl: "bbr",
    });
  });

  it("validates and normalizes vmess-ws defaults and options", () => {
    const result = validateTunnelConfigInput({
      name: "vmess-in",
      type: "vmess-ws",
      port: 10086,
      path: "/custom-vmess",
      host: "proxy.example.com",
    });
    expect(result.options).toEqual({
      path: "/custom-vmess",
      host: "proxy.example.com",
    });
  });

  it("rejects invalid tunnel name", () => {
    expect(() => validateTunnelConfigInput({ name: "has space", type: "shadowsocks", port: 8388 })).toThrow("Invalid tunnel name");
    expect(() => validateTunnelConfigInput({ name: "", type: "shadowsocks", port: 8388 })).toThrow("Invalid tunnel name");
  });

  it("rejects invalid tunnel port", () => {
    expect(() => validateTunnelConfigInput({ name: "ss", type: "shadowsocks", port: 0 })).toThrow("Invalid tunnel port");
    expect(() => validateTunnelConfigInput({ name: "ss", type: "shadowsocks", port: 70000 })).toThrow("Invalid tunnel port");
  });

  it("rejects invalid listen address and invalid public host", () => {
    expect(() => validateTunnelConfigInput({ name: "ss", type: "shadowsocks", port: 8388, listen: "not-an-ip" })).toThrow(
      "Invalid listen address",
    );
    expect(() => validateTunnelConfigInput({ name: "ss", type: "shadowsocks", port: 8388, publicHost: "192.168.1.1" })).toThrow(
      "Invalid public host",
    );
  });

  it("accepts and rejects hop lists", () => {
    const result = validateTunnelConfigInput({
      name: "ss",
      type: "shadowsocks",
      port: 8388,
      hops: [{ nodeId: "node_exit", tunnelId: "tunnel_exit" }],
    });
    expect(result.hops).toEqual([{ nodeId: "node_exit", tunnelId: "tunnel_exit" }]);
    expect(() => validateTunnelConfigInput({
      name: "ss",
      type: "shadowsocks",
      port: 8388,
      hops: [{ nodeId: "node_exit", tunnelId: "tunnel_exit" }, { nodeId: "node_exit", tunnelId: "tunnel_exit" }],
    })).toThrow("Duplicate hop");
    expect(() => validateTunnelConfigInput({
      name: "ss",
      type: "shadowsocks",
      port: 8388,
      hops: [1, 2, 3, 4],
    })).toThrow("Invalid hops");
  });

  it("validates patch input", () => {
    expect(validateTunnelPatchInput({ subscriptionEnabled: false })).toEqual({ subscriptionEnabled: false });
    expect(() => validateTunnelPatchInput({ subscriptionEnabled: "false" })).toThrow("Invalid subscriptionEnabled");
  });

  it("converts tunnel config row to desired tunnel", () => {
    const row = {
      node_id: "node_1",
      id: "tunnel_1",
      name: "ss-1",
      type: "shadowsocks" as const,
      listen: "::",
      port: 8388,
      public_host: null,
      options_json: JSON.stringify({ method: "2022-blake3-aes-256-gcm" }),
      credential_generation: 2,
      subscription_enabled: 1,
      credentials_ciphertext: null,
      created_at: "2026-08-01T00:00:00Z",
      updated_at: "2026-08-01T00:00:00Z",
    };
    const desired = desiredTunnelFromRow(row);
    expect(desired).toEqual({
      id: "tunnel_1",
      name: "ss-1",
      type: "shadowsocks",
      listen: "::",
      port: 8388,
      publicHost: null,
      credentialGeneration: 2,
      method: "2022-blake3-aes-256-gcm",
    });
  });
});
