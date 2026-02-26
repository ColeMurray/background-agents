/**
 * Database layer using better-sqlite3.
 *
 * Single SQLite file stores all sessions, events, messages, artifacts,
 * and settings. Replaces both Cloudflare D1 (global index) and the
 * per-session Durable Object SQLite databases.
 */

import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

let db: Database.Database;

/**
 * Get or create the database connection.
 */
export function getDb(): Database.Database {
  if (db) return db;

  const dataDir =
    process.env.DATA_DIR || path.join(os.homedir(), ".local", "share", "background-agents");
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, "data.sqlite");
  db = new Database(dbPath);

  // Performance pragmas
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  initSchema(db);
  return db;
}

/**
 * Schema for the local server.
 * Merged from the original D1 session index + per-session DO SQLite.
 */
function initSchema(db: Database.Database): void {
  db.exec(`
    -- Session index (replaces D1 sessions table + DO session table)
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT,
      repo_path TEXT NOT NULL,                          -- Local filesystem path to the repo
      repo_name TEXT NOT NULL,                          -- Display name (basename of repo_path)
      base_branch TEXT NOT NULL DEFAULT 'main',
      branch_name TEXT,
      model TEXT DEFAULT 'anthropic/claude-sonnet-4-6',
      reasoning_effort TEXT,
      status TEXT DEFAULT 'created',                    -- created, active, completed, archived
      sandbox_status TEXT DEFAULT 'pending',            -- pending, spawning, ready, running, stopped, failed
      container_id TEXT,                                -- Docker container ID
      worktree_path TEXT,                               -- Path to the git worktree
      opencode_session_id TEXT,
      last_heartbeat INTEGER,
      last_activity INTEGER,
      spawn_failure_count INTEGER DEFAULT 0,
      last_spawn_failure INTEGER,
      last_spawn_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- Messages (prompt queue + history)
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'web',
      model TEXT,
      reasoning_effort TEXT,
      attachments TEXT,                                 -- JSON array
      status TEXT DEFAULT 'pending',                    -- pending, processing, completed, failed
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- Agent events (tool calls, tokens, errors, execution_complete, etc.)
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,                               -- JSON payload (full SandboxEvent)
      message_id TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- Artifacts (PRs, branches, screenshots)
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      url TEXT,
      metadata TEXT,                                    -- JSON
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- Settings (model preferences, general config)
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Secrets (environment variables injected into sandboxes)
    CREATE TABLE IF NOT EXISTS secrets (
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',              -- 'global' or repo name
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (key, scope)
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(session_id, status);
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(session_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(session_id, type);
    CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id);
    CREATE INDEX IF NOT EXISTS idx_secrets_scope ON secrets(scope);
  `);
}

/**
 * Close the database connection gracefully.
 */
export function closeDb(): void {
  if (db) {
    db.close();
  }
}
