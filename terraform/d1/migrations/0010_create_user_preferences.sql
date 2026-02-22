-- User-scoped UI preferences.
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id    TEXT PRIMARY KEY,
  theme      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
