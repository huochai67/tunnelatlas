PRAGMA foreign_keys = ON;

ALTER TABLE nodes ADD COLUMN observed_ipv4 TEXT;
ALTER TABLE nodes ADD COLUMN observed_ipv6 TEXT;

ALTER TABLE tunnel_configs ADD COLUMN public_ipv6 TEXT;
ALTER TABLE tunnel_configs ADD COLUMN subscription_ip_mode TEXT NOT NULL DEFAULT 'auto'
  CHECK (subscription_ip_mode IN ('auto', 'ipv4', 'ipv6', 'dual'));
