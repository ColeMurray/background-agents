/**
 * SQLite schema for Session Durable Objects.
 *
 * Each session gets its own SQLite database stored in the Durable Object.
 * This ensures high performance even with hundreds of concurrent sessions.
 */

export const SCHEMA_SQL = `
-- Core session state
CREATE TABLE IF NOT EXISTS session (
  id TEXT PRIMARY KEY,                              -- Same as DO ID
  session_name TEXT,                                -- External session name for WebSocket routing
  title TEXT,                                       -- Session/PR title
  repo_owner TEXT NOT NULL,                         -- e.g., "acme-corp"
  repo_name TEXT NOT NULL,                          -- e.g., "web-app"
  repo_default_branch TEXT NOT NULL DEFAULT 'main', -- Base branch for PRs
  branch_name TEXT,                                 -- Working branch (set after first commit)
  base_sha TEXT,                                    -- SHA of base branch at session start
  current_sha TEXT,                                 -- Current HEAD SHA
  opencode_session_id TEXT,                         -- OpenCode session ID (for 1:1 mapping)
  model TEXT DEFAULT 'claude-haiku-4-5',            -- LLM model to use
  status TEXT DEFAULT 'created',                    -- 'created', 'active', 'completed', 'archived'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Participants in the session
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  github_user_id TEXT,                              -- GitHub numeric ID
  github_login TEXT,                                -- GitHub username
  github_email TEXT,                                -- For git commit attribution
  github_name TEXT,                                 -- Display name for git commits
  role TEXT NOT NULL DEFAULT 'member',              -- 'owner', 'member'
  -- Token storage (AES-GCM encrypted)
  github_access_token_encrypted TEXT,
  github_refresh_token_encrypted TEXT,
  github_token_expires_at INTEGER,                  -- Unix timestamp
  -- WebSocket authentication
  ws_auth_token TEXT,                               -- SHA-256 hash of WebSocket auth token
  ws_token_created_at INTEGER,                      -- When the token was generated
  joined_at INTEGER NOT NULL
);

-- Message queue and history
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL,                             -- 'web', 'slack', 'extension', 'github'
  model TEXT,                                       -- LLM model for this specific message (per-message override)
  attachments TEXT,                                 -- JSON array
  status TEXT DEFAULT 'pending',                    -- 'pending', 'processing', 'completed', 'failed'
  error_message TEXT,                               -- If status='failed'
  created_at INTEGER NOT NULL,
  started_at INTEGER,                               -- When processing began
  completed_at INTEGER,                             -- When processing finished
  FOREIGN KEY (author_id) REFERENCES participants(id)
);

-- Agent event log (tool calls, tokens, errors)
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                               -- 'tool_call', 'tool_result', 'token', 'error', 'git_sync'
  data TEXT NOT NULL,                               -- JSON payload
  message_id TEXT,
  created_at INTEGER NOT NULL
);

-- Artifacts (PRs, screenshots, preview URLs)
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                               -- 'pr', 'screenshot', 'preview', 'branch'
  url TEXT,
  metadata TEXT,                                    -- JSON
  created_at INTEGER NOT NULL
);

-- Sandbox state
CREATE TABLE IF NOT EXISTS sandbox (
  id TEXT PRIMARY KEY,
  modal_sandbox_id TEXT,                            -- Our generated sandbox ID
  modal_object_id TEXT,                             -- Modal's internal object ID (for snapshot API)
  snapshot_id TEXT,
  snapshot_image_id TEXT,                           -- Modal Image ID for filesystem snapshot restoration
  auth_token TEXT,                                  -- Token for sandbox to authenticate back to control plane
  status TEXT DEFAULT 'pending',                    -- 'pending', 'spawning', 'connecting', 'warming', 'syncing', 'ready', 'running', 'stale', 'snapshotting', 'stopped', 'failed'
  git_sync_status TEXT DEFAULT 'pending',           -- 'pending', 'in_progress', 'completed', 'failed'
  last_heartbeat INTEGER,
  last_activity INTEGER,                            -- Last activity timestamp for inactivity-based snapshot
  created_at INTEGER NOT NULL
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author_id);
CREATE INDEX IF NOT EXISTS idx_events_message ON events(message_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(user_id);
`;

import { createLogger } from "../logger";

const schemaLog = createLogger("schema");

/**
 * Run a migration statement, only ignoring "column already exists" errors.
 * Rethrows any other errors to surface real problems.
 */
function runMigration(sql: SqlStorage, statement: string): void {
  try {
    sql.exec(statement);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // SQLite error messages for duplicate columns
    if (msg.includes("duplicate column") || msg.includes("already exists")) {
      return; // Expected for idempotent migrations
    }
    schemaLog.error("Migration failed", { statement, error: msg });
    throw e;
  }
}

/**
 * Initialize schema on a SQLite storage instance.
 */
export function initSchema(sql: SqlStorage): void {
  sql.exec(SCHEMA_SQL);

  // Migration: Add session_name column if it doesn't exist (for existing DOs)
  runMigration(sql, `ALTER TABLE session ADD COLUMN session_name TEXT`);

  // Migration: Add model column if it doesn't exist (for existing DOs)
  runMigration(sql, `ALTER TABLE session ADD COLUMN model TEXT DEFAULT 'claude-haiku-4-5'`);

  // Migration: Add model column to messages table for per-message model switching
  runMigration(sql, `ALTER TABLE messages ADD COLUMN model TEXT`);

  // Migration: Add WebSocket auth columns to participants table
  runMigration(sql, `ALTER TABLE participants ADD COLUMN ws_auth_token TEXT`);
  runMigration(sql, `ALTER TABLE participants ADD COLUMN ws_token_created_at INTEGER`);

  // Migration: Add snapshot_image_id column to sandbox table for Modal filesystem snapshots
  runMigration(sql, `ALTER TABLE sandbox ADD COLUMN snapshot_image_id TEXT`);

  // Migration: Add last_activity column to sandbox table for inactivity-based snapshot
  runMigration(sql, `ALTER TABLE sandbox ADD COLUMN last_activity INTEGER`);

  // Migration: Add modal_object_id column for Modal's internal sandbox ID
  runMigration(sql, `ALTER TABLE sandbox ADD COLUMN modal_object_id TEXT`);

  // Migration: Add ws_client_mapping table for hibernation recovery
  // This table maps WebSocket IDs to participant IDs so we can recover client identity after hibernation
  sql.exec(`
    CREATE TABLE IF NOT EXISTS ws_client_mapping (
      ws_id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL,
      client_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (participant_id) REFERENCES participants(id)
    )
  `);

  // Migration: Add circuit breaker columns to sandbox table for spawn failure tracking
  runMigration(sql, `ALTER TABLE sandbox ADD COLUMN spawn_failure_count INTEGER DEFAULT 0`);
  runMigration(sql, `ALTER TABLE sandbox ADD COLUMN last_spawn_failure INTEGER`);

  // Migration: Add callback_context column to messages table for Slack follow-up notifications
  runMigration(sql, `ALTER TABLE messages ADD COLUMN callback_context TEXT`);
}
