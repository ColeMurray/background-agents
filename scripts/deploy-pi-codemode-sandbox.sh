#!/usr/bin/env bash
set -euo pipefail

operation="${1:-}"
rollback_version="${2:-}"
deployment_name="${DEPLOYMENT_NAME:-}"

if [[ ! "$deployment_name" =~ ^([a-z0-9]|[a-z0-9][a-z0-9-]*[a-z0-9])$ ]]; then
  echo "DEPLOYMENT_NAME must be a lowercase alphanumeric/hyphen label" >&2
  exit 1
fi

worker_name="open-inspect-pi-codemode-sandbox-${deployment_name}"
if (( ${#worker_name} > 63 )); then
  echo "Derived Code Mode sandbox Worker name exceeds 63 characters" >&2
  exit 1
fi
: "${CONFIRM_WORKER_NAME:?CONFIRM_WORKER_NAME is required}"
if [[ "$CONFIRM_WORKER_NAME" != "$worker_name" ]]; then
  echo "CONFIRM_WORKER_NAME must exactly match $worker_name" >&2
  exit 1
fi

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config="$repo_root/packages/pi-codemode-sandbox/wrangler.jsonc"
if [[ -n "${WRANGLER_BIN:-}" ]]; then
  wrangler=("$WRANGLER_BIN")
else
  wrangler=(npx --no-install wrangler)
fi

case "$operation" in
  deploy)
    # Wrangler owns the script, version, WASM module, and v1 class migration in
    # one direct Workers Script deployment. Terraform must never deploy it.
    "${wrangler[@]}" deploy \
      --config "$config" \
      --name "$worker_name" \
      --strict \
      --message "Open-Inspect Pi Code Mode sandbox"
    ;;
  rollback)
    if [[ -z "$rollback_version" ]]; then
      echo "rollback requires the target Worker version ID" >&2
      exit 1
    fi
    "${wrangler[@]}" rollback "$rollback_version" \
      --config "$config" \
      --name "$worker_name" \
      --message "Open-Inspect Pi Code Mode rollback" \
      --yes
    ;;
  *)
    echo "usage: $0 deploy | rollback <version-id>" >&2
    exit 1
    ;;
esac
