import { describe, expect, it } from "vitest";
import { externallyReachableEndpoint, observedAddress, parseOriginEndpoint, validWebSocketPath } from "../src/endpoints";

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

  it("preserves explicit custom endpoints even when the connecting IP differs", () => {
    expect(externallyReachableEndpoint("proxy.example.com:443", "198.51.100.9")).toBe("proxy.example.com:443");
    expect(externallyReachableEndpoint("203.0.113.8:443", "198.51.100.9")).toBe("203.0.113.8:443");
    expect(externallyReachableEndpoint("[2001:db8::8]:443", "198.51.100.9")).toBe("[2001:db8::8]:443");
  });

  it("returns only validated report source addresses", () => {
    expect(observedAddress("203.0.113.8")).toBe("203.0.113.8");
    expect(observedAddress("2001:db8::8")).toBe("2001:db8::8");
    expect(observedAddress("not-an-ip")).toBeNull();
  });
});

describe("origin endpoint parsing", () => {
  it("selects A, AAAA, or CNAME record types", () => {
    expect(parseOriginEndpoint("203.0.113.8:10086")).toEqual({ host: "203.0.113.8", port: 10086, recordType: "A" });
    expect(parseOriginEndpoint("[2001:db8::8]:10086")).toEqual({ host: "2001:db8::8", port: 10086, recordType: "AAAA" });
    expect(parseOriginEndpoint("proxy.example.com:443")).toEqual({ host: "proxy.example.com", port: 443, recordType: "CNAME" });
    expect(parseOriginEndpoint("proxy.example.com:1")).toEqual({ host: "proxy.example.com", port: 1, recordType: "CNAME" });
    expect(parseOriginEndpoint("[2001:db8::8]:65535")).toEqual({ host: "2001:db8::8", port: 65535, recordType: "AAAA" });
  });

  it("rejects wildcard, private, loopback, and invalid origins", () => {
    expect(parseOriginEndpoint("[::]:443")).toBeNull();
    expect(parseOriginEndpoint("0.0.0.0:8388")).toBeNull();
    expect(parseOriginEndpoint("10.0.0.5:8388")).toBeNull();
    expect(parseOriginEndpoint("172.16.0.5:8388")).toBeNull();
    expect(parseOriginEndpoint("192.168.1.5:8388")).toBeNull();
    expect(parseOriginEndpoint("127.0.0.1:8388")).toBeNull();
    expect(parseOriginEndpoint("169.254.1.1:8388")).toBeNull();
    expect(parseOriginEndpoint("100.64.0.1:8388")).toBeNull();
    expect(parseOriginEndpoint("224.0.0.1:8388")).toBeNull();
    expect(parseOriginEndpoint("255.255.255.255:8388")).toBeNull();
    expect(parseOriginEndpoint("[::1]:8388")).toBeNull();
    expect(parseOriginEndpoint("[fc00::1]:8388")).toBeNull();
    expect(parseOriginEndpoint("[fe80::1]:8388")).toBeNull();
    expect(parseOriginEndpoint("[ff02::1]:8388")).toBeNull();
    expect(parseOriginEndpoint("proxy.example.com:0")).toBeNull();
    expect(parseOriginEndpoint("proxy.example.com:70000")).toBeNull();
    expect(parseOriginEndpoint("proxy.example.com")).toBeNull();
    expect(parseOriginEndpoint("*.example.com:443")).toBeNull();
    expect(parseOriginEndpoint("exa mple.com:443")).toBeNull();
    expect(parseOriginEndpoint("not valid:443")).toBeNull();
    expect(parseOriginEndpoint(":443")).toBeNull();
    expect(parseOriginEndpoint("")).toBeNull();
    expect(parseOriginEndpoint("[2001:db8::1:2:3:4:5:6]:443")).toBeNull();
    expect(parseOriginEndpoint("[gggg::1]:443")).toBeNull();
  });

  it("accepts public documentation ranges and edge port numbers", () => {
    expect(parseOriginEndpoint("203.0.113.8:443")?.recordType).toBe("A");
    expect(parseOriginEndpoint("2001:db8::8:443")?.port).toBe(443);
    expect(parseOriginEndpoint("2001:db8::8:443")?.host).toBe("2001:db8::8");
  });

  it("validates WebSocket paths", () => {
    expect(validWebSocketPath("/vmess")).toBe(true);
    expect(validWebSocketPath("/")).toBe(true);
    expect(validWebSocketPath("/a/b-c_~.d")).toBe(true);
    expect(validWebSocketPath("")).toBe(false);
    expect(validWebSocketPath("vmess")).toBe(false);
    expect(validWebSocketPath("/a b")).toBe(false);
    expect(validWebSocketPath("/a\"b")).toBe(false);
    expect(validWebSocketPath("/a?b")).toBe(false);
    expect(validWebSocketPath("/a#b")).toBe(false);
    expect(validWebSocketPath("/a\\b")).toBe(false);
    expect(validWebSocketPath(`/${"a".repeat(2049)}`)).toBe(false);
  });
});
