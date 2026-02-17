CREATE TABLE IF NOT EXISTS model_preferences (
  id TEXT PRIMARY KEY DEFAULT 'global',
  enabled_models TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
