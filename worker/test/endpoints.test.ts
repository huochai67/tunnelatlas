import { describe, expect, it } from "vitest";
import { externallyReachableEndpoint } from "../src/endpoints";

describe("externally reachable endpoints", () => {
  it("replaces wildcard listeners with the reporting agent public IPv4 address", () => {
    expect(externallyReachableEndpoint("[::]:443", "203.0.113.8")).toBe("203.0.113.8:443");
    expect(externallyReachableEndpoint("0.0.0.0:8388", "203.0.113.8")).toBe("203.0.113.8:8388");
  });

  it("brackets public IPv6 addresses", () => {
    expect(externallyReachableEndpoint("[::]:443", "2001:db8::8")).toBe("[2001:db8::8]:443");
  });

  it("preserves explicit hosts and ignores invalid connecting addresses", () => {
    expect(externallyReachableEndpoint("proxy.example.com:443", "203.0.113.8")).toBe("proxy.example.com:443");
    expect(externallyReachableEndpoint("[::]:443", "not-an-ip")).toBe("[::]:443");
  });
});
