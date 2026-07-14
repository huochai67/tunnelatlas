import { base64UrlToBytes } from "./crypto";
import { HttpError } from "./http";
import type { EnrollmentBody, ReportBody, TunnelBody } from "./types";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STATUS = new Set(["healthy", "degraded", "failed", "unknown", "stopped"]);
const AUTH_FIELDS = new Set(["name", "username", "password", "uuid", "flow", "token"]);

function text(value: unknown, name: string, max = 255): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new HttpError(400, `Invalid ${name}`);
}

export function validateEnrollment(body: EnrollmentBody): void {
  text(body.name, "name");
  text(body.siteId, "siteId", 128);
  if (!ID.test(body.siteId)) throw new HttpError(400, "Invalid siteId");
  text(body.publicKey, "publicKey", 128);
  try {
    if (base64UrlToBytes(body.publicKey).byteLength !== 32) throw new Error("wrong length");
  } catch {
    throw new HttpError(400, "publicKey must be an Ed25519 public key");
  }
  if (!body.platform || typeof body.platform !== "object") throw new HttpError(400, "Invalid platform");
  text(body.platform.os, "platform.os", 64);
  text(body.platform.arch, "platform.arch", 64);
  text(body.platform.agentVersion, "platform.agentVersion", 64);
}

function validateTunnel(tunnel: TunnelBody): void {
  text(tunnel.id, "tunnel.id", 128);
  text(tunnel.name, "tunnel.name");
  text(tunnel.kind, "tunnel.kind", 64);
  text(tunnel.endpoint, "tunnel.endpoint", 2048);
  text(tunnel.protocol, "tunnel.protocol", 32);
  if (!STATUS.has(tunnel.status)) throw new HttpError(400, "Invalid tunnel.status");
  validateAuthentication(tunnel.authentication);
}

function validateAuthentication(value: unknown): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "Invalid tunnel.authentication");
  const authentication = value as Record<string, unknown>;
  for (const [key, field] of Object.entries(authentication)) {
    if (["method", "password", "token"].includes(key)) {
      text(field, `tunnel.authentication.${key}`, 1024);
      continue;
    }
    if (key !== "users" || !Array.isArray(field) || field.length > 32) throw new HttpError(400, "Invalid tunnel.authentication field");
    for (const user of field) {
      if (!user || typeof user !== "object" || Array.isArray(user)) throw new HttpError(400, "Invalid tunnel.authentication.users");
      const entries = Object.entries(user as Record<string, unknown>);
      if (entries.length === 0) throw new HttpError(400, "Empty tunnel authentication user");
      for (const [userKey, userValue] of entries) {
        if (!AUTH_FIELDS.has(userKey)) throw new HttpError(400, "Invalid tunnel authentication user field");
        text(userValue, `tunnel.authentication.users.${userKey}`, 1024);
      }
    }
  }
  if (JSON.stringify(value).length > 16 * 1024) throw new HttpError(400, "Tunnel authentication is too large");
}

export function validateReport(body: ReportBody): void {
  text(body.agentVersion, "agentVersion", 64);
  if (!Array.isArray(body.tunnels) || body.tunnels.length > 64) throw new HttpError(400, "tunnels must contain at most 64 entries");
  const ids = new Set<string>();
  for (const tunnel of body.tunnels) {
    validateTunnel(tunnel);
    if (ids.has(tunnel.id)) throw new HttpError(400, "Duplicate tunnel.id");
    ids.add(tunnel.id);
  }
}
