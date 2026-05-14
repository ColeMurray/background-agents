#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:-}"
MIGRATIONS_DIR="${3:-$SCRIPT_DIR/../terraform/d1/migrations}"

WRANGLER="npx wrangler"

usage() {
  printf "Usage:\n"
  printf "  d1-migrate.sh local [database-name] [migrations-dir]\n"
  printf "  d1-migrate.sh remote <database-name> [migrations-dir]\n"
}

case "$MODE" in
  local)
    DATABASE_NAME="${2:-open-inspect-test}"
    D1_OPTIONS=(--local --config "$SCRIPT_DIR/../packages/control-plane/wrangler.jsonc")
    ;;
  remote)
    if [ -z "${2:-}" ]; then
      usage
      exit 1
    fi
    DATABASE_NAME="$2"
    D1_OPTIONS=(--remote)
    ;;
  *)
    usage
    exit 1
    ;;
esac

# 1. Ensure tracking table exists.
$WRANGLER d1 execute "$DATABASE_NAME" "${D1_OPTIONS[@]}" \
  --command "CREATE TABLE IF NOT EXISTS _schema_migrations (
    version TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )"

# 2. Get applied versions from the tracking table.
APPLIED=$($WRANGLER d1 execute "$DATABASE_NAME" "${D1_OPTIONS[@]}" \
  --command "SELECT version FROM _schema_migrations ORDER BY version" \
  --json | jq -r '.[0].results // [] | .[].version')

# 3. Apply pending migrations in order.
COUNT=0
for file in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$file" ] || continue
  FILENAME=$(basename "$file")
  if [[ "$FILENAME" =~ ^([0-9]+) ]]; then
    VERSION="${BASH_REMATCH[1]}"
  else
    printf "Invalid migration filename: VERSION is empty for FILENAME=%s; expected numeric prefix.\n" "$FILENAME" >&2
    exit 1
  fi

  if printf "%s\n" "$APPLIED" | grep -qxF "$VERSION"; then
    printf "Skip (already applied): %s\n" "$FILENAME"
    continue
  fi

  printf "Applying: %s\n" "$FILENAME"
  $WRANGLER d1 execute "$DATABASE_NAME" "${D1_OPTIONS[@]}" --file "$file"

  SAFE_FILENAME=$(printf "%s" "$FILENAME" | sed "s/'/''/g")
  $WRANGLER d1 execute "$DATABASE_NAME" "${D1_OPTIONS[@]}" \
    --command "INSERT INTO _schema_migrations (version, name) VALUES ('$VERSION', '$SAFE_FILENAME')"

  COUNT=$((COUNT + 1))
done

printf "Done. Applied %d migration(s).\n" "$COUNT"
