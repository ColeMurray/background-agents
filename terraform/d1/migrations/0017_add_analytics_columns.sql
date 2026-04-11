-- Analytics columns for usage dashboard (forward-looking, no backfill)
ALTER TABLE sessions ADD COLUMN scm_login TEXT;
ALTER TABLE sessions ADD COLUMN total_cost REAL NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN active_duration_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN pr_count INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_sessions_scm_login ON sessions(scm_login, created_at DESC);
CREATE INDEX idx_sessions_created_at ON sessions(created_at DESC);
