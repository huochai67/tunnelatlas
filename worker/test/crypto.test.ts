import { describe, expect, it } from "vitest";
import { base64UrlToBytes, bytesToBase64Url, sha256Hex } from "../src/crypto";

describe("crypto encoding", () => {
  it("round trips base64url", () => {
    const input = new Uint8Array([0, 1, 2, 250, 255]);
    expect(base64UrlToBytes(bytesToBase64Url(input))).toEqual(input);
  });

  it("hashes with sha256", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

