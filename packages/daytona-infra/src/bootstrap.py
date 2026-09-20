"""Publish an immutable Daytona OCI candidate and verify two allocations."""

from __future__ import annotations

import shutil
import sys
import time

from daytona import Daytona, DaytonaConfig

from .config import load_config
from .toolchain import publish_image, verify_image


def main() -> None:
    config = load_config()
    sys.path.insert(0, str(config.repo_root / "packages/sandbox-images/src"))
    from sandbox_images.bundle import pack_bundle
    from sandbox_images.native import write_build_result

    bundle = pack_bundle(config.repo_root, "daytona", config.repo_root / ".cache/sandbox-images")
    try:
        plan = bundle.plan
        candidate = f"candidate-{plan['buildHash'][:12]}-{time.time_ns()}"
        client = Daytona(
            DaytonaConfig(api_key=config.api_key, api_url=config.api_url, target=config.target)
        )
        reference = publish_image(bundle, config.image_repository, candidate)
        for memory_gib in (2, 4):
            verify_image(client, reference, memory_gib)
        write_build_result(reference)
    finally:
        shutil.rmtree(bundle.directory)


if __name__ == "__main__":
    main()
