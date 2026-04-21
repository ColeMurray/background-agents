#!/usr/bin/env bash
# Deploy Modal app
# Required environment variables:
#   MODAL_TOKEN_ID - Modal API token ID
#   MODAL_TOKEN_SECRET - Modal API token secret
#   APP_NAME - Name of the app (for logging)
#   DEPLOY_PATH - Path to the Modal app source
#   DEPLOY_MODULE - Module to deploy (e.g., 'deploy' or 'src')

set -euo pipefail

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

if ! command -v uv >/dev/null 2>&1; then
    echo "Error: uv is required to deploy ${APP_NAME}. Install uv, then run 'cd ${DEPLOY_PATH} && uv sync --frozen'."
    exit 1
fi

if [[ ! -f "pyproject.toml" ]]; then
    echo "Error: Expected pyproject.toml in ${DEPLOY_PATH}."
    exit 1
fi

# Ensure Python dependencies are installed (includes sandbox-runtime)
uv sync --frozen

# Deploy using Modal CLI (via uv to use the project's virtual environment)
if [ "${DEPLOY_MODULE}" = "deploy" ]; then
    # Method 1: Use deploy.py wrapper (recommended)
    uv run modal deploy deploy.py || {
        echo "Error: Modal deployment failed for ${APP_NAME}"
        exit 1
    }
elif [ "${DEPLOY_MODULE}" = "src" ]; then
    # Method 2: Deploy the src package directly
    uv run modal deploy -m src || {
        echo "Error: Modal deployment failed for ${APP_NAME}"
        exit 1
    }
else
    # Generic deployment
    uv run modal deploy "${DEPLOY_MODULE}" || {
        echo "Error: Modal deployment failed for ${APP_NAME}"
        exit 1
    }
fi

echo "Modal app ${APP_NAME} deployed successfully"
