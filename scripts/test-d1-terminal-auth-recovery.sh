#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$PROJECT_ROOT/terraform/d1/migrations"
VERIFIER="$SCRIPT_DIR/d1/0047_terminal_browser_auth_status.sql"
PREFLIGHT="$SCRIPT_DIR/d1/0047_terminal_browser_auth_preflight.sql"
TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

assert_status() {
  local database_path="$1"
  local expected="$2"
  local actual
  actual="$(sqlite3 "$database_path" < "$VERIFIER")"
  if [ "$actual" != "$expected" ]; then
    echo "Expected migration status '$expected', got '$actual'" >&2
    exit 1
  fi
}

BASE_DATABASE="$TEST_DIR/base.db"
for migration_file in "$MIGRATIONS_DIR"/*.sql; do
  migration_version="$(basename "$migration_file" | grep -oE '^[0-9]+')"
  if ((10#$migration_version >= 47)); then
    continue
  fi
  sqlite3 "$BASE_DATABASE" < "$migration_file"
done
assert_status "$BASE_DATABASE" "not_applied"
if [ "$(sqlite3 -separator '|' "$BASE_DATABASE" < "$PREFLIGHT")" \
  != "ready|0|0||" ]; then
  echo "A valid legacy email set did not pass migration preflight" >&2
  exit 1
fi

INVALID_EMAIL_DATABASE="$TEST_DIR/invalid-email.db"
cp "$BASE_DATABASE" "$INVALID_EMAIL_DATABASE"
sqlite3 "$INVALID_EMAIL_DATABASE" \
  "INSERT INTO users (id, display_name, email, avatar_url, created_at, updated_at)
   VALUES
     ('blank-user', NULL, '   ', NULL, 1, 1),
     ('duplicate-a', NULL, 'duplicate@example.com', NULL, 1, 1),
     ('duplicate-b', NULL, ' duplicate@example.com ', NULL, 1, 1);"
if [ "$(sqlite3 -separator '|' "$INVALID_EMAIL_DATABASE" < "$PREFLIGHT")" \
  != "blocked|1|2|blank-user|duplicate-a,duplicate-b" ]; then
  echo "Invalid legacy email rows were not reported deterministically" >&2
  exit 1
fi

PARTIAL_DATABASE="$TEST_DIR/partial.db"
cp "$BASE_DATABASE" "$PARTIAL_DATABASE"
sqlite3 "$PARTIAL_DATABASE" \
  "ALTER TABLE user_identities ADD COLUMN provider_issuer TEXT;"
assert_status "$PARTIAL_DATABASE" "partial"

COMPLETE_DATABASE="$TEST_DIR/complete.db"
cp "$BASE_DATABASE" "$COMPLETE_DATABASE"
sqlite3 "$COMPLETE_DATABASE" \
  "INSERT INTO users (id, display_name, email, avatar_url, created_at, updated_at)
   VALUES ('legacy-user', NULL, ' Legacy@Example.COM ', NULL, 1, 1);
   INSERT INTO user_identities
     (id, user_id, provider, provider_user_id, created_at)
   VALUES
     ('github-identity', 'legacy-user', 'github', 'github-subject', 1),
     ('slack-identity', 'legacy-user', 'slack', 'slack-subject', 1);"
sqlite3 "$COMPLETE_DATABASE" < "$MIGRATIONS_DIR/0047_terminal_browser_auth.sql"
assert_status "$COMPLETE_DATABASE" "complete"
if [ "$(sqlite3 "$COMPLETE_DATABASE" \
  "SELECT provider_issuer FROM user_identities WHERE id = 'github-identity';")" \
  != "https://github.com" ]; then
  echo "GitHub identity issuer backfill did not match the configured authority" >&2
  exit 1
fi
if [ -n "$(sqlite3 "$COMPLETE_DATABASE" \
  "SELECT coalesce(provider_issuer, '') FROM user_identities WHERE id = 'slack-identity';")" ]; then
  echo "Non-sign-in identity received an invented issuer authority" >&2
  exit 1
fi
if [ "$(sqlite3 "$COMPLETE_DATABASE" \
  "SELECT email || '|' || user_id || '|' || source_kind
   FROM verified_email_claims;")" \
  != "legacy@example.com|legacy-user|legacy_canonical" ]; then
  echo "Legacy verified-email claim backfill did not preserve canonical ownership" >&2
  exit 1
fi

sqlite3 "$COMPLETE_DATABASE" "DROP INDEX idx_browser_auth_sessions_retention;"
assert_status "$COMPLETE_DATABASE" "partial"

RECOVERY_MIGRATIONS="$TEST_DIR/recovery-migrations"
mkdir "$RECOVERY_MIGRATIONS"
cp "$MIGRATIONS_DIR/0047_terminal_browser_auth.sql" "$RECOVERY_MIGRATIONS/"
RECOVERY_LOG="$TEST_DIR/recovery.log"
touch "$RECOVERY_LOG"

PATH="$SCRIPT_DIR/test-fixtures/d1-migrate:$PATH" \
  D1_MIGRATE_TEST_LOG="$RECOVERY_LOG" \
  D1_MIGRATE_TEST_STATUS="complete" \
  bash "$SCRIPT_DIR/d1-migrate.sh" "recovery-test" "$RECOVERY_MIGRATIONS"

if grep -F -- "--file $RECOVERY_MIGRATIONS/0047_terminal_browser_auth.sql" "$RECOVERY_LOG"; then
  echo "Migration DDL was replayed after the verifier reported a complete schema" >&2
  exit 1
fi
grep -F "INSERT INTO _schema_migrations" "$RECOVERY_LOG" >/dev/null

touch "$TEST_DIR/partial-recovery.log"
if PATH="$SCRIPT_DIR/test-fixtures/d1-migrate:$PATH" \
  D1_MIGRATE_TEST_LOG="$TEST_DIR/partial-recovery.log" \
  D1_MIGRATE_TEST_STATUS="partial" \
  bash "$SCRIPT_DIR/d1-migrate.sh" "recovery-test" "$RECOVERY_MIGRATIONS" \
  >"$TEST_DIR/partial-recovery.out" 2>&1; then
  echo "A partially applied migration must block automatic recovery" >&2
  exit 1
fi
grep -F "is partially applied; refusing to replay DDL" \
  "$TEST_DIR/partial-recovery.out" >/dev/null
if grep -F -- "--file $RECOVERY_MIGRATIONS/0047_terminal_browser_auth.sql" \
  "$TEST_DIR/partial-recovery.log"; then
  echo "Partially applied migration DDL was replayed" >&2
  exit 1
fi

touch "$TEST_DIR/not-applied-recovery.log"
PATH="$SCRIPT_DIR/test-fixtures/d1-migrate:$PATH" \
  D1_MIGRATE_TEST_LOG="$TEST_DIR/not-applied-recovery.log" \
  D1_MIGRATE_TEST_STATUS="not_applied" \
  bash "$SCRIPT_DIR/d1-migrate.sh" "recovery-test" "$RECOVERY_MIGRATIONS"
grep -F -- "--file $RECOVERY_MIGRATIONS/0047_terminal_browser_auth.sql" \
  "$TEST_DIR/not-applied-recovery.log" >/dev/null

touch "$TEST_DIR/version-collision.log"
if PATH="$SCRIPT_DIR/test-fixtures/d1-migrate:$PATH" \
  D1_MIGRATE_TEST_LOG="$TEST_DIR/version-collision.log" \
  D1_MIGRATE_TEST_STATUS="complete" \
  D1_MIGRATE_TEST_APPLIED="true" \
  D1_MIGRATE_TEST_RECORDED_NAME="0047_downstream_custom.sql" \
  bash "$SCRIPT_DIR/d1-migrate.sh" "recovery-test" "$RECOVERY_MIGRATIONS" \
  >"$TEST_DIR/version-collision.out" 2>&1; then
  echo "A conflicting applied migration name must block version 0047" >&2
  exit 1
fi
grep -F "version 0047 is already recorded as 0047_downstream_custom.sql" \
  "$TEST_DIR/version-collision.out" >/dev/null

touch "$TEST_DIR/preflight-block.log"
if PATH="$SCRIPT_DIR/test-fixtures/d1-migrate:$PATH" \
  D1_MIGRATE_TEST_LOG="$TEST_DIR/preflight-block.log" \
  D1_MIGRATE_TEST_STATUS="not_applied" \
  D1_MIGRATE_TEST_PREFLIGHT_STATUS="blocked" \
  bash "$SCRIPT_DIR/d1-migrate.sh" "recovery-test" "$RECOVERY_MIGRATIONS" \
  >"$TEST_DIR/preflight-block.out" 2>&1; then
  echo "Invalid legacy emails must block migration before DDL" >&2
  exit 1
fi
grep -F "legacy email preflight blocked migration" \
  "$TEST_DIR/preflight-block.out" >/dev/null
if grep -F -- "--file $RECOVERY_MIGRATIONS/0047_terminal_browser_auth.sql" \
  "$TEST_DIR/preflight-block.log"; then
  echo "Migration DDL ran after the legacy email preflight failed" >&2
  exit 1
fi
