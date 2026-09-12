-- Activity timestamps do not order lifecycle transitions. Existing projections
-- start below the authoritative session's first revision and are refreshed lazily.
ALTER TABLE sessions ADD COLUMN status_revision INTEGER NOT NULL DEFAULT 0;
