import { describe, expect, it } from "vitest";
import { generateProtocolCredentials } from "../src/credentials";
import { base64UrlToBytes, bytesToBase64Url } from "../src/crypto";
import { x25519, x25519Base } from "../src/x25519";

function hex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

describe("x25519", () => {
  it("matches RFC 7748 section 6.1", () => {
    const scalar = hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
    const u = hex("0900000000000000000000000000000000000000000000000000000000000000");
    const output = hex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
    expect(x25519(scalar, u)).toEqual(output);
    expect(x25519Base(scalar)).toEqual(output);
  });
});

describe("generateProtocolCredentials", () => {
  it("emits ss2022 standard base64 of the method size", () => {
    const aes128 = generateProtocolCredentials("shadowsocks", "2022-blake3-aes-128-gcm");
    const aes256 = generateProtocolCredentials("shadowsocks", "2022-blake3-aes-256-gcm");
    expect(atob(aes128.password ?? "").length).toBe(16);
    expect(atob(aes256.password ?? "").length).toBe(32);
  });

  it("emits a Reality keypair whose public key matches the private scalar", () => {
    const credentials = generateProtocolCredentials("vless-reality");
    expect(credentials.uuid).toMatch(/^[0-9a-f-]{36}$/i);
    expect(credentials.shortId).toMatch(/^[0-9a-f]{16}$/);
    const decoded = base64UrlToBytes(credentials.privateKey ?? "");
    expect(decoded.byteLength).toBe(32);
    expect(bytesToBase64Url(x25519Base(decoded))).toBe(credentials.publicKey);
  });
});
