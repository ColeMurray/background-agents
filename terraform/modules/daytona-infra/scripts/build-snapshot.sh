#!/usr/bin/env bash
set -euo pipefail

# Verify required environment variables
if [[ -z "${DAYTONA_API_KEY:-}" ]]; then
    echo "Error: DAYTONA_API_KEY environment variable is not set"
    exit 1
fi

if [[ -z "${DAYTONA_BASE_SNAPSHOT:-}" ]]; then
    echo "Error: DAYTONA_BASE_SNAPSHOT environment variable is not set"
    exit 1
fi

echo "Building Daytona snapshot: ${DAYTONA_BASE_SNAPSHOT}"
echo "Deploy path: ${DEPLOY_PATH}"

cd "${DEPLOY_PATH}" || {
    echo "Error: Failed to change directory to ${DEPLOY_PATH}"
    exit 1
}

uv run --frozen python -m src.bootstrap

echo "Daytona snapshot ${DAYTONA_BASE_SNAPSHOT} built successfully"
