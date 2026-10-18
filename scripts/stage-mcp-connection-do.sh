#!/usr/bin/env bash
set -euo pipefail

current_tag="${CURRENT_CONTROL_PLANE_MIGRATION_TAG:-}"
foundation_enabled="$(printf '%s' "${MCP_CONNECTION_FOUNDATION_ENABLED:-false}" | tr '[:upper:]' '[:lower:]')"
bindings_enabled="$(printf '%s' "${ENABLE_DURABLE_OBJECT_BINDINGS:-true}" | tr '[:upper:]' '[:lower:]')"

rm -f mcp-connection-do.auto.tfvars.json

if [ "$current_tag" = "v5" ]; then
  printf '%s\n' '{"mcp_connection_binding_enabled":true}' > mcp-connection-do.auto.tfvars.json
  if [ "$bindings_enabled" = "false" ]; then
    echo "Set ENABLE_DURABLE_OBJECT_BINDINGS=true after applying the McpConnectionDO migration" >&2
    exit 1
  fi
  exit 0
fi

if [ "$foundation_enabled" != "true" ]; then
  exit 0
fi

if [ "$bindings_enabled" != "false" ]; then
  echo "Set ENABLE_DURABLE_OBJECT_BINDINGS=false and apply the McpConnectionDO migration first" >&2
  exit 1
fi

case "$current_tag" in
  "")
    printf '%s\n' '{"mcp_connection_binding_enabled":true,"control_plane_migration_tag":"v5","control_plane_new_sqlite_classes":["SessionDO","PiSessionDO","McpConnectionDO"]}' > mcp-connection-do.auto.tfvars.json
    ;;
  v4)
    printf '%s\n' '{"mcp_connection_binding_enabled":true,"control_plane_migration_tag":"v5","control_plane_migration_old_tag":"v4","control_plane_new_sqlite_classes":["McpConnectionDO"]}' > mcp-connection-do.auto.tfvars.json
    ;;
  *)
    echo "McpConnectionDO requires the PiSessionDO v4 migration before the v5 upgrade (current tag: '$current_tag')" >&2
    exit 1
    ;;
esac
