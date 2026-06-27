#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${PROJECT_ROOT:-}" ]]; then
    echo "Error: PROJECT_ROOT environment variable is not set"
    exit 1
fi

if [[ -z "${OPENCOMPUTER_API_URL:-}" ]]; then
    echo "Error: OPENCOMPUTER_API_URL environment variable is not set"
    exit 1
fi

if [[ -z "${OPENCOMPUTER_API_KEY:-}" ]]; then
    echo "Error: OPENCOMPUTER_API_KEY environment variable is not set"
    exit 1
fi

if [[ -z "${OPENCOMPUTER_TEMPLATE:-}" ]]; then
    echo "Error: OPENCOMPUTER_TEMPLATE environment variable is not set"
    exit 1
fi

echo "Building OpenComputer base snapshot: ${OPENCOMPUTER_TEMPLATE}"
echo "Project root: ${PROJECT_ROOT}"

cd "${PROJECT_ROOT}" || {
    echo "Error: Failed to change directory to ${PROJECT_ROOT}"
    exit 1
}

# build-template.ts reads OPENCOMPUTER_API_URL / OPENCOMPUTER_API_KEY / OPENCOMPUTER_TEMPLATE
# from the environment and creates the snapshot under that exact name. The image is
# content-addressed (image.cacheKey()), so an unchanged source rebuild is a cheap no-op.
OPENINSPECT_REPO_ROOT="${PROJECT_ROOT}" npm run build:opencomputer-template

echo "Built OpenComputer base snapshot ${OPENCOMPUTER_TEMPLATE}"
