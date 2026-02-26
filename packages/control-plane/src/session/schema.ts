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
  repo_id INTEGER,                                  -- GitHub repository ID (stable)
  base_branch TEXT NOT NULL DEFAULT 'main',          -- Base branch for PRs
  branch_name TEXT,                                 -- Working branch (set after first commit)
  base_sha TEXT,                                    -- SHA of base branch at session start
  current_sha TEXT,                                 -- Current HEAD SHA
  opencode_session_id TEXT,                         -- OpenCode session ID (for 1:1 mapping)
  model TEXT DEFAULT 'anthropic/claude-haiku-4-5',   -- LLM model to use
  reasoning_effort TEXT,                            -- Session-level reasoning effort default
  status TEXT DEFAULT 'created',                    -- 'created', 'active', 'completed', 'archived'
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Participants in the session
CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scm_user_id TEXT,                                 -- SCM numeric ID
  scm_login TEXT,                                   -- SCM username
  scm_email TEXT,                                   -- For git commit attribution
  scm_name TEXT,                                    -- Display name for git commits
  role TEXT NOT NULL DEFAULT 'member',              -- 'owner', 'member'
  -- Token storage (AES-GCM encrypted)
  scm_access_token_encrypted TEXT,
  scm_refresh_token_encrypted TEXT,
  scm_token_expires_at INTEGER,                     -- Unix timestamp
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
  reasoning_effort TEXT,                            -- Per-message reasoning effort override
  attachments TEXT,                                 -- JSON array
  callback_context TEXT,                            -- JSON callback context for Slack follow-up notifications
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
  auth_token_hash TEXT,                             -- SHA-256 hash of sandbox auth token (preferred)
  status TEXT DEFAULT 'pending',                    -- 'pending', 'spawning', 'connecting', 'warming', 'syncing', 'ready', 'running', 'stale', 'snapshotting', 'stopped', 'failed'
  git_sync_status TEXT DEFAULT 'pending',           -- 'pending', 'in_progress', 'completed', 'failed'
  last_heartbeat INTEGER,
  last_activity INTEGER,                            -- Last activity timestamp for inactivity-based snapshot
  last_spawn_error TEXT,                            -- Last sandbox spawn error (if any)
  last_spawn_error_at INTEGER,                      -- Timestamp of last spawn error
  spawn_failure_count INTEGER DEFAULT 0,            -- Circuit breaker: consecutive spawn failures
  last_spawn_failure INTEGER,                       -- Timestamp of last spawn failure
  created_at INTEGER NOT NULL
);

