CREATE TABLE keyboard_shortcut_preferences (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shortcuts TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
