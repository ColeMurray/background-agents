/**
 * SQLite schema for the Pi Durable Object.
 *
 * The Pi Durable Object owns one SQLite database, and three table families
 * live in it:
 *
 * - pi-durable's `pi_*` tables, which upstream creates through its own
 *   numbered migrations (`node_modules/@earendil-works/pi-durable/dist/storage/sqlite/migrations.js`);
 * - the Computer VFS's `vfs_*` tables, which upstream creates through its own
 *   numbered migrations (`node_modules/@cloudflare/computer/dist/index.js`);
 * - Open-Inspect's `oi_pi_*` tables, which this file owns.
 *
 * Only the third family is ours, so only the third family is tracked here —
 * in the same numbered, additive, forward-only registry the Session Durable
 * Object uses for its own database (`packages/control-plane/src/session/schema.ts`).
 * A table that a runtime `CREATE TABLE IF NOT EXISTS` made is invisible to the
 * schema's own tests and to the rollback story: an older binary that lacks the
 * outbox code finds the table already present and keeps using it.
 *
 * The registry is separate from the Session Durable Object's because the
 * databases are separate. Two stores, two numbering spaces, one pattern.
 */

import {
  PI_DO_OUTBOX_MIGRATION_ID,
  PI_DO_REPOSITORY_DIFF_OUTBOX_MIGRATION_ID,
  PI_DO_TRUSTED_USAGE_MIGRATION_ID,
  PI_DO_TURN_AUTHORITY_MIGRATION_ID,
} from "@open-inspect/shared/migration-reservations";
import type { MigrationOwner } from "@open-inspect/shared/migration-reservations";
import { createLogger } from "../logger";
import type { SqliteExecutor } from "@earendil-works/chord/sqlite";
import type { SqlStorage } from "../session/sql-storage";

const schemaLog = createLogger("pi-schema");

/** The projection outbox: the immutable, operation-scoped delivery log. */
export const PI_PROJECTION_OUTBOX_TABLE_SQL = `CREATE TABLE IF NOT EXISTS oi_pi_projection_outbox (
  sequence INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  display_id TEXT NOT NULL,
  source_id TEXT,
  event_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  failed_at INTEGER,
  failure TEXT,
  PRIMARY KEY(operation_id, sequence),
  UNIQUE(operation_id, source_id)
)`;

/** The projection finalization tombstones: what a settled operation cost. */
export const PI_PROJECTION_FINALIZATION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS oi_pi_projection_finalization (
  operation_id TEXT PRIMARY KEY,
  cost_usd REAL NOT NULL,
  usage_json TEXT NOT NULL,
  result_rejection TEXT,
  captured_at INTEGER NOT NULL
)`;

/** The repository diff publication outbox: one coalescing pending publication. */
export const PI_REPOSITORY_DIFF_OUTBOX_TABLE_SQL = `CREATE TABLE IF NOT EXISTS oi_pi_repository_diff_outbox (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation INTEGER NOT NULL,
  pending_generation INTEGER,
  pending_json TEXT,
  recapture_required INTEGER NOT NULL,
  last_success_json TEXT,
  last_error TEXT,
  last_error_at INTEGER,
  permanent_error TEXT,
  updated_at INTEGER NOT NULL
)`;

/** Server-priced usage, written through Pi's shared SQLite operation queue. */
export const PI_TRUSTED_USAGE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS oi_pi_trusted_usage (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`;

/** Per-turn authority that must survive a Pi wake or object eviction. */
export const PI_TURN_AUTHORITY_TABLE_SQL = `CREATE TABLE IF NOT EXISTS oi_pi_turn_authority (
  operation_id TEXT PRIMARY KEY,
  deadline_ms INTEGER,
  remaining_actions INTEGER NOT NULL CHECK (remaining_actions >= 0),
  created_at INTEGER NOT NULL
)`;

/**
 * A numbered, tracked migration for the Pi Durable Object's database.
 *
 * - `string` runs are statements processed through runMigration() (errors for
 *   "duplicate column" / "already exists" are swallowed).
 * - `function` runs execute directly and must be written idempotently, since
 *   they may re-run if the process crashes between execution and recording.
 */
export interface PiSchemaMigration {
  readonly id: number;
  readonly description: string;
  /** Required when `id` is reserved by MIGRATION_RESERVATIONS. */
  readonly feature?: MigrationOwner;
  readonly run: string | ((sql: SqlStorage) => void);
}

export const PI_DO_MIGRATIONS: readonly PiSchemaMigration[] = [
  {
    id: PI_DO_OUTBOX_MIGRATION_ID,
    description: "Persist the Pi projection outbox and its finalization tombstones",
    feature: "piProjection",
    run: (sql) => {
      sql.exec(PI_PROJECTION_OUTBOX_TABLE_SQL);
      sql.exec(PI_PROJECTION_FINALIZATION_TABLE_SQL);
    },
  },
  {
    id: PI_DO_REPOSITORY_DIFF_OUTBOX_MIGRATION_ID,
    description: "Persist the Pi repository diff publication outbox",
    feature: "repositoryEditing",
    run: PI_REPOSITORY_DIFF_OUTBOX_TABLE_SQL,
  },
  {
    id: PI_DO_TRUSTED_USAGE_MIGRATION_ID,
    description: "Persist trusted Pi usage through the shared SQLite queue",
    feature: "coreAuthority",
    run: PI_TRUSTED_USAGE_TABLE_SQL,
  },
  {
    id: PI_DO_TURN_AUTHORITY_MIGRATION_ID,
    description: "Persist Pi turn deadlines and action ceilings",
    feature: "coreAuthority",
    run: PI_TURN_AUTHORITY_TABLE_SQL,
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
 * Apply the Pi Durable Object's pending migrations, tracking which have
 * already run via `_schema_migrations`.
 */
export function applyPiDoMigrations(sql: SqlStorage): void {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS _schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)`
  );

  const rows = sql.exec(`SELECT id FROM _schema_migrations`).toArray() as Array<{ id: number }>;
  const applied = new Set(rows.map((r) => r.id));

  for (const migration of PI_DO_MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    if (typeof migration.run === "string") {
      runMigration(sql, migration.run);
    } else {
      migration.run(sql);
    }

    sql.exec(
      `INSERT INTO _schema_migrations (id, applied_at) VALUES (?, ?) ON CONFLICT DO NOTHING`,
      migration.id,
      Date.now()
    );
  }
}

/**
 * Assert that the Pi Durable Object's own tables exist.
 *
 * The outboxes never create their tables: a table that is missing means the
 * object's migrations did not run, and that is a broken deployment, not
 * something to paper over at first use.
 */
export function assertPiDoTables(sql: SqlStorage, ...names: string[]): void {
  if (names.length === 0) return;
  const placeholders = names.map(() => "?").join(", ");
  const rows = sql
    .exec(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
      ...names
    )
    .toArray() as Array<{ name?: unknown }>;
  const present = new Set(rows.map((row) => row.name));
  const missing = names.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Pi Durable Object schema is missing ${missing.join(", ")}; its migrations did not run`
    );
  }
}

/** Async form for callers coordinated with pi-durable's shared SQLite queue. */
export async function assertPiDoTablesAsync(
  sql: SqliteExecutor,
  ...names: string[]
): Promise<void> {
  if (names.length === 0) return;
  const placeholders = names.map(() => "?").join(", ");
  const rows = await sql.all<{ name?: unknown }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`,
    ...names
  );
  const present = new Set(rows.map((row) => row.name));
  const missing = names.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Pi Durable Object schema is missing ${missing.join(", ")}; its migrations did not run`
    );
  }
}
