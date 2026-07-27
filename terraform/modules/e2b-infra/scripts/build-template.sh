#!/usr/bin/env bash
# Build the Open-Inspect E2B sandbox template via the E2B Python SDK.
# Mirrors terraform/modules/daytona-infra/scripts/build-snapshot.sh.
#
# Installs the e2b Python package, then delegates to
# packages/e2b-infra/build-template.py — the same script used for
# manual/local builds (single source of truth).
set -euo pipefail

if [[ -z "${E2B_API_KEY:-}" ]]; then
  echo "Error: E2B_API_KEY is not set (required to build + pre-warm the template)" >&2
  exit 1
fi
if [[ -z "${E2B_TEMPLATE_ID:-}" ]]; then
  echo "Error: E2B_TEMPLATE_ID is not set" >&2
  exit 1
fi

echo "Building E2B template: ${E2B_TEMPLATE_ID}"
echo "Deploy path: ${DEPLOY_PATH}"

cd "${DEPLOY_PATH}" || {
  echo "Error: failed to cd to ${DEPLOY_PATH}" >&2
  exit 1
}

# Install Python deps via uv (mirrors terraform/modules/modal-app/scripts/deploy.sh).
# uv provisions an isolated, project-local .venv, avoiding writes to the
# read-only system/Nix Python that break a plain `pip install`.
if ! command -v uv >/dev/null 2>&1; then
  echo "Error: uv is required to build ${E2B_TEMPLATE_ID}. Install uv, then run 'cd ${DEPLOY_PATH} && uv sync --frozen'." >&2
  exit 1
fi
if [[ ! -f "pyproject.toml" ]]; then
  echo "Error: Expected pyproject.toml in ${DEPLOY_PATH}." >&2
  exit 1
fi

uv sync --frozen

# build-template.py reads E2B_TEMPLATE_ID / E2B_API_KEY / E2B_API_URL /
# E2B_TEMPLATE_CPU / E2B_TEMPLATE_MEM from the environment.
uv run python build-template.py

echo "E2B template ${E2B_TEMPLATE_ID} built successfully"
