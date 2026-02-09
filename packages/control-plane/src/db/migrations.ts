/**
 * PostgreSQL schema migrations.
 *
 * Replaces Cloudflare D1 migrations. These tables mirror the D1 schema
 * but use PostgreSQL-compatible types.
 */

import type { Pool } from "pg";
import { createLogger } from "../logger";

const log = createLogger("migrations");

/**
 * Core schema: session index, repo metadata, and repo secrets.
 *
 * These are the global tables (not per-session like the Durable Object
 * SQLite tables). Per-session state is held in the Rivet actor.
 */
const SCHEMA_SQL = `
-- Session index for listing and filtering
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  session_name TEXT,
  title TEXT,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  status TEXT DEFAULT 'created',
  sandbox_status TEXT DEFAULT 'pending',
  model TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  owner_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions(repo_owner, repo_name);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);

-- Repository metadata (custom descriptions, aliases, channel associations)
CREATE TABLE IF NOT EXISTS repo_metadata (
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  description TEXT,
  aliases TEXT,
  channel_associations TEXT,
  keywords TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (repo_owner, repo_name)
);

-- Repository secrets (encrypted, per-repo environment variables)
CREATE TABLE IF NOT EXISTS repo_secrets (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  repo_id INTEGER NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  key TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(repo_id, key)
);

CREATE INDEX IF NOT EXISTS idx_repo_secrets_repo ON repo_secrets(repo_id);
`;

/**
 * Run all schema migrations.
 *
 * This is idempotent -- CREATE TABLE IF NOT EXISTS and CREATE INDEX IF NOT EXISTS
 * ensure that re-running migrations is safe.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  log.info("Running database migrations");
  const client = await pool.connect();
  try {
    await client.query(SCHEMA_SQL);
    log.info("Database migrations completed");
  } catch (err) {
    log.error("Migration failed", {
      error: err instanceof Error ? err : String(err),
    });
    throw err;
  } finally {
    client.release();
  }
}
