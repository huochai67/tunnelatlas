import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url, decryptJson, encryptJson, sha256Hex } from "../src/crypto";

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
});
