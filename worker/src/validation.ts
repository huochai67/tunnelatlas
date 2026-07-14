import { base64UrlToBytes } from "./crypto";
import { HttpError } from "./http";
import type { EnrollmentBody, ReportBody, TunnelBody } from "./types";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STATUS = new Set(["healthy", "degraded", "failed", "unknown", "stopped"]);

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
