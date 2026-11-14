import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url, decryptJson, encryptJson, sha256Hex, timingSafeEqualStrings } from "../src/crypto";

describe("crypto encoding", () => {
  it("round trips base64url", () => {
    const input = new Uint8Array([0, 1, 2, 250, 255]);
    expect(base64UrlToBytes(bytesToBase64Url(input))).toEqual(input);
  });

  it("hashes with sha256", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("encrypts and decrypts authentication JSON", async () => {
    const key = bytesToBase64Url(new Uint8Array(32).fill(7));
    const authentication = { users: [{ name: "alice", uuid: "test-uuid" }] };
    const encrypted = await encryptJson(authentication, key, "agent-1:inbound-1");

    expect(encrypted).not.toContain("alice");
    expect(await decryptJson(encrypted, key, "agent-1:inbound-1")).toEqual(authentication);
  });

  it("binds encrypted authentication to its tunnel", async () => {
    const key = bytesToBase64Url(new Uint8Array(32).fill(9));
    const encrypted = await encryptJson({ password: "secret" }, key, "agent-1:inbound-1");

    await expect(decryptJson(encrypted, key, "agent-1:inbound-2")).rejects.toThrow();
  });

  it("compares strings in constant time across matching and differing lengths", async () => {
    expect(await timingSafeEqualStrings("", "")).toBe(true);
    expect(await timingSafeEqualStrings("admin-token", "admin-token")).toBe(true);
    expect(await timingSafeEqualStrings("令牌-alpha", "令牌-alpha")).toBe(true);

    expect(await timingSafeEqualStrings("admin-token", "admin-tokeN")).toBe(false);
    expect(await timingSafeEqualStrings("admin-token", "admin")).toBe(false);
    expect(await timingSafeEqualStrings("admin-token", "admin-token-2")).toBe(false);
    expect(await timingSafeEqualStrings("admin-token", "")).toBe(false);
    expect(await timingSafeEqualStrings("", "admin-token")).toBe(false);
  });

  it("uses crypto.subtle.timingSafeEqual when provided by the runtime", async () => {
    const calls: Array<[Uint8Array, Uint8Array]> = [];
    const original = Object.getOwnPropertyDescriptor(crypto.subtle, "timingSafeEqual");
    Object.defineProperty(crypto.subtle, "timingSafeEqual", {
      configurable: true,
      value(a: Uint8Array, b: Uint8Array) {
        calls.push([a, b]);
        return a.length === b.length && a.every((byte, idx) => byte === b[idx]);
      },
    });
    try {
      expect(await timingSafeEqualStrings("secret-1", "secret-1")).toBe(true);
      expect(await timingSafeEqualStrings("secret-1", "secret-2")).toBe(false);
      expect(calls).toHaveLength(2);
      expect(calls[0][0]).toHaveLength(32);
      expect(calls[0][1]).toHaveLength(32);
    } finally {
      if (original) {
        Object.defineProperty(crypto.subtle, "timingSafeEqual", original);
      } else {
        delete (crypto.subtle as unknown as Record<string, unknown>).timingSafeEqual;
      }
    }
  });
});
