PRAGMA foreign_keys = ON;

ALTER TABLE nodes ADD COLUMN config_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE nodes ADD COLUMN applied_config_version INTEGER;
ALTER TABLE nodes ADD COLUMN config_apply_error TEXT;

CREATE TABLE tunnel_configs (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('shadowsocks', 'hysteria2', 'tuic', 'vless-reality', 'anytls-reality', 'vmess-ws')),
  listen TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port >= 1 AND port <= 65535),
  public_host TEXT,
  options_json TEXT NOT NULL DEFAULT '{}',
  credential_generation INTEGER NOT NULL DEFAULT 1,
  subscription_enabled INTEGER NOT NULL DEFAULT 1 CHECK (subscription_enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (node_id, id),
  UNIQUE (node_id, name),
  UNIQUE (node_id, port)
);
