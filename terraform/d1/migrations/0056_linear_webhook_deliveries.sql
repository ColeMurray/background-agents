CREATE TABLE linear_webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('processing', 'processed', 'failed')),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  progress TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_linear_webhook_deliveries_updated_at
  ON linear_webhook_deliveries(updated_at);

CREATE TABLE session_creation_idempotency (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('initializing', 'succeeded', 'failed')),
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
