#!/usr/bin/env python3
"""Build and verify an E2B template using the provider-neutral image bundle."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

from e2b import Sandbox, Template, default_build_logger

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/sandbox-images/src"))

from sandbox_images.bundle import pack_bundle, plan_image  # noqa: E402
from sandbox_images.native import write_build_result  # noqa: E402

START_CMD = "sleep infinity"
READY_CMD = "/opt/openinspect/python/bin/python -I -c 'import sandbox_runtime'"


def main() -> None:
    name = os.environ.get("E2B_TEMPLATE_ID")
    api_key = os.environ.get("E2B_API_KEY")
    if not name or not api_key:
        raise RuntimeError("E2B_TEMPLATE_ID and E2B_API_KEY are required")
    cpu = int(os.environ.get("E2B_TEMPLATE_CPU", "2"))
    memory_mb = int(os.environ.get("E2B_TEMPLATE_MEMORY_MB", "4096"))
    if cpu < 1 or memory_mb < 2 or memory_mb % 2:
        raise ValueError("E2B template CPU must be positive and memory a positive even number")
    plan = plan_image(ROOT, "e2b")
    name = (
        os.environ.get("OPENINSPECT_IMAGE_CANDIDATE")
        or f"{name}-{plan['buildHash'][:12]}-{time.time_ns()}"
    )
    bundle = pack_bundle(ROOT, "e2b", ROOT / ".cache/sandbox-images")
    template = (
        Template(file_context_path=bundle)
        .from_dockerfile("FROM " + plan["target"]["base"])
        .copy(".", "/tmp/openinspect-image", user="root")
        .run_cmd(
            "bash /tmp/openinspect-image/packages/sandbox-images/install/install.sh", user="root"
        )
        .set_user("user")
        .set_workdir("/workspace")
        .set_start_cmd(START_CMD, READY_CMD)
    )
    existing = None
    if Template.exists(name, api_key=api_key, api_url=os.environ.get("E2B_API_URL")):
        existing = name
    build = (
        None
        if existing
        else Template.build(
            template,
            name,
            api_key=api_key,
            api_url=os.environ.get("E2B_API_URL"),
            cpu_count=cpu,
            memory_mb=memory_mb,
            on_build_logs=default_build_logger(min_level="info"),
        )
    )
    # A fresh spawn both verifies the final native artifact and prewarms it.
    sandbox = Sandbox.create(
        template=existing or build.template_id,
        api_key=api_key,
        api_url=os.environ.get("E2B_API_URL"),
        timeout=300,
        envs=plan["runtimeEnv"],
        metadata={
            "purpose": "openinspect-image-verification",
        },
    )
    try:
        result = sandbox.commands.run(
            "/opt/openinspect/python/bin/python /app/verify/smoke_test.py verify",
            timeout=240,
            user="root",
        )
        if result.exit_code != 0:
            raise RuntimeError("E2B image verification failed")
        write_build_result(existing or build.template_id)
    finally:
        sandbox.kill()


if __name__ == "__main__":
    main()
