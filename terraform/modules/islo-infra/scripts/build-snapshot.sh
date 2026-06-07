#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${ISLO_API_KEY:-}" ]]; then
    echo "Error: ISLO_API_KEY environment variable is not set"
    exit 1
fi

if [[ -z "${ISLO_BASE_SNAPSHOT:-}" ]]; then
    echo "Error: ISLO_BASE_SNAPSHOT environment variable is not set"
    exit 1
fi

echo "Building Islo snapshot: ${ISLO_BASE_SNAPSHOT}"
echo "Deploy path: ${DEPLOY_PATH}"

cd "${DEPLOY_PATH}" || {
    echo "Error: Failed to change directory to ${DEPLOY_PATH}"
    exit 1
}

npm install --silent
npm run bootstrap -- --force

echo "Islo snapshot ${ISLO_BASE_SNAPSHOT} built successfully"
