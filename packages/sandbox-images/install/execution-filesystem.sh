#!/usr/bin/env bash
set -euo pipefail

groupadd --gid 10001 openinspect-exec
useradd --uid 10001 --gid 10001 --home-dir /home/openinspect-exec --create-home --shell /bin/bash openinspect-exec
install -d -m 0700 -o openinspect-exec -g openinspect-exec /workspace /home/openinspect-exec/.cache
install -d -m 0700 -o root -g root /run/open-inspect
install -d -m 0700 -o root -g root /app/verify
install -m 0600 "$OI_BUNDLE/packages/sandbox-images/verify/execution_smoke.py" /app/verify/execution_smoke.py
install -m 0600 "$OI_BUNDLE/build-config.json" /app/openinspect-build-config.json
install -m 0600 "$OI_BUNDLE/packages/sandbox-runtime/src/sandbox_runtime/execution_artifact_manifest.json" /app/execution-artifact-manifest.json
rm -rf /opt/openinspect/python-tools
rm -f /usr/local/bin/websockify
find /opt/openinspect -type d -exec chmod go-w {} +
find /opt/openinspect -type f -exec chmod go-w {} +
runtime_package="$(find /opt/openinspect/python/lib -type d -path '*/site-packages/sandbox_runtime' -print -quit)"
if [[ -z "$runtime_package" ]]; then
  echo 'sandbox_runtime package not found in execution artifact' >&2
  exit 1
fi
chmod -R go-rwx "$runtime_package"
rm -rf /root/.cache/* /tmp/*
