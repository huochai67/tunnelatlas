export function stripBrackets(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function formatHostPort(host: string, port: number): string {
  const bare = stripBrackets(host);
  return bare.includes(":") ? `[${bare}]:${port}` : `${bare}:${port}`;
}

export function ipFamily(value: string | null | undefined): "ipv4" | "ipv6" | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const bare = stripBrackets(trimmed);
  if (bare.includes(":")) {
    return ipv6Groups(bare) !== null ? "ipv6" : null;
  }
  if (trimmed.startsWith("[") || trimmed.endsWith("]")) return null;
  return ipv4Octets(bare) !== null ? "ipv4" : null;
}

export function observedIpv4(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return ipv4Octets(trimmed) !== null ? trimmed : null;
}

export function observedIpv6(value: string | null | undefined): string | null {
  if (!value) return null;
  const bare = stripBrackets(value);
  return bare.includes(":") && ipv6Groups(bare) !== null ? bare : null;
}

export function observedAddress(value: string | null | undefined): string | null {
  if (!value) return null;
  return observedIpv4(value) ?? observedIpv6(value);
}

export function listenSupportsIpv4(listen: string | null | undefined): boolean {
  const bare = stripBrackets(listen ?? "::");
  if (!bare || bare === "::" || bare === "0.0.0.0") return true;
  return ipv4Octets(bare) !== null;
}

export function listenSupportsIpv6(listen: string | null | undefined): boolean {
  const bare = stripBrackets(listen ?? "::");
  if (!bare || bare === "::") return true;
  return bare.includes(":") && ipv6Groups(bare) !== null;
}

export function externallyReachableEndpoint(
  endpoint: string,
  connectingIp: string | null,
  preferredIpv4?: string | null,
  preferredIpv6?: string | null,
): string {
  const bracketed = endpoint.match(/^\[([^\]]+)]:(\d+)$/);
  const separator = endpoint.lastIndexOf(":");
  const host = bracketed?.[1] ?? (separator > 0 ? endpoint.slice(0, separator) : "");
  const port = bracketed?.[2] ?? (separator > 0 ? endpoint.slice(separator + 1) : "");
  if (!port || !["::", "0.0.0.0"].includes(host)) return endpoint;
  const publicHost = host === "0.0.0.0"
    ? (observedIpv4(preferredIpv4) ?? observedIpv4(connectingIp))
    : (observedIpv4(preferredIpv4) ?? observedAddress(connectingIp) ?? observedIpv6(preferredIpv6));
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
  const parseSection = (parts: string[], allowIpv4Tail: boolean): number[] | null => {
    const groups: number[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (allowIpv4Tail && index === parts.length - 1 && part.includes(".")) {
        const octets = ipv4Octets(part);
        if (!octets) return null;
        groups.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
        groups.push(parseInt(part, 16));
      } else {
        return null;
      }
    }
    return groups;
  };
  const left = compressed[0] === "" ? [] : compressed[0].split(":");
  const right = compressed.length === 2 && compressed[1] !== "" ? compressed[1].split(":") : [];
  const leftGroups = parseSection(left, compressed.length === 1);
  if (!leftGroups) return null;
  const rightGroups = parseSection(right, compressed.length === 2);
  if (!rightGroups) return null;
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
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return privateIpv4([
      groups[6] >> 8,
      groups[6] & 0xff,
      groups[7] >> 8,
      groups[7] & 0xff,
    ]);
  }
  const first = groups[0];
  return (first & 0xfe00) === 0xfc00 // unique local
    || (first & 0xffc0) === 0xfe80 // link local
    || (first & 0xff00) === 0xff00; // multicast
}

export function isPublicIpv4(value: string): boolean {
  const trimmed = value.trim();
  const octets = ipv4Octets(trimmed);
  return octets !== null && !privateIpv4(octets);
}

export function isPublicIpv6(value: string): boolean {
  const bare = stripBrackets(value);
  if (!bare.includes(":")) return false;
  const groups = ipv6Groups(bare);
  return groups !== null && !privateIpv6(groups);
}

export function normalizePublicIpv6(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if ((trimmed.startsWith("[") && !trimmed.endsWith("]")) || (!trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return null;
  }
  const bare = stripBrackets(trimmed);
  return isPublicIpv6(bare) ? bare : null;
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

export function validServerName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /^\d+(?:\.\d+){0,3}$/.test(trimmed)) return false;
  return HOSTNAME.test(trimmed);
}

export function normalizeFrontendAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("[") || trimmed.endsWith("]")) {
    return normalizePublicIpv6(trimmed);
  }
  if (trimmed.includes(":")) {
    return isPublicIpv6(trimmed) ? trimmed : null;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(trimmed)) {
    return isPublicIpv4(trimmed) ? trimmed : null;
  }
  return HOSTNAME.test(trimmed) ? trimmed : null;
}

export function validFrontendAddress(value: string): boolean {
  return normalizeFrontendAddress(value) !== null;
}

export function validIpAddress(value: string): boolean {
  let trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    trimmed = trimmed.slice(1, -1);
  }
  if (!trimmed) return false;
  if (trimmed.includes(":")) {
    return ipv6Groups(trimmed) !== null;
  }
  return ipv4Octets(trimmed) !== null;
}
