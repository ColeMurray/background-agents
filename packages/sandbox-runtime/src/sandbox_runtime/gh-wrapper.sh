#!/bin/sh
REAL_GH="/usr/bin/gh"
token=$(python3 -m sandbox_runtime.credentials.git_credential_helper gh-token || true)
if [ -n "$token" ]; then
  export GH_TOKEN="$token"
fi
exec "$REAL_GH" "$@"
