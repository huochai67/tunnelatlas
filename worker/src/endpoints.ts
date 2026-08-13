export function observedAddress(value: string | null): string | null {
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
  const publicHost = observedAddress(connectingIp);
  if (!publicHost) return endpoint;
  return publicHost.includes(":") ? `[${publicHost}]:${port}` : `${publicHost}:${port}`;
}

export interface OriginEndpoint {
  host: string;
  port: number;
  recordType: "A" | "AAAA" | "CNAME";
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function ipv4Octets(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
  return octets.some((octet) => octet < 0 || octet > 255) ? null : octets;
}

function privateIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function ipv6Groups(value: string): number[] | null {
  const compressed = value.split("::");
  if (compressed.length > 2 || value.endsWith(":") && compressed.length === 1 || value.startsWith(":") && compressed.length === 1) {
    return null;
  }
  const left = compressed[0] === "" ? [] : compressed[0].split(":");
  const right = compressed.length === 2 && compressed[1] !== "" ? compressed[1].split(":") : [];
  const parsePart = (part: string): number | null => (/^[0-9a-f]{1,4}$/i.test(part) ? parseInt(part, 16) : null);
  const leftGroups: number[] = [];
  const rightGroups: number[] = [];
  for (const part of left) {
    const parsed = parsePart(part);
    if (parsed === null) return null;
    leftGroups.push(parsed);
  }
  for (const part of right) {
    const parsed = parsePart(part);
    if (parsed === null) return null;
    rightGroups.push(parsed);
  }
  if (compressed.length === 2) {
    if (leftGroups.length + rightGroups.length >= 8) return null;
  } else if (leftGroups.length !== 8) {
    return null;
  }
  const missing = 8 - leftGroups.length - rightGroups.length;
  return [...leftGroups, ...new Array<number>(missing).fill(0), ...rightGroups];
}

function privateIpv6(groups: number[]): boolean {
  if (groups.every((group) => group === 0)) return true;
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return true;
  const first = groups[0];
  return (first & 0xfe00) === 0xfc00 // unique local
    || (first & 0xffc0) === 0xfe80 // link local
    || (first & 0xff00) === 0xff00; // multicast
}

export function parseOriginEndpoint(value: string): OriginEndpoint | null {
  const bracketed = value.match(/^\[([^\]]+)]:(\d+)$/);
  const separator = value.lastIndexOf(":");
  const host = bracketed?.[1] ?? (separator > 0 ? value.slice(0, separator) : null);
  const portText = bracketed?.[2] ?? (separator > 0 ? value.slice(separator + 1) : null);
  if (!host || !portText) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (host.includes(":")) {
    const groups = ipv6Groups(host);
    if (!groups || privateIpv6(groups)) return null;
    return { host, port, recordType: "AAAA" };
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    const octets = ipv4Octets(host);
    if (!octets || privateIpv4(octets)) return null;
    return { host, port, recordType: "A" };
  }
  if (!HOSTNAME.test(host)) return null;
  return { host, port, recordType: "CNAME" };
}

export function validWebSocketPath(value: string): boolean {
  return value.length > 0 && value.length <= 2048
    && value.startsWith("/") && !/[\x00-\x20"\\#?]/.test(value);
}

export function validFrontendAddress(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (parseOriginEndpoint(`${trimmed}:443`) !== null) return true;
  // A dotted quad that failed the origin parser is private or malformed; the
  // hostname grammar would otherwise accept it as label characters.
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed)) return false;
  return HOSTNAME.test(trimmed);
}
