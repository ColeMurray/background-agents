#!/usr/bin/env bash
# Deploy Modal app
# Required environment variables:
#   MODAL_TOKEN_ID - Modal API token ID
#   MODAL_TOKEN_SECRET - Modal API token secret
#   APP_NAME - Name of the app (for logging)
#   DEPLOY_PATH - Path to the Modal app source
#   DEPLOY_MODULE - Module to deploy (e.g., 'deploy' or 'src')

set -euo pipefail

# Resolve modal CLI (Terraform local-exec often has minimal PATH; check common locations)
if [[ -n "${MODAL_CMD:-}" ]]; then
  MODAL_CMD="${MODAL_CMD}"
elif command -v modal &>/dev/null; then
  MODAL_CMD="modal"
elif [[ -x "${HOME:-/invalid}/.local/bin/modal" ]]; then
  MODAL_CMD="${HOME}/.local/bin/modal"
elif [[ -x "/usr/local/bin/modal" ]]; then
  MODAL_CMD="/usr/local/bin/modal"
else
  echo "Error: modal CLI not found. Install with: pipx install modal (or pip install modal)."
  echo "If modal is installed but not on PATH, set MODAL_CMD to its full path before running Terraform."
  exit 1
fi

echo "Deploying Modal app: ${APP_NAME}"
echo "Deploy path: ${DEPLOY_PATH}"
echo "Deploy module: ${DEPLOY_MODULE}"

# Verify required environment variables
if [[ -z "${MODAL_TOKEN_ID:-}" ]]; then
    echo "Error: MODAL_TOKEN_ID environment variable is not set"
    exit 1
fi

if [[ -z "${MODAL_TOKEN_SECRET:-}" ]]; then
    echo "Error: MODAL_TOKEN_SECRET environment variable is not set"
    exit 1
fi

# Change to the deployment directory
cd "${DEPLOY_PATH}" || {
    echo "Error: Failed to change directory to ${DEPLOY_PATH}"
    exit 1
}

# Install deps and deploy using project venv so pydantic etc. are available (pipx modal uses its own Python).
if command -v uv &>/dev/null; then
    uv sync --frozen 2>/dev/null || uv sync
    # uv run uses the project venv so deploy.py can import pydantic
    if [ "${DEPLOY_MODULE}" = "deploy" ]; then
        uv run modal deploy deploy.py || { echo "Error: Modal deployment failed for ${APP_NAME}"; exit 1; }
    elif [ "${DEPLOY_MODULE}" = "src" ]; then
        uv run modal deploy -m src || { echo "Error: Modal deployment failed for ${APP_NAME}"; exit 1; }
    else
        uv run modal deploy "${DEPLOY_MODULE}" || { echo "Error: Modal deployment failed for ${APP_NAME}"; exit 1; }
    fi
else
    if [[ -f pyproject.toml ]]; then
        pip install -e . -q 2>/dev/null || true
    fi
    if [ "${DEPLOY_MODULE}" = "deploy" ]; then
        "${MODAL_CMD}" deploy deploy.py || { echo "Error: Modal deployment failed for ${APP_NAME}"; exit 1; }
    elif [ "${DEPLOY_MODULE}" = "src" ]; then
        "${MODAL_CMD}" deploy -m src || { echo "Error: Modal deployment failed for ${APP_NAME}"; exit 1; }
    else
        "${MODAL_CMD}" deploy "${DEPLOY_MODULE}" || { echo "Error: Modal deployment failed for ${APP_NAME}"; exit 1; }
    fi
fi

echo "Modal app ${APP_NAME} deployed successfully"
