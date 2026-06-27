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

# Build the bundle, then run it directly from the repo root (mirrors the sibling Vercel builder,
# terraform/modules/vercel-sandbox-infra). We've cd'd into the repo, so cwd is the repo root;
# running `node <dist>` from here keeps cwd at the root, which is how build-template.ts resolves
# the sandbox-runtime source.
# (Running the builder via `npm -w` instead would move cwd into packages/opencomputer-infra and
# mis-resolve the runtime dir.) build-template.ts reads OPENCOMPUTER_API_URL /
# OPENCOMPUTER_API_KEY / OPENCOMPUTER_TEMPLATE from the env and creates the snapshot under that
# exact name; the image is content-addressed (image.cacheKey()) so an unchanged rebuild is cheap.
npm run build -w @open-inspect/opencomputer-infra
node packages/opencomputer-infra/dist/build-template.js

echo "Built OpenComputer base snapshot ${OPENCOMPUTER_TEMPLATE}"
