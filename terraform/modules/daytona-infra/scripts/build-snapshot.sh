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

# Install Daytona SDK (the only runtime dependency for bootstrap).
# Pin the version to avoid surprise breakage from SDK changes.
pip install --user -q 'daytona==0.161.0'

# --force deletes the existing snapshot before rebuilding,
# ensuring the create call succeeds even if the name is taken.
python -m src.bootstrap --force

echo "Daytona snapshot ${DAYTONA_BASE_SNAPSHOT} built successfully"
