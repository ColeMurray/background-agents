#!/usr/bin/env python3
"""Build-time proof that the clean execution artifact contains no agent surface."""

import json
import pwd
import shutil
import stat
from pathlib import Path

manifest = json.loads(Path("/app/execution-artifact-manifest.json").read_text())
plan = json.loads(Path("/app/openinspect-build-config.json").read_text())
assert manifest["runtimeGeneration"] >= 78
assert manifest["commandUid"] == 10001
assert manifest["commandGid"] == 10001
account = pwd.getpwnam("openinspect-exec")
assert (account.pw_uid, account.pw_gid) == (10001, 10001)
assert stat.S_IMODE(Path("/workspace").stat().st_mode) == 0o700
assert Path("/workspace").stat().st_uid == 10001
assert not (Path("/opt/openinspect").stat().st_mode & 0o022)
for forbidden in (
    "opencode",
    "code-server",
    "ttyd",
    "websockify",
    "x11vnc",
    "novnc_proxy",
    "google-chrome",
):
    assert shutil.which(forbidden) is None, forbidden
assert not any(Path("/root/.cache").iterdir())
print(json.dumps({"artifact": manifest["artifactVersion"], "buildHash": plan["buildHash"]}))
