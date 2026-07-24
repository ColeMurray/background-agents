#!/usr/bin/env bash
set -euo pipefail

# Upload secrets to a Cloudflare Worker via wrangler.
# Required environment variables:
#   WORKER_NAME              - target worker name
#   GITHUB_CLIENT_SECRET     - GitHub OAuth client secret
#   NEXTAUTH_SECRET          - NextAuth.js signing secret
#   SERVICE_AUTH_SECRET      - web's per-service sig1 signing secret
# Optional environment variables:
#   GOOGLE_CLIENT_SECRET     - Google OAuth client secret (uploaded only when set;
#                              empty for GitHub-only deployments)

echo "Uploading secrets to worker: ${WORKER_NAME}"

echo "${GITHUB_CLIENT_SECRET}" | npx wrangler secret put GITHUB_CLIENT_SECRET --name "${WORKER_NAME}"
echo "${NEXTAUTH_SECRET}" | npx wrangler secret put NEXTAUTH_SECRET --name "${WORKER_NAME}"
echo "${SERVICE_AUTH_SECRET}" | npx wrangler secret put SERVICE_AUTH_SECRET --name "${WORKER_NAME}"

# Google login is opt-in: only upload the secret when configured. (Disabling
# Google after enabling leaves the old secret in place; delete it manually if needed.)
if [ -n "${GOOGLE_CLIENT_SECRET:-}" ]; then
  echo "${GOOGLE_CLIENT_SECRET}" | npx wrangler secret put GOOGLE_CLIENT_SECRET --name "${WORKER_NAME}"
fi


echo "Secrets uploaded successfully"
