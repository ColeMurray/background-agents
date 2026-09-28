#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${BOAT_BUILD_API_KEY:-}" ]]; then
  echo "Error: BOAT_BUILD_API_KEY is required" >&2
  exit 1
fi
if [[ -z "${OPENINSPECT_IMAGE_CANDIDATE:-}" ]]; then
  echo "Error: OPENINSPECT_IMAGE_CANDIDATE is required" >&2
  exit 1
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "Error: uv is required to build ${OPENINSPECT_IMAGE_CANDIDATE}" >&2
  exit 1
fi

cd "${DEPLOY_PATH}"
uv sync --frozen
uv run --frozen python build_template.py
