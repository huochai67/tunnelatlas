function validConnectingIp(value: string | null): string | null {
  if (!value) return null;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) {
    const octets = value.split(".").map(Number);
    return octets.every((octet) => octet >= 0 && octet <= 255) ? value : null;
  }
  return value.includes(":") && /^[0-9a-f:.]+$/i.test(value) ? value : null;
}

export function externallyReachableEndpoint(endpoint: string, connectingIp: string | null): string {
  const bracketed = endpoint.match(/^\[([^\]]+)]:(\d+)$/);
  const separator = endpoint.lastIndexOf(":");
  const host = bracketed?.[1] ?? (separator > 0 ? endpoint.slice(0, separator) : "");
  const port = bracketed?.[2] ?? (separator > 0 ? endpoint.slice(separator + 1) : "");
  if (!port || !["::", "0.0.0.0"].includes(host)) return endpoint;
  const publicHost = validConnectingIp(connectingIp);
  if (!publicHost) return endpoint;
  return publicHost.includes(":") ? `[${publicHost}]:${port}` : `${publicHost}:${port}`;
}
