PRAGMA foreign_keys = ON;

CREATE TABLE tunnel_cloudflare_frontends (
  node_id TEXT NOT NULL,
  tunnel_id TEXT NOT NULL,
  hostname TEXT NOT NULL UNIQUE,
  zone_id TEXT NOT NULL,
  zone_name TEXT NOT NULL,
  status TEXT NOT NULL,
  operation_id TEXT,
  dns_record_id TEXT,
  config_ruleset_id TEXT,
  config_rule_id TEXT,
  origin_ruleset_id TEXT,
  origin_rule_id TEXT,
  source_endpoint TEXT NOT NULL,
  source_path TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (node_id, tunnel_id),
  FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE RESTRICT
);

CREATE INDEX tunnel_cloudflare_frontends_status ON tunnel_cloudflare_frontends(status);
