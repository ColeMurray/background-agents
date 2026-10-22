import {
  PI_SESSION_DO_EXTERNAL_ACTION_LIFECYCLE_MIGRATION_ID,
  PI_SESSION_DO_EXTERNAL_ACTIONS_MIGRATION_ID,
} from "@open-inspect/shared/migration-reservations";
import type { SchemaMigration } from "./schema";
import type { SqlStorage } from "./sql-storage";

const EXTERNAL_ACTIONS_TABLES_SQL = `CREATE TABLE IF NOT EXISTS external_actions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  target_json TEXT NOT NULL CHECK (json_valid(target_json) AND json_type(target_json) = 'object'),
  arguments_json TEXT NOT NULL CHECK (json_valid(arguments_json) AND json_type(arguments_json) = 'object'),
  fingerprint TEXT NOT NULL,
  effect_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'awaiting_approval', 'approved', 'executing', 'succeeded', 'failed', 'denied',
    'indeterminate', 'cancelled'
  )),
  approval_source TEXT CHECK (approval_source IN ('human', 'automation_grant')),
  approval_actor_id TEXT,
  approval_grant_id TEXT,
  approved_at INTEGER,
  continuation_consumed_at INTEGER,
  provider_reference TEXT,
  public_result_json TEXT CHECK (public_result_json IS NULL OR json_valid(public_result_json)),
  error TEXT,
  lease_token TEXT,
  lease_expires_at INTEGER,
  reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
  reconcile_after INTEGER,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((approval_source IS NULL) = (approval_actor_id IS NULL)),
  CHECK ((approval_source IS NULL) = (approved_at IS NULL))
);
CREATE TABLE IF NOT EXISTS external_action_history (
  action_id TEXT NOT NULL REFERENCES external_actions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  event TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT,
  reason TEXT,
  occurred_at INTEGER NOT NULL,
  PRIMARY KEY (action_id, revision)
);
CREATE TABLE IF NOT EXISTS external_action_bindings (
  idempotency_key TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES external_actions(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS external_action_audit_outbox (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL REFERENCES external_actions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL DEFAULT 'user',
  action TEXT NOT NULL,
  session_id TEXT NOT NULL,
  before_state TEXT NOT NULL,
  after_state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  occurred_at INTEGER
);`;

const EXTERNAL_ACTION_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_external_actions_state_updated ON external_actions(state, updated_at)",
  "CREATE INDEX IF NOT EXISTS idx_external_action_history_action ON external_action_history(action_id, revision)",
  "CREATE INDEX IF NOT EXISTS idx_external_action_bindings_action ON external_action_bindings(action_id, operation_id)",
  "CREATE INDEX IF NOT EXISTS idx_external_actions_effect ON external_actions(effect_fingerprint, state, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_external_action_audit_outbox_due ON external_action_audit_outbox(next_attempt_at, id)",
] as const;

export const EXTERNAL_ACTIONS_SCHEMA_MIGRATION: SchemaMigration = {
  id: PI_SESSION_DO_EXTERNAL_ACTIONS_MIGRATION_ID,
  description: "Persist external action approvals and execution history",
  feature: "externalActions",
  run: (sql) => {
    sql.exec(EXTERNAL_ACTIONS_TABLES_SQL);
    for (const statement of EXTERNAL_ACTION_INDEXES) sql.exec(statement);
  },
};

export const EXTERNAL_ACTION_LIFECYCLE_SCHEMA_MIGRATION: SchemaMigration = {
  id: PI_SESSION_DO_EXTERNAL_ACTION_LIFECYCLE_MIGRATION_ID,
  description: "Persist external action approval expiry and audit occurrence time",
  feature: "externalActions",
  run: (sql) => {
    for (const statement of [
      "ALTER TABLE external_actions ADD COLUMN expires_at INTEGER",
      "ALTER TABLE external_action_audit_outbox ADD COLUMN occurred_at INTEGER",
      "ALTER TABLE external_action_audit_outbox ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'user'",
    ]) {
      runIdempotentAlter(sql, statement);
    }
  },
};

function runIdempotentAlter(sql: SqlStorage, statement: string): void {
  try {
    sql.exec(statement);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("duplicate column") || message.includes("already exists")) return;
    throw error;
  }
}
