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

# 2. Get the applied versions and their exact filenames. A numeric prefix is
# only unique within this repository; downstream installations can already
# have used the same version for a different migration.
APPLIED_JSON=$(
  $WRANGLER d1 execute "$DATABASE_NAME" --remote \
    --command "SELECT version, name FROM _schema_migrations ORDER BY version" \
    --json
)
printf '%s' "$APPLIED_JSON" |
  jq -e '.[0].results | type == "array"' >/dev/null

# Each migration and its ledger row are submitted in one SQL file. D1 executes
# the file atomically, so a failed migration rolls back and a lost client
# response is safe to retry: a committed migration always has its ledger row.
MIGRATION_BATCH_DIR="$(mktemp -d)"
cleanup() {
  rm -r -- "$MIGRATION_BATCH_DIR"
}
trap cleanup EXIT

# 3. Apply pending migrations in order
COUNT=0
for file in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$file" ] || continue
  FILENAME=$(basename "$file")
  VERSION=$(echo "$FILENAME" | grep -oE '^[0-9]+')
  SAFE_FILENAME=$(echo "$FILENAME" | sed "s/'/''/g")

  RECORDED_NAME=$(
    printf '%s' "$APPLIED_JSON" |
      jq -r --arg version "$VERSION" \
        '.[0].results[]? | select(.version == $version) | .name'
  )
  if [ -n "$RECORDED_NAME" ]; then
    if [ "$RECORDED_NAME" != "$FILENAME" ]; then
      echo "ERROR: version $VERSION is already recorded as $RECORDED_NAME." >&2
      echo "Renumber this migration before applying it to this installation." >&2
      exit 1
    fi
    echo "Skip (already applied): $FILENAME"
    continue
  fi

  echo "Applying: $FILENAME"
  MIGRATION_BATCH="$MIGRATION_BATCH_DIR/$FILENAME"
  cp "$file" "$MIGRATION_BATCH"
  printf "\n\nINSERT INTO _schema_migrations (version, name) VALUES ('%s', '%s');\n" \
    "$VERSION" "$SAFE_FILENAME" >>"$MIGRATION_BATCH"
  $WRANGLER d1 execute "$DATABASE_NAME" --remote --file "$MIGRATION_BATCH"

  COUNT=$((COUNT + 1))
done

echo "Done. Applied $COUNT migration(s)."
