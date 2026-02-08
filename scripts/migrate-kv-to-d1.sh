#!/usr/bin/env bash
set -euo pipefail

# Migrate session and repo metadata from KV (SESSION_INDEX) to D1.
# Idempotent — safe to re-run. Uses INSERT OR IGNORE for sessions and
# INSERT ... ON CONFLICT DO UPDATE for repo metadata.
#
# Prerequisites:
#   - wrangler authenticated (CLOUDFLARE_API_TOKEN or `wrangler login`)
#   - jq installed
#   - D1 tables already created (via d1-migrate.sh)
#
# Usage:
#   ./scripts/migrate-kv-to-d1.sh <kv-namespace-id> <d1-database-name>
#
# The KV namespace ID can be obtained from: terraform output session_index_kv_id

KV_NAMESPACE_ID="${1:?Usage: migrate-kv-to-d1.sh <kv-namespace-id> <d1-database-name>}"
D1_DATABASE_NAME="${2:?Usage: migrate-kv-to-d1.sh <kv-namespace-id> <d1-database-name>}"

WRANGLER="npx wrangler"
SQL_FILE=$(mktemp)
trap 'rm -f "$SQL_FILE"' EXIT

SESSION_COUNT=0
METADATA_COUNT=0

# Escape single quotes for SQL values
sql_escape() {
  printf '%s' "$1" | sed "s/'/''/g"
}

echo "=== Migrating sessions from KV to D1 ==="

# List all session:* keys from KV
SESSION_KEYS=$($WRANGLER kv key list --namespace-id "$KV_NAMESPACE_ID" --prefix "session:" 2>/dev/null || echo "[]")

while IFS= read -r key; do
  [ -z "$key" ] && continue

  VALUE=$($WRANGLER kv key get --namespace-id "$KV_NAMESPACE_ID" "$key" --text 2>/dev/null || echo "")
  [ -z "$VALUE" ] && continue

  # Parse JSON fields
  ID=$(echo "$VALUE" | jq -r '.id // empty')
  [ -z "$ID" ] && continue

  TITLE=$(sql_escape "$(echo "$VALUE" | jq -r '.title // ""')")
  REPO_OWNER=$(sql_escape "$(echo "$VALUE" | jq -r '.repoOwner // ""')")
  REPO_NAME=$(sql_escape "$(echo "$VALUE" | jq -r '.repoName // ""')")
  MODEL=$(sql_escape "$(echo "$VALUE" | jq -r '.model // "claude-haiku-4-5"')")
  STATUS=$(sql_escape "$(echo "$VALUE" | jq -r '.status // "created"')")
  CREATED_AT=$(echo "$VALUE" | jq -r '.createdAt // 0')
  UPDATED_AT=$(echo "$VALUE" | jq -r '.updatedAt // 0')

  # Handle null title
  if [ "$TITLE" = "" ]; then
    TITLE_SQL="NULL"
  else
    TITLE_SQL="'$TITLE'"
  fi

  echo "INSERT OR IGNORE INTO sessions (id, title, repo_owner, repo_name, model, status, created_at, updated_at) VALUES ('$(sql_escape "$ID")', $TITLE_SQL, '$REPO_OWNER', '$REPO_NAME', '$MODEL', '$STATUS', $CREATED_AT, $UPDATED_AT);" >> "$SQL_FILE"
  SESSION_COUNT=$((SESSION_COUNT + 1))
  echo "  Session: $ID"
done < <(echo "$SESSION_KEYS" | jq -r '.[].name')

echo ""
echo "=== Migrating repo metadata from KV to D1 ==="

# List all repo:metadata:* keys from KV
METADATA_KEYS=$($WRANGLER kv key list --namespace-id "$KV_NAMESPACE_ID" --prefix "repo:metadata:" 2>/dev/null || echo "[]")

while IFS= read -r key; do
  [ -z "$key" ] && continue

  VALUE=$($WRANGLER kv key get --namespace-id "$KV_NAMESPACE_ID" "$key" --text 2>/dev/null || echo "")
  [ -z "$VALUE" ] && continue

  # Extract owner/name from key: "repo:metadata:owner/name"
  REPO_PATH="${key#repo:metadata:}"
  OWNER="${REPO_PATH%%/*}"
  NAME="${REPO_PATH#*/}"

  [ -z "$OWNER" ] || [ -z "$NAME" ] && continue

  OWNER_LOWER=$(echo "$OWNER" | tr '[:upper:]' '[:lower:]')
  NAME_LOWER=$(echo "$NAME" | tr '[:upper:]' '[:lower:]')

  DESCRIPTION=$(sql_escape "$(echo "$VALUE" | jq -r '.description // ""')")
  ALIASES=$(sql_escape "$(echo "$VALUE" | jq -c '.aliases // []')")
  CHANNEL_ASSOC=$(sql_escape "$(echo "$VALUE" | jq -c '.channelAssociations // []')")
  KEYWORDS=$(sql_escape "$(echo "$VALUE" | jq -c '.keywords // []')")

  NOW_MS=$(( $(date +%s) * 1000 ))

  # Handle null/empty description
  if [ "$DESCRIPTION" = "" ]; then
    DESC_SQL="NULL"
  else
    DESC_SQL="'$DESCRIPTION'"
  fi

  cat >> "$SQL_FILE" <<EOSQL
INSERT INTO repo_metadata (repo_owner, repo_name, description, aliases, channel_associations, keywords, created_at, updated_at)
VALUES ('$(sql_escape "$OWNER_LOWER")', '$(sql_escape "$NAME_LOWER")', $DESC_SQL, '$ALIASES', '$CHANNEL_ASSOC', '$KEYWORDS', $NOW_MS, $NOW_MS)
ON CONFLICT(repo_owner, repo_name) DO UPDATE SET
  description = excluded.description,
  aliases = excluded.aliases,
  channel_associations = excluded.channel_associations,
  keywords = excluded.keywords,
  updated_at = excluded.updated_at;
EOSQL

  METADATA_COUNT=$((METADATA_COUNT + 1))
  echo "  Repo: $OWNER_LOWER/$NAME_LOWER"
done < <(echo "$METADATA_KEYS" | jq -r '.[].name')

# Execute all SQL against D1
if [ -s "$SQL_FILE" ]; then
  echo ""
  echo "=== Executing SQL against D1 ==="
  $WRANGLER d1 execute "$D1_DATABASE_NAME" --remote --file "$SQL_FILE"
  echo ""
  echo "Done. Migrated $SESSION_COUNT session(s) and $METADATA_COUNT repo metadata record(s)."
else
  echo ""
  echo "No data found in KV namespace. Nothing to migrate."
fi
