PRAGMA foreign_keys = ON;

CREATE TABLE sites (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE enrollment_tokens (
  token_hash TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL,
  platform_json TEXT NOT NULL,
  labels_json TEXT NOT NULL DEFAULT '{}',
  agent_version TEXT,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE UNIQUE INDEX agents_site_name ON agents(site_id, name);
CREATE INDEX agents_last_seen ON agents(last_seen_at);

CREATE TABLE tunnels (
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  protocol TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, id)
);

CREATE INDEX tunnels_site_status ON tunnels(site_id, status);
CREATE INDEX tunnels_last_seen ON tunnels(last_seen_at);

