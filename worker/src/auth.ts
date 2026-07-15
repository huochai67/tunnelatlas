import { sha256Hex, verifyEd25519 } from "./crypto";
import { HttpError } from "./http";
import type { AgentRow, Env } from "./types";

export interface AuthenticatedAgent extends AgentRow {
  sequence: number;
}

export async function authenticateAgent(request: Request, env: Env, body: ArrayBuffer): Promise<AuthenticatedAgent> {
  const agentId = request.headers.get("X-Agent-ID");
  const timestamp = request.headers.get("X-Timestamp");
  const sequenceText = request.headers.get("X-Sequence");
  const contentHash = request.headers.get("X-Content-SHA256");
  const signature = request.headers.get("X-Signature");
  if (!agentId || !timestamp || !sequenceText || !contentHash || !signature) {
    throw new HttpError(401, "Missing device signature headers");
  }
  const sequence = Number(sequenceText);
  if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new HttpError(401, "Invalid sequence");
  const sentAt = Date.parse(timestamp);
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > 5 * 60_000) {
    throw new HttpError(401, "Request timestamp outside allowed window");
  }
  const actualHash = await sha256Hex(body);
  if (actualHash !== contentHash.toLowerCase()) throw new HttpError(401, "Body hash mismatch");

  const agent = await env.DB.prepare(
    "SELECT id, public_key, last_sequence FROM nodes WHERE id = ? AND public_key IS NOT NULL",
  ).bind(agentId).first<AgentRow>();
  if (!agent) throw new HttpError(401, "Unknown or reset agent");
  if (sequence <= agent.last_sequence) throw new HttpError(409, "Sequence has already been used");

  const url = new URL(request.url);
  const canonical = `${request.method}\n${url.pathname}\n${timestamp}\n${sequence}\n${actualHash}`;
  if (!(await verifyEd25519(agent.public_key, signature, canonical))) {
    throw new HttpError(401, "Invalid device signature");
  }
  return { ...agent, sequence };
}
