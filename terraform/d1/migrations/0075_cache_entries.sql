-- The cache table behind SqlCacheStore, the CacheStore implementation for
-- hosts that have no KV. Values are opaque strings; expires_at is epoch
-- milliseconds, NULL for an entry that never expires.
CREATE TABLE cache_entries (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
);

-- The sweep's predicate. Reads go by primary key.
CREATE INDEX idx_cache_entries_expires_at ON cache_entries(expires_at);
