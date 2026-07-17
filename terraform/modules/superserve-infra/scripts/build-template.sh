#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${PROJECT_ROOT:-}" ]]; then
    echo "Error: PROJECT_ROOT environment variable is not set"
    exit 1
fi

if [[ -z "${SUPERSERVE_API_URL:-}" ]]; then
    echo "Error: SUPERSERVE_API_URL environment variable is not set"
    exit 1
fi

if [[ -z "${SUPERSERVE_API_KEY:-}" ]]; then
    echo "Error: SUPERSERVE_API_KEY environment variable is not set"
    exit 1
fi

if [[ -z "${SUPERSERVE_TEMPLATE:-}" ]]; then
    echo "Error: SUPERSERVE_TEMPLATE environment variable is not set"
    exit 1
fi

cd "${PROJECT_ROOT}"

export OPENINSPECT_RUNTIME_GIT_REF="${OPENINSPECT_RUNTIME_GIT_REF:-$(git rev-parse HEAD)}"
npm run build -w @open-inspect/superserve-infra
node packages/superserve-infra/dist/build-template.js
