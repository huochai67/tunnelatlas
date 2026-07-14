export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  ADMIN_TOKEN: string;
  READ_TOKEN: string;
  ENROLLMENT_PEPPER: string;
  AGENT_OFFLINE_SECONDS?: string;
}

export interface EnrollmentBody {
  name: string;
  siteId: string;
  publicKey: string;
  platform: { os: string; arch: string; agentVersion: string };
  labels?: Record<string, string>;
}

export interface ReportBody {
  agentVersion: string;
  labels?: Record<string, string>;
  tunnels: TunnelBody[];
}

export interface TunnelBody {
  id: string;
  name: string;
  kind: string;
  endpoint: string;
  protocol: string;
  status: "healthy" | "degraded" | "failed" | "unknown" | "stopped";
  metadata?: unknown;
}

export interface AgentRow {
  id: string;
  site_id: string;
  public_key: string;
  last_sequence: number;
  revoked_at: string | null;
}
