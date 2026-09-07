PRAGMA foreign_keys = ON;

ALTER TABLE tunnel_configs ADD COLUMN credentials_ciphertext TEXT;

CREATE TABLE tunnel_hops (
  entry_node_id TEXT NOT NULL,
  entry_tunnel_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 0 AND position < 3),
  hop_node_id TEXT NOT NULL,
  hop_tunnel_id TEXT NOT NULL,
  PRIMARY KEY (entry_node_id, entry_tunnel_id, position),
  FOREIGN KEY (entry_node_id, entry_tunnel_id)
    REFERENCES tunnel_configs(node_id, id) ON DELETE CASCADE,
  FOREIGN KEY (hop_node_id, hop_tunnel_id)
    REFERENCES tunnel_configs(node_id, id),
  UNIQUE (entry_node_id, entry_tunnel_id, hop_node_id, hop_tunnel_id),
  CHECK (entry_node_id != hop_node_id)
);
