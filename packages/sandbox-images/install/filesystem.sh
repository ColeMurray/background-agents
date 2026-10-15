#!/usr/bin/env bash
set -euo pipefail
if ! id "$OI_RUNTIME_USER" >/dev/null 2>&1; then
  useradd --create-home --home-dir "$OI_RUNTIME_HOME" --shell /bin/bash "$OI_RUNTIME_USER"
fi
if [[ "$OI_PROVIDER" == opencomputer ]]; then
  # v2 checkpoints archive /home/sandbox only. Keep the stable application path
  # inside that archive, and fail if a nonempty workspace would be displaced.
  mkdir -p "$OI_RUNTIME_HOME/workspace"
  chown -R "$OI_RUNTIME_USER:$(id -gn "$OI_RUNTIME_USER")" "$OI_RUNTIME_HOME/workspace"
  if [[ -L /workspace ]]; then
    [[ "$(readlink /workspace)" == "$OI_RUNTIME_HOME/workspace" ]] || { echo 'Unexpected workspace link' >&2; exit 1; }
  else
    if [[ -d /workspace ]]; then rmdir /workspace; fi
    ln -s "$OI_RUNTIME_HOME/workspace" /workspace
  fi
fi
mkdir -p /workspace /tmp/opencode /app/plugins /app/verify \
  "$OI_RUNTIME_HOME/.local/bin" "$OI_RUNTIME_HOME/.npm-global" "$OI_RUNTIME_HOME/.npm-cache" \
  "$OI_RUNTIME_HOME/.config/opencode" "$OI_RUNTIME_HOME/.cache/openinspect/scm" \
  "$OI_RUNTIME_HOME/.agent-browser"
# Configure only newly built images; do not inject a new Chrome path into legacy snapshots.
cp "$OI_INSTALL_DIR/agent-browser.json" "$OI_RUNTIME_HOME/.agent-browser/config.json"
if [[ "$OI_PROVIDER" == opencomputer ]]; then
  # Lambda's no_new_privs guest cannot use Chrome's setuid sandbox. Container
  # auto-detection in agent-browser does not identify this MicroVM substrate.
  /opt/openinspect/python/bin/python - "$OI_RUNTIME_HOME/.agent-browser/config.json" <<'PY'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
config = json.loads(path.read_text())
config["args"] = "--no-sandbox --disable-dev-shm-usage"
path.write_text(json.dumps(config))
PY
fi
cp -a /app/opencode-deps/. "$OI_RUNTIME_HOME/.config/opencode/"
install -m 0755 /app/sandbox_runtime/gh-wrapper.sh /usr/local/bin/gh
printf '%s\n' '#!/bin/sh' 'exec python3 -m sandbox_runtime.credentials.git_credential_helper "$@"' > /usr/local/bin/oi-git-credentials
chmod 0755 /usr/local/bin/oi-git-credentials
git config --system credential.helper /usr/local/bin/oi-git-credentials
git config --system credential.useHttpPath true
cp "$OI_BUNDLE/packages/sandbox-images/verify/smoke_test.py" /app/verify/smoke_test.py
cp "$OI_BUNDLE/build-config.json" /app/openinspect-build-config.json
cp "$OI_BUNDLE/packages/sandbox-images/toolchain.json" /app/openinspect-toolchain.json
# Best-effort: without a cached catalog OpenCode uses the one compiled into its binary.
HOME="$OI_RUNTIME_HOME" timeout 120 opencode models --refresh >/dev/null 2>&1 \
  || echo "OpenCode model catalog refresh failed; keeping OpenCode's built-in catalog" >&2
chown -R "$OI_RUNTIME_USER:$(id -gn "$OI_RUNTIME_USER")" /workspace /tmp/opencode /app/plugins \
  "$OI_RUNTIME_HOME/.local" "$OI_RUNTIME_HOME/.npm-global" "$OI_RUNTIME_HOME/.npm-cache" \
  "$OI_RUNTIME_HOME/.config" "$OI_RUNTIME_HOME/.cache" "$OI_RUNTIME_HOME/.agent-browser"

/opt/openinspect/python/bin/python -c 'import json; from pathlib import Path; plan = json.loads(Path("/app/openinspect-build-config.json").read_text()); Path("/app/openinspect-runtime-environment.json").write_text(json.dumps(plan["runtimeEnv"]))'
