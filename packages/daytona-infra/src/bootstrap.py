"""Construct an immutable Daytona candidate and verify a fresh restore."""

from __future__ import annotations

import os
import sys
import time

from daytona import CreateSandboxFromSnapshotParams, Daytona, DaytonaConfig, DaytonaNotFoundError

from .config import load_config
from .toolchain import create_base_snapshot


def main() -> None:
    config = load_config()
    sys.path.insert(0, str(config.repo_root / "packages/sandbox-images/src"))
    from sandbox_images.bundle import plan_image
    from sandbox_images.native import write_build_result

    plan = plan_image(config.repo_root, "daytona")
    name = (
        os.environ.get("OPENINSPECT_IMAGE_CANDIDATE")
        or f"{config.base_snapshot}-{plan['buildHash'][:12]}-{time.time_ns()}"
    )
    client = Daytona(
        DaytonaConfig(api_key=config.api_key, api_url=config.api_url, target=config.target)
    )
    # No delete/recreate of the selected snapshot, even on a failed build.
    try:
        client.snapshot.get(name)
    except DaytonaNotFoundError:
        create_base_snapshot(client, config.repo_root, name)
    # Retry a retained build by restoring it and checking required services.

    sandbox = client.create(
        CreateSandboxFromSnapshotParams(snapshot=name, env_vars=plan["runtimeEnv"], ephemeral=True),
        timeout=180,
    )
    try:
        result = sandbox.process.exec(
            "/opt/openinspect/python/bin/python /app/verify/smoke_test.py verify",
            timeout=240,
        )
        if result.exit_code != 0:
            raise RuntimeError(f"Daytona image verification failed: {result.result}")
        write_build_result(name)
    finally:
        sandbox.delete()


if __name__ == "__main__":
    main()
