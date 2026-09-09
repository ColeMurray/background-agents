#!/usr/bin/env bash
set -euo pipefail
python_bin=/opt/openinspect/python/bin/python
/opt/openinspect/uv/uv pip install --python "$python_bin" --require-hashes \
  -r "$OI_BUNDLE/packages/sandbox-images/locks/runtime.txt"
/opt/openinspect/uv/uv venv --python "$python_bin" /opt/openinspect/python-tools
/opt/openinspect/uv/uv pip install --python /opt/openinspect/python-tools/bin/python --require-hashes \
  -r "$OI_BUNDLE/packages/sandbox-images/locks/python-tools.txt"
ln -sf /opt/openinspect/python-tools/bin/websockify /usr/local/bin/websockify
wheel_dir="$(mktemp -d /tmp/openinspect-wheel.XXXXXX)"
trap 'rm -rf "$wheel_dir"' EXIT
/opt/openinspect/uv/uv build --wheel --no-build-isolation --python /opt/openinspect/python-tools/bin/python \
  --out-dir "$wheel_dir" "$OI_BUNDLE/packages/sandbox-runtime"
/opt/openinspect/uv/uv pip install --python "$python_bin" --no-deps "$wheel_dir/"*.whl
mkdir -p /app
runtime_path="$($python_bin -c 'import sandbox_runtime; print(sandbox_runtime.__path__[0])')"
ln -s "$runtime_path" /app/sandbox_runtime
