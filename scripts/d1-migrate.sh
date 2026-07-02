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

  if echo "$APPLIED" | grep -qxF "$VERSION"; then
    echo "Skip (already applied): $FILENAME"
    continue
  fi

  echo "Applying: $FILENAME"
  $WRANGLER d1 execute "$DATABASE_NAME" --remote --file "$file"

  SAFE_FILENAME=$(echo "$FILENAME" | sed "s/'/''/g")
  $WRANGLER d1 execute "$DATABASE_NAME" --remote \
    --command "INSERT INTO _schema_migrations (version, name) VALUES ('$VERSION', '$SAFE_FILENAME')"

  COUNT=$((COUNT + 1))
done

echo "Done. Applied $COUNT migration(s)."
