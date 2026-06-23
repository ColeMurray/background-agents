#!/usr/bin/env bash
# Create or update Modal secrets
# Required environment variables:
#   MODAL_TOKEN_ID - Modal API token ID
#   MODAL_TOKEN_SECRET - Modal API token secret
#   MODAL_ENVIRONMENT - Modal environment to create secrets in
#   DEPLOY_PATH - Path to the Modal app source (for uv project resolution)
#   SECRETS_JSON - JSON array of secrets with format:
#     [{"name": "secret-name", "values": {"KEY1": "value1", "KEY2": "value2"}}]

set -euo pipefail

if [[ -z "${MODAL_ENVIRONMENT:-}" ]]; then
    echo "Error: MODAL_ENVIRONMENT environment variable is not set"
    exit 1
fi

echo "Creating/updating Modal secrets in environment: ${MODAL_ENVIRONMENT}"

# Validate SECRETS_JSON is valid JSON
if ! echo "${SECRETS_JSON}" | jq empty 2>/dev/null; then
    echo "Error: SECRETS_JSON is not valid JSON"
    exit 1
fi

# Process each secret
echo "${SECRETS_JSON}" | jq -c '.[]' | while IFS= read -r secret; do
    secret_name=$(echo "${secret}" | jq -r '.name')

    # Validate secret name contains only safe characters
    if [[ ! "${secret_name}" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        echo "Error: Invalid secret name '${secret_name}'. Only alphanumeric, underscore, and hyphen allowed."
        exit 1
    fi

    echo "Processing secret: ${secret_name}"

    # Build array of key=value arguments
    # Use mapfile to safely handle values with special characters
    declare -a args=()

    while IFS= read -r entry; do
        key=$(echo "${entry}" | jq -r '.key')
        value=$(echo "${entry}" | jq -r '.value')

        # Validate key contains only safe characters
        if [[ ! "${key}" =~ ^[a-zA-Z_][a-zA-Z0-9_]*$ ]]; then
            echo "Error: Invalid key name '${key}'. Must be a valid environment variable name."
            exit 1
        fi

        # Add to args array - modal CLI handles the value safely when passed as separate argument
        args+=("${key}=${value}")
    done < <(echo "${secret}" | jq -c '.values | to_entries | .[]')

    # Create or update the secret using array expansion
    # The --force flag will update if it exists
    if uv run --directory "${DEPLOY_PATH}" modal secret create --env "${MODAL_ENVIRONMENT}" "${secret_name}" "${args[@]}" --force; then
        echo "Secret ${secret_name} created/updated successfully"
    else
        echo "Error: Failed to create secret ${secret_name}"
        exit 1
    fi
done

echo "All Modal secrets processed successfully"
