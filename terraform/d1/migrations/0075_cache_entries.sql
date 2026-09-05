-- The cache table behind SqlCacheStore, the CacheStore implementation for
-- hosts that have no KV. Values are opaque strings; expires_at is epoch
-- milliseconds, NULL for an entry that never expires.
--
-- No index on expires_at: every read goes by primary key, and expiry is lazy
-- on read rather than swept, so nothing queries the column.
CREATE TABLE cache_entries (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
);
