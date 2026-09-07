#!/usr/bin/env bash
set -euo pipefail
if ! id "$OI_RUNTIME_USER" >/dev/null 2>&1; then
  useradd --create-home --home-dir "$OI_RUNTIME_HOME" --shell /bin/bash "$OI_RUNTIME_USER"
fi
mkdir -p /workspace /tmp/opencode /app/plugins /app/verify \
  "$OI_RUNTIME_HOME/.local/bin" "$OI_RUNTIME_HOME/.npm-global" "$OI_RUNTIME_HOME/.npm-cache" \
  "$OI_RUNTIME_HOME/.config/opencode" "$OI_RUNTIME_HOME/.cache/openinspect/scm" \
  "$OI_RUNTIME_HOME/.agent-browser"
# Configure only newly built images; do not inject a new Chrome path into legacy snapshots.
cp "$OI_INSTALL_DIR/agent-browser.json" "$OI_RUNTIME_HOME/.agent-browser/config.json"
cp -a /app/opencode-deps/. "$OI_RUNTIME_HOME/.config/opencode/"
install -m 0755 /app/sandbox_runtime/gh-wrapper.sh /usr/local/bin/gh
printf '%s\n' '#!/bin/sh' 'exec python3 -m sandbox_runtime.credentials.git_credential_helper "$@"' > /usr/local/bin/oi-git-credentials
chmod 0755 /usr/local/bin/oi-git-credentials
git config --system credential.helper /usr/local/bin/oi-git-credentials
git config --system credential.useHttpPath true
cp "$OI_BUNDLE/packages/sandbox-images/verify/smoke_test.py" /app/verify/smoke_test.py
cp "$OI_BUNDLE/build-config.json" /app/openinspect-build-config.json
cp "$OI_BUNDLE/packages/sandbox-images/toolchain.json" /app/openinspect-toolchain.json
chown -R "$OI_RUNTIME_USER:$(id -gn "$OI_RUNTIME_USER")" /workspace /tmp/opencode /app/plugins \
  "$OI_RUNTIME_HOME/.local" "$OI_RUNTIME_HOME/.npm-global" "$OI_RUNTIME_HOME/.npm-cache" \
  "$OI_RUNTIME_HOME/.config" "$OI_RUNTIME_HOME/.cache" "$OI_RUNTIME_HOME/.agent-browser"

/opt/openinspect/python/bin/python -c 'import json; from pathlib import Path; plan = json.loads(Path("/app/openinspect-build-config.json").read_text()); Path("/app/openinspect-runtime-environment.json").write_text(json.dumps(plan["runtimeEnv"]))'
