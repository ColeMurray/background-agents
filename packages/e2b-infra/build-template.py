#!/usr/bin/env python3
"""
Build (and pre-warm) the Open-Inspect E2B sandbox template — programmatically,
via the E2B Python SDK. Authenticates with the runtime API key (E2B_API_KEY).

The base image layers live in e2b.Dockerfile (FROM + apt/npm/pip); this script
adds the context-dependent steps the SDK owns: copying the staged sandbox_runtime
and the oi-launch launcher, the workdir, and the start/ready commands.

Env:
  E2B_TEMPLATE_ID   (required) — template name to create/rebuild.
  E2B_API_KEY       (required) — runtime API key; authenticates the build AND
                                 the post-build pre-warm.
  E2B_API_URL       (optional) — REST API base URL (default https://api.e2b.app).
  E2B_TEMPLATE_CPU  (optional) — vCPU count (default 2).
  E2B_TEMPLATE_MEM  (optional) — memory MB, even number (default 1024).
"""

import os
import shutil
import sys
import urllib.request
import urllib.error
import json
import atexit
from pathlib import Path

from e2b import Template, default_build_logger

SCRIPT_DIR = Path(__file__).parent.resolve()

TEMPLATE_ID = os.environ.get("E2B_TEMPLATE_ID")
API_KEY = os.environ.get("E2B_API_KEY")
API_URL = os.environ.get("E2B_API_URL", "https://api.e2b.app").rstrip("/")
CPU = int(os.environ.get("E2B_TEMPLATE_CPU", "2"))
MEM = int(os.environ.get("E2B_TEMPLATE_MEM", "1024"))

# Start command = the launcher. E2B runs the start command once at build,
# snapshots it, and resumes it per create, so the launcher waits for the control
# plane to drop the per-session env file then execs the supervisor. Ready command
# just confirms the baked toolchain is present — real session readiness is tracked
# by the control plane when the bridge phones home.
START_CMD = "python /usr/local/bin/oi-launch"
READY_CMD = (
    "command -v python && command -v node && command -v opencode "
    "&& command -v code-server "
    '&& test "$(command -v gh)" = /usr/local/bin/gh && test -x /usr/bin/gh '
    "&& PYTHONPATH=/app python -c 'import sandbox_runtime'"
)

if not TEMPLATE_ID:
    print("Error: E2B_TEMPLATE_ID is not set", file=sys.stderr)
    sys.exit(1)
if not API_KEY:
    print(
        "Error: E2B_API_KEY is not set",
        file=sys.stderr,
    )
    sys.exit(1)

RUNTIME_SRC = SCRIPT_DIR.parent / "sandbox-runtime" / "src" / "sandbox_runtime"
STAGED = SCRIPT_DIR / "sandbox_runtime"

if not RUNTIME_SRC.exists():
    print(f"Error: sandbox-runtime not found at {RUNTIME_SRC}", file=sys.stderr)
    sys.exit(1)

print(f"Staging sandbox_runtime from {RUNTIME_SRC}")
if STAGED.exists():
    shutil.rmtree(STAGED)


def _ignore_pycache(src: str, names: list[str]) -> list[str]:
    return [n for n in names if n == "__pycache__" or n.endswith(".pyc")]


shutil.copytree(RUNTIME_SRC, STAGED, ignore=_ignore_pycache)
atexit.register(lambda: shutil.rmtree(STAGED, ignore_errors=True))

dockerfile = (SCRIPT_DIR / "e2b.Dockerfile").read_text()

print(f"Building E2B template: {TEMPLATE_ID} (cpu={CPU}, mem={MEM})")

template = (
    Template().from_dockerfile(dockerfile)
    # Staged into this dir above; imported via PYTHONPATH=/app as `sandbox_runtime`.
    .copy("sandbox_runtime", "/app/sandbox_runtime")
    # The launcher = the template start command (see oi-launch.py).
    .copy("oi-launch.py", "/usr/local/bin/oi-launch", mode=0o755)
    .set_workdir("/workspace")
    .set_start_cmd(START_CMD, READY_CMD)
)

Template.build(
    template,
    TEMPLATE_ID,
    api_key=API_KEY,
    cpu_count=CPU,
    memory_mb=MEM,
    # E2B's built-in logger: elapsed-time + level-aligned lines; degrades to
    # plain text (no ANSI/animation) in the non-TTY Terraform/CI build context.
    on_build_logs=default_build_logger(min_level="info"),
)
print(f"E2B template {TEMPLATE_ID} built successfully")

# Pre-warm: spawn one sandbox from the fresh build and kill it. Works around a
# vendor-confirmed E2B bug where the first spawn of a new template build is much
# slower than subsequent ones — pre-warming here means no user session pays it.
try:
    print(f"Pre-warming template {TEMPLATE_ID}")
    headers = {"X-API-Key": API_KEY, "Content-Type": "application/json"}
    req = urllib.request.Request(
        f"{API_URL}/sandboxes",
        data=json.dumps(
            {"templateID": TEMPLATE_ID, "timeout": 60, "metadata": {"purpose": "template-prewarm"}}
        ).encode(),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        sandbox_id = json.loads(resp.read())["sandboxID"]
    try:
        del_req = urllib.request.Request(
            f"{API_URL}/sandboxes/{sandbox_id}", headers=headers, method="DELETE"
        )
        urllib.request.urlopen(del_req, timeout=10)
    except Exception:
        pass
    print(f"Pre-warm complete (sandbox {sandbox_id})")
except Exception as exc:
    print(f"Warning: pre-warm failed; first user session will be slow: {exc}", file=sys.stderr)
