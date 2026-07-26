#!/usr/bin/env bash
set -euo pipefail

# Upload secrets to a Cloudflare Worker via wrangler.
# Required environment variables:
#   WORKER_NAME          - target worker name
#   SERVICE_AUTH_SECRET  - web's per-service sig1 signing secret

echo "Uploading secrets to worker: ${WORKER_NAME}"

echo "${SERVICE_AUTH_SECRET}" | npx wrangler secret put SERVICE_AUTH_SECRET --name "${WORKER_NAME}"

echo "Secrets uploaded successfully"
