-- Durable provider state used when Slack, Linear, and GitHub are hosted in
-- the control-plane process. Namespaced keys preserve each provider's current
-- KV contract while the Node host keeps credentials, preferences, and session
-- mappings in its replicated global database.

CREATE TABLE integration_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
);

CREATE INDEX idx_integration_kv_expiry
  ON integration_kv (expires_at)
  WHERE expires_at IS NOT NULL;
