"""Publish and natively verify the shared Daytona OCI runtime image."""

from __future__ import annotations

import json
import re
import subprocess
import sys
import time
from typing import TYPE_CHECKING

from daytona import CreateSandboxFromImageParams, Daytona, DaytonaNotFoundError, Resources

if TYPE_CHECKING:
    from collections.abc import Callable

    from sandbox_images.bundle import PackedBundle


DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
REFERENCE = re.compile(
    r"^(?:localhost(?::[0-9]+)?|[a-z0-9.-]+\.[a-z0-9.-]+(?::[0-9]+)?)/"
    r"[a-z0-9]+(?:[._-][a-z0-9]+)*(?:/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$"
)


def publish_image(
    bundle: PackedBundle,
    repository: str,
    candidate: str,
    *,
    run: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run,
) -> str:
    """Push once and return the manifest digest reported by that build."""
    if not REFERENCE.fullmatch(repository) or "@" in repository:
        raise ValueError("DAYTONA_IMAGE_REPOSITORY must be a registry-qualified repository")
    metadata = bundle.directory / "build-metadata.json"
    reference = f"{repository}:{candidate}"
    build_arguments = [
        argument
        for key, value in bundle.plan["runtimeEnv"].items()
        for argument in ("--build-arg", f"OI_ENV_{key.upper()}={value}")
    ]
    run(
        [
            "docker",
            "buildx",
            "build",
            "--platform",
            "linux/amd64",
            "--target",
            "daytona-runtime",
            "--build-arg",
            f"BASE_IMAGE={bundle.plan['target']['base']}",
            "--build-arg",
            f"SANDBOX_VERSION={bundle.plan['runtimeVersion']}",
            *build_arguments,
            "--push",
            "--metadata-file",
            str(metadata),
            "-f",
            str(bundle.directory / "packages/sandbox-images/Dockerfile"),
            "-t",
            reference,
            str(bundle.directory),
        ],
        check=True,
        text=True,
    )
    digest = json.loads(metadata.read_text()).get("containerimage.digest")
    if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
        raise RuntimeError("Docker build did not report an exact pushed manifest digest")
    return f"{repository}@{digest}"


def verify_image(daytona: Daytona, reference: str, memory_gib: int) -> None:
    name = f"openinspect-oci-verify-{memory_gib}g-{time.time_ns()}"
    sandbox = None
    primary_error: BaseException | None = None
    try:
        sandbox = daytona.create(
            CreateSandboxFromImageParams(
                name=name,
                image=reference,
                resources=Resources(cpu=1, memory=memory_gib),
                env_vars={"OI_DEFERRED_START": "true"},
                ttl_minutes=10,
            ),
            timeout=180,
        )
        if sandbox.cpu != 1 or sandbox.memory != memory_gib:
            raise RuntimeError(
                f"Daytona reported unexpected allocation: cpu={sandbox.cpu}, memory={sandbox.memory}"
            )
        result = sandbox.process.exec(
            "/opt/openinspect/python/bin/python /app/verify/smoke_test.py verify", timeout=240
        )
        if result.exit_code != 0:
            raise RuntimeError(f"Daytona image verification failed: {result.result}")
    except BaseException as error:
        primary_error = error
        raise
    finally:
        try:
            if sandbox is None:
                sandbox = daytona.get(name, request_timeout=30)
            if sandbox is not None:
                daytona.delete(sandbox, timeout=30)
        except DaytonaNotFoundError:
            pass
        except BaseException as cleanup_error:
            if primary_error is None:
                raise
            print(
                f"Daytona verification cleanup failed for {name}: {cleanup_error}", file=sys.stderr
            )
