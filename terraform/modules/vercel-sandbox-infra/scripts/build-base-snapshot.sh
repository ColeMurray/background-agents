#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${PROJECT_ROOT:-}" ]]; then
    echo "Error: PROJECT_ROOT environment variable is not set"
    exit 1
fi

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
    echo "Error: VERCEL_TOKEN environment variable is not set"
    exit 1
fi

if [[ -z "${VERCEL_PROJECT_ID:-}" ]]; then
    echo "Error: VERCEL_PROJECT_ID environment variable is not set"
    exit 1
fi

if [[ -z "${VERCEL_BASE_SNAPSHOT_NAME:-}" ]]; then
    echo "Error: VERCEL_BASE_SNAPSHOT_NAME environment variable is not set"
    exit 1
fi

echo "Building Vercel base snapshot: ${VERCEL_BASE_SNAPSHOT_NAME}"
echo "Project root: ${PROJECT_ROOT}"

cd "${PROJECT_ROOT}" || {
    echo "Error: Failed to change directory to ${PROJECT_ROOT}"
    exit 1
}

npm run build:vercel-base-snapshot -w @open-inspect/control-plane

output_file="$(mktemp)"
node packages/control-plane/dist/vercel-base-snapshot.js --output "${output_file}"
snapshot_id="$(tr -d '\r\n' < "${output_file}")"
rm -f "${output_file}"

if [[ -z "${snapshot_id}" ]]; then
    echo "Error: Vercel base snapshot builder did not write a snapshot ID"
    exit 1
fi

echo "Built Vercel base snapshot ${snapshot_id} from ${VERCEL_BASE_SNAPSHOT_NAME}"
