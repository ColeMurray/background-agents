#!/usr/bin/env bash
set -euo pipefail

# Upload current secrets and remove retired web-auth secrets via wrangler.
# Required environment variables:
#   WORKER_NAME          - target worker name
#   SERVICE_AUTH_SECRET  - web's per-service sig1 signing secret

echo "Uploading secrets to worker: ${WORKER_NAME}"

echo "${SERVICE_AUTH_SECRET}" | npx wrangler secret put SERVICE_AUTH_SECRET --name "${WORKER_NAME}"

existing_secrets="$(npx wrangler secret list --name "${WORKER_NAME}" --format json)"
for retired_secret in GITHUB_CLIENT_SECRET GOOGLE_CLIENT_SECRET NEXTAUTH_SECRET; do
  if [[ "${existing_secrets}" =~ \"name\"[[:space:]]*:[[:space:]]*\"${retired_secret}\" ]]; then
    printf 'y\n' | npx wrangler secret delete "${retired_secret}" --name "${WORKER_NAME}"
  fi
done

echo "Secrets uploaded successfully"
