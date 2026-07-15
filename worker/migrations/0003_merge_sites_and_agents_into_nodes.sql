PRAGMA defer_foreign_keys = ON;

DROP TABLE tunnels;
DROP TABLE enrollment_tokens;
DROP TABLE agents;
DROP TABLE sites;

CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT,
  enrollment_generation TEXT,
  platform_json TEXT,
  labels_json TEXT NOT NULL DEFAULT '{}',
  agent_version TEXT,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  enrolled_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX nodes_name ON nodes(name);
CREATE INDEX nodes_last_seen ON nodes(last_seen_at);

CREATE TABLE enrollment_tokens (
  token_hash TEXT PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX enrollment_tokens_node ON enrollment_tokens(node_id);

CREATE TABLE tunnels (
  id TEXT NOT NULL,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  protocol TEXT NOT NULL,
  status TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  authentication_ciphertext TEXT,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (node_id, id)
);

CREATE INDEX tunnels_node_status ON tunnels(node_id, status);
CREATE INDEX tunnels_last_seen ON tunnels(last_seen_at);