-- WebSocket client mapping for hibernation recovery
CREATE TABLE IF NOT EXISTS ws_client_mapping (
  ws_id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL,
  client_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (participant_id) REFERENCES participants(id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author_id);
CREATE INDEX IF NOT EXISTS idx_events_message ON events(message_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at, id);
CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(user_id);
`;

import { createLogger } from "../logger";
import type { SqlStorage } from "./repository";

const schemaLog = createLogger("schema");

/**
 * A numbered, tracked migration.
 *
 * - `string` runs are ALTER TABLE statements processed through runMigration()
 *   (errors for "duplicate column" / "already exists" are swallowed).
 * - `function` runs execute directly and must be written idempotently,
 *   since they may re-run if the process crashes between execution and recording.
 */
export interface SchemaMigration {
  readonly id: number;
  readonly description: string;
  readonly run: string | ((sql: SqlStorage) => void);
}

/**
 * Ordered list of all schema migrations.
 *
 * To add a new migration:
 * 1. Add the column/table to SCHEMA_SQL above (so new DOs get the full schema)
 * 2. Append an entry here with the next sequential ID
 * 3. For data transforms, use a function-type `run`
 */
export const MIGRATIONS: readonly SchemaMigration[] = [
  {
    id: 1,
    description: "Add session_name to session",
    run: `ALTER TABLE session ADD COLUMN session_name TEXT`,
  },
  {
    id: 2,
    description: "Add repo_id to session",
    run: `ALTER TABLE session ADD COLUMN repo_id INTEGER`,
  },
  {
    id: 3,
    description: "Add model to session",
    run: `ALTER TABLE session ADD COLUMN model TEXT DEFAULT 'anthropic/claude-haiku-4-5'`,
  },
  {
    id: 4,
    description: "Add model to messages",
    run: `ALTER TABLE messages ADD COLUMN model TEXT`,
  },
  {
    id: 5,
    description: "Add ws_auth_token to participants",
    run: `ALTER TABLE participants ADD COLUMN ws_auth_token TEXT`,
  },
  {
    id: 6,
    description: "Add ws_token_created_at to participants",
    run: `ALTER TABLE participants ADD COLUMN ws_token_created_at INTEGER`,
  },
  {
    id: 7,
    description: "Add refresh_token_encrypted to participants",
    run: (sql) => {
      const columns = sql.exec("PRAGMA table_info(participants)").toArray() as Array<{
        name: string;
      }>;
      const names = new Set(columns.map((c) => c.name));
      // Fresh DOs (post-rename) already have scm_refresh_token_encrypted from SCHEMA_SQL.
      // Only add the old column name on pre-rename DOs that need migration 20 to rename it.
      if (
        !names.has("github_refresh_token_encrypted") &&
        !names.has("scm_refresh_token_encrypted")
      ) {
        sql.exec("ALTER TABLE participants ADD COLUMN scm_refresh_token_encrypted TEXT");
      }
    },
  },
  {
    id: 8,
    description: "Add snapshot_image_id to sandbox",
    run: `ALTER TABLE sandbox ADD COLUMN snapshot_image_id TEXT`,
  },
  {
    id: 9,
    description: "Add last_activity to sandbox",
    run: `ALTER TABLE sandbox ADD COLUMN last_activity INTEGER`,
  },
  {
    id: 10,
    description: "Add last_spawn_error to sandbox",
    run: `ALTER TABLE sandbox ADD COLUMN last_spawn_error TEXT`,
  },
  {
    id: 11,
    description: "Add last_spawn_error_at to sandbox",
    run: `ALTER TABLE sandbox ADD COLUMN last_spawn_error_at INTEGER`,
  },
  {
    id: 12,
    description: "Add modal_object_id to sandbox",
    run: `ALTER TABLE sandbox ADD COLUMN modal_object_id TEXT`,
  },
  {
    id: 13,
    description: "Create ws_client_mapping table",
    run: (sql) => {
      sql.exec(`
        CREATE TABLE IF NOT EXISTS ws_client_mapping (
          ws_id TEXT PRIMARY KEY,
          participant_id TEXT NOT NULL,
          client_id TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (participant_id) REFERENCES participants(id)
        )
      `);
    },
  },
  {
    id: 14,
    description: "Add spawn_failure_count to sandbox",
    run: `ALTER TABLE sandbox ADD COLUMN spawn_failure_count INTEGER DEFAULT 0`,
  },
  {
    id: 15,
    description: "Add last_spawn_failure to sandbox",
    run: `ALTER TABLE sandbox ADD COLUMN last_spawn_failure INTEGER`,
  },
  {
    id: 16,
    description: "Add callback_context to messages",
    run: `ALTER TABLE messages ADD COLUMN callback_context TEXT`,
  },
  {
    id: 17,
    description: "Add reasoning_effort to session",
    run: `ALTER TABLE session ADD COLUMN reasoning_effort TEXT`,
  },
  {
    id: 18,
    description: "Add reasoning_effort to messages",
    run: `ALTER TABLE messages ADD COLUMN reasoning_effort TEXT`,
  },
  {
    id: 19,
    description: "Add auth_token_hash to sandbox",
    run: `ALTER TABLE sandbox ADD COLUMN auth_token_hash TEXT`,
  },
  {
    id: 20,
    description: "Rename github_* columns to scm_* in participants",
    run: (sql) => {
      const columns = sql.exec("PRAGMA table_info(participants)").toArray() as Array<{
        name: string;
      }>;
      const columnNames = new Set(columns.map((c) => c.name));

      const renames: [string, string][] = [
        ["github_user_id", "scm_user_id"],
        ["github_login", "scm_login"],
        ["github_email", "scm_email"],
        ["github_name", "scm_name"],
        ["github_access_token_encrypted", "scm_access_token_encrypted"],
        ["github_refresh_token_encrypted", "scm_refresh_token_encrypted"],
        ["github_token_expires_at", "scm_token_expires_at"],
      ];
      for (const [oldCol, newCol] of renames) {
        if (columnNames.has(oldCol) && !columnNames.has(newCol)) {
          sql.exec(`ALTER TABLE participants RENAME COLUMN ${oldCol} TO ${newCol}`);
        }
      }
    },
  },
  {
    id: 21,
    description: "Add scm_provider to participants",
    run: `ALTER TABLE participants ADD COLUMN scm_provider TEXT NOT NULL DEFAULT 'github'`,
  },
  {
    id: 22,
    description: "Add scm_provider to session",
    run: `ALTER TABLE session ADD COLUMN scm_provider TEXT NOT NULL DEFAULT 'github'`,
  },
  {
    id: 23,
    description: "Drop scm_provider from session and participants (now deployment-level)",
    run: (sql) => {
      for (const table of ["session", "participants"] as const) {
        const columns = sql.exec(`PRAGMA table_info(${table})`).toArray() as Array<{
          name: string;
        }>;
        if (columns.some((c) => c.name === "scm_provider")) {
          sql.exec(`ALTER TABLE ${table} DROP COLUMN scm_provider`);
        }
      }
    },
  },
  {
    id: 24,
    description: "Rename repo_default_branch to base_branch in session",
    run: (sql) => {
      const columns = sql.exec("PRAGMA table_info(session)").toArray() as Array<{
        name: string;
      }>;
      const columnNames = new Set(columns.map((c) => c.name));
      if (columnNames.has("repo_default_branch") && !columnNames.has("base_branch")) {
        sql.exec(`ALTER TABLE session RENAME COLUMN repo_default_branch TO base_branch`);
      }
    },
  },
];

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
 * Apply pending migrations, tracking which have already run via _schema_migrations.
 */
export function applyMigrations(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS _schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`
  );

  const rows = sql.exec(`SELECT id FROM _schema_migrations`).toArray() as Array<{ id: number }>;
  const applied = new Set(rows.map((r) => r.id));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    if (typeof migration.run === "string") {
      runMigration(sql, migration.run);
    } else {
      migration.run(sql);
    }

    sql.exec(
      `INSERT OR IGNORE INTO _schema_migrations (id, applied_at) VALUES (?, ?)`,
      migration.id,
      Date.now()
    );
  }
}

/**
 * Initialize schema on a SQLite storage instance.
 */
export function initSchema(sql: SqlStorage): void {
  sql.exec(SCHEMA_SQL);
  applyMigrations(sql);
}
