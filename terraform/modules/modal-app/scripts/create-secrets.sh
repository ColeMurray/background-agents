#!/usr/bin/env bash
# Create or update Modal secrets
# Required environment variables:
#   MODAL_TOKEN_ID - Modal API token ID
#   MODAL_TOKEN_SECRET - Modal API token secret
#   SECRETS_JSON_B64 - Base64-encoded JSON array of secrets with format:
#     [{"name": "secret-name", "values": {"KEY1": "value1", "KEY2": "value2"}}]

set -euo pipefail

echo "Creating/updating Modal secrets..."

# Decode base64 and write JSON to a temp file
SECRETS_FILE=$(mktemp)
trap "rm -f '$SECRETS_FILE'" EXIT
echo "${SECRETS_JSON_B64}" | base64 -d > "$SECRETS_FILE"

# Validate SECRETS_JSON is valid JSON
if ! jq empty "$SECRETS_FILE" 2>&1; then
    echo "Error: SECRETS_JSON is not valid JSON"
    echo "Debug: File size: $(wc -c < "$SECRETS_FILE") bytes"
    echo "Debug: First 500 chars:"
    head -c 500 "$SECRETS_FILE"
    echo ""
    echo "Debug: Last 200 chars:"
    tail -c 200 "$SECRETS_FILE"
    echo ""
    echo "Debug: jq error:"
    jq empty "$SECRETS_FILE" 2>&1 || true
    exit 1
fi

# Process each secret
jq -c '.[]' "$SECRETS_FILE" | while IFS= read -r secret; do
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
    if modal secret create "${secret_name}" "${args[@]}" --force; then
        echo "Secret ${secret_name} created/updated successfully"
    else
        echo "Warning: Failed to create secret ${secret_name}"
    fi
done

echo "All Modal secrets processed successfully"
