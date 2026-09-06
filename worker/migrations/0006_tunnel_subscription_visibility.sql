ALTER TABLE tunnels ADD COLUMN subscription_enabled INTEGER NOT NULL DEFAULT 1 CHECK (subscription_enabled IN (0, 1));
