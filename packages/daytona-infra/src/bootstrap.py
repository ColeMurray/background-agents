"""Construct an immutable Daytona candidate and verify a fresh restore."""

from __future__ import annotations

import json
import os
import sys
import time

from daytona import CreateSandboxFromSnapshotParams, Daytona, DaytonaConfig

from .config import load_config
from .toolchain import create_base_snapshot


def main() -> None:
    config = load_config()
    sys.path.insert(0, str(config.repo_root / "packages/sandbox-images/src"))
    from sandbox_images.bundle import plan_image
    from sandbox_images.releases import candidate_record, write_candidate

    plan = plan_image(config.repo_root, "daytona")
    existing = os.environ.get("OPENINSPECT_VERIFY_REFERENCE")
    name = (
        existing
        or os.environ.get("OPENINSPECT_IMAGE_CANDIDATE")
        or f"{config.base_snapshot}-{plan['recipeDigest'][:12]}-{time.time_ns()}"
    )
    client = Daytona(
        DaytonaConfig(api_key=config.api_key, api_url=config.api_url, target=config.target)
    )
    # No delete/recreate of the selected snapshot, even on a failed build.
    if not existing:
        create_base_snapshot(client, config.repo_root, name)
    sandbox = client.create(
        CreateSandboxFromSnapshotParams(snapshot=name, env_vars=plan["runtimeEnv"], ephemeral=True),
        timeout=180,
    )
    try:
        result = sandbox.process.exec(
            "/opt/openinspect/python/bin/python /app/verify/image.py verify --expected-recipe "
            + os.environ.get("OPENINSPECT_EXPECTED_RECIPE", plan["recipeDigest"]),
            timeout=240,
        )
        if result.exit_code != 0:
            raise RuntimeError(f"Daytona image verification failed: {result.result}")
        report = json.loads(result.result.strip().splitlines()[-1])
        scope = f"{config.api_url or 'https://app.daytona.io/api'}#{config.target or 'default'}"
        write_candidate(candidate_record("daytona", scope, name, report))
    finally:
        sandbox.delete()


if __name__ == "__main__":
    main()
