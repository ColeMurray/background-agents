#!/usr/bin/env bash
# Build the Open-Inspect Boat base snapshot through the Boat REST API.
# Mirrors terraform/modules/daytona-infra/scripts/build-snapshot.sh.
#
# Delegates to packages/boat-infra/build-template.py — the same script used
# for manual/local builds (single source of truth).
set -euo pipefail

if [[ -z "${BOAT_API_KEY:-}" ]]; then
  echo "Error: BOAT_API_KEY is not set (required to build and verify the snapshot)" >&2
  exit 1
fi
if [[ -z "${BOAT_BASE_SNAPSHOT:-}" ]]; then
  echo "Error: BOAT_BASE_SNAPSHOT is not set" >&2
  exit 1
fi

echo "Building Boat saved snapshot: ${OPENINSPECT_IMAGE_CANDIDATE:-$BOAT_BASE_SNAPSHOT}"
echo "Deploy path: ${DEPLOY_PATH}"

cd "${DEPLOY_PATH}" || {
  echo "Error: failed to cd to ${DEPLOY_PATH}" >&2
  exit 1
}

# The builder needs only the standard library; uv still pins the interpreter
# the same way it does for the other provider builds.
if ! command -v uv >/dev/null 2>&1; then
  echo "Error: uv is required to build the Boat snapshot. Install uv, then run 'cd ${DEPLOY_PATH} && uv sync --frozen'." >&2
  exit 1
fi

uv sync --frozen
uv run --frozen python build-template.py

echo "Boat saved snapshot ${OPENINSPECT_IMAGE_CANDIDATE:-$BOAT_BASE_SNAPSHOT} built successfully"
