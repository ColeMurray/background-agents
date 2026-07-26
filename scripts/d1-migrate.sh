#!/usr/bin/env bash
set -euo pipefail

DATABASE_NAME="${1:?Usage: d1-migrate.sh <database-name> [migrations-dir]}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIGRATIONS_DIR="${2:-$SCRIPT_DIR/../terraform/d1/migrations}"

WRANGLER="npx wrangler"

# 0. Validate filenames and guard against duplicate version numbers. Migrations
# are deduped by their numeric prefix (the _schema_migrations version), so two
# files sharing a prefix mean one is silently skipped forever — e.g. two PRs
# that each grab the next number and then both merge. A file with no numeric
# prefix can't be tracked at all. Fail fast on either, with a clear message.
INVALID_FILES=""
PREFIXES=""
for file in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$file" ] || continue
  BASE=$(basename "$file")
  # `|| true` so a prefix-less filename doesn't trip the grep's non-zero exit
  # under `set -o pipefail` and abort before we can report it below.
  PREFIX=$(printf '%s' "$BASE" | grep -oE '^[0-9]+' || true)
  if [ -z "$PREFIX" ]; then
    INVALID_FILES+="  $BASE"$'\n'
  else
    PREFIXES+="$PREFIX"$'\n'
  fi
done

if [ -n "$INVALID_FILES" ]; then
  echo "ERROR: migration files without a leading numeric prefix:" >&2
  printf '%s' "$INVALID_FILES" >&2
  echo "Rename them as NNNN_description.sql so they can be tracked." >&2
  exit 1
fi

DUPES=$(printf '%s' "$PREFIXES" | sort | uniq -d)
if [ -n "$DUPES" ]; then
  echo "ERROR: duplicate migration version prefixes detected:" >&2
  echo "$DUPES" | sed 's/^/  /' >&2
  echo "Renumber the colliding files so each prefix is unique before deploying." >&2
  exit 1
fi

# 1. Ensure tracking table exists
$WRANGLER d1 execute "$DATABASE_NAME" --remote \
  --command "CREATE TABLE IF NOT EXISTS _schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )"

# 2. Get applied versions (parse JSON output)
APPLIED=$($WRANGLER d1 execute "$DATABASE_NAME" --remote \
  --command "SELECT version FROM _schema_migrations ORDER BY version" \
  --json | jq -r '.[0].results[].version // empty' 2>/dev/null || echo "")

# 3. Apply pending migrations in order
COUNT=0
for file in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$file" ] || continue
  FILENAME=$(basename "$file")
  VERSION=$(echo "$FILENAME" | grep -oE '^[0-9]+')
  SAFE_FILENAME=$(echo "$FILENAME" | sed "s/'/''/g")

  if echo "$APPLIED" | grep -qxF "$VERSION"; then
    if [ "$VERSION" = "0047" ] && [ "$FILENAME" = "0047_terminal_browser_auth.sql" ]; then
      RECORDED_NAME=$(
        $WRANGLER d1 execute "$DATABASE_NAME" --remote \
          --command "SELECT name FROM _schema_migrations WHERE version = '$VERSION'" \
          --json |
          jq -er '.[0].results[0].name'
      )
      if [ "$RECORDED_NAME" != "$FILENAME" ]; then
        echo "ERROR: version $VERSION is already recorded as $RECORDED_NAME." >&2
        echo "Renumber this migration before applying it to this installation." >&2
        exit 1
      fi
    fi
    echo "Skip (already applied): $FILENAME"
    continue
  fi

  # Migration 0047 contains an additive but non-idempotent ALTER TABLE. D1
  # applies the SQL file and records the migration ledger in separate remote
  # calls, so the schema may be complete even if the ledger write failed.
  # Verify that exact state before replaying DDL; fail closed on partial or
  # unexpected schemas.
  if [ "$VERSION" = "0047" ] && [ "$FILENAME" = "0047_terminal_browser_auth.sql" ]; then
    RECOVERY_STATUS=$(
      $WRANGLER d1 execute "$DATABASE_NAME" --remote \
        --file "$SCRIPT_DIR/d1/0047_terminal_browser_auth_status.sql" \
        --json |
        jq -er '.[0].results[0].status'
    )

    case "$RECOVERY_STATUS" in
      complete)
        echo "Repairing missing migration ledger: $FILENAME"
        $WRANGLER d1 execute "$DATABASE_NAME" --remote \
          --command "INSERT INTO _schema_migrations (version, name) VALUES ('$VERSION', '$SAFE_FILENAME')"
        RECORDED_NAME=$(
          $WRANGLER d1 execute "$DATABASE_NAME" --remote \
            --command "SELECT name FROM _schema_migrations WHERE version = '$VERSION'" \
            --json |
            jq -er '.[0].results[0].name'
        )
        if [ "$RECORDED_NAME" != "$FILENAME" ]; then
          echo "ERROR: migration $VERSION ledger repair recorded an unexpected name." >&2
          exit 1
        fi
        echo "Repaired migration ledger: $FILENAME"
        continue
        ;;
      not_applied)
        ;;
      partial)
        echo "ERROR: migration $FILENAME is partially applied; refusing to replay DDL." >&2
        echo "Inspect or restore the database before retrying; do not record the ledger manually." >&2
        exit 1
        ;;
      *)
        echo "ERROR: migration $FILENAME verifier returned '$RECOVERY_STATUS'." >&2
        exit 1
        ;;
    esac
  fi

  echo "Applying: $FILENAME"
  $WRANGLER d1 execute "$DATABASE_NAME" --remote --file "$file"

  $WRANGLER d1 execute "$DATABASE_NAME" --remote \
    --command "INSERT INTO _schema_migrations (version, name) VALUES ('$VERSION', '$SAFE_FILENAME')"

  COUNT=$((COUNT + 1))
done

echo "Done. Applied $COUNT migration(s)."
