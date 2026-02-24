#!/usr/bin/env bash
set -euo pipefail

# Upload secrets to a Cloudflare Worker via wrangler.
# Required environment variables:
#   WORKER_NAME              - target worker name
#   GITHUB_CLIENT_SECRET     - GitHub OAuth client secret
#   NEXTAUTH_SECRET          - NextAuth.js signing secret
#   INTERNAL_CALLBACK_SECRET - service-to-service auth secret

echo "Uploading secrets to worker: ${WORKER_NAME}"

echo "${GITHUB_CLIENT_SECRET}" | npx wrangler secret put GITHUB_CLIENT_SECRET --name "${WORKER_NAME}"
echo "${NEXTAUTH_SECRET}" | npx wrangler secret put NEXTAUTH_SECRET --name "${WORKER_NAME}"
echo "${INTERNAL_CALLBACK_SECRET}" | npx wrangler secret put INTERNAL_CALLBACK_SECRET --name "${WORKER_NAME}"

echo "Secrets uploaded successfully"
