import { describe, expect, it } from "vitest";
import { validateReport } from "../src/validation";

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
