"""Verify the Docker image variant on the runtime it will be launched with.

Runs inside the candidate Docker image on a Modal VM, using the production
DockerService as the daemon owner. It proves the daemon reaches readiness on
overlay2, that a build, a container and a Compose network work without any
registry, and that the daemon stops cleanly the way an image build requires.
"""

from __future__ import annotations

import asyncio
import os
import sys
import tempfile
from pathlib import Path

from sandbox_runtime.docker_service import DockerService
from sandbox_runtime.log_config import get_logger
from sandbox_runtime.process_output import spawn_owned_subprocess, terminate_owned_subprocess

COMMAND_TIMEOUT_SECONDS = 120
ROOTFS_TAR = "/opt/openinspect/docker-smoke/rootfs.tar"
ROOTFS_IMAGE = "openinspect/docker-smoke-rootfs:local"
BUILT_IMAGE = "openinspect/docker-smoke:local"
COMPOSE_PROJECT = "openinspect-docker-smoke"
MARKER = "compose-network-ok"


async def run_command(*command: str, expect: bytes | None = None) -> bytes:
    process = await spawn_owned_subprocess(
        asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
        )
    )
    try:
        async with asyncio.timeout(COMMAND_TIMEOUT_SECONDS):
            stdout, _ = await process.communicate()
    except BaseException:
        await terminate_owned_subprocess(process)
        raise
    if process.returncode != 0:
        raise RuntimeError(f"Docker verification command failed: {command[1]}")
    if expect is not None and stdout.strip() != expect:
        raise RuntimeError(f"Docker verification command returned unexpected output: {command[1]}")
    return stdout


async def verify_workloads(workdir: Path) -> None:
    await run_command("docker", "info", "--format", "{{.Driver}}", expect=b"overlay2")
    (workdir / "Dockerfile").write_text(
        f"FROM {ROOTFS_IMAGE}\nRUN mkdir -p /www && printf {MARKER} > /www/marker\n"
    )
    (workdir / "compose.yaml").write_text(
        "services:\n"
        "  server:\n"
        f"    image: {BUILT_IMAGE}\n"
        "    pull_policy: never\n"
        '    command: ["httpd", "-f", "-p", "8080", "-h", "/www"]\n'
        "  client:\n"
        f"    image: {BUILT_IMAGE}\n"
        "    pull_policy: never\n"
        "    depends_on: [server]\n"
        '    command: ["sh", "-c", "for i in 1 2 3 4 5 6 7 8 9 10; do '
        f'wget -qO- http://server:8080/marker | grep -qx {MARKER} && exit 0; sleep 1; done; exit 1"]\n'
    )
    await run_command("docker", "import", ROOTFS_TAR, ROOTFS_IMAGE)
    await run_command(
        "docker", "buildx", "build", "--pull=false", "--load", "--tag", BUILT_IMAGE, str(workdir)
    )
    await run_command(
        "docker",
        "run",
        "--pull=never",
        "--rm",
        BUILT_IMAGE,
        "cat",
        "/www/marker",
        expect=MARKER.encode(),
    )
    await run_command(
        "docker",
        "compose",
        "--project-name",
        COMPOSE_PROJECT,
        "-f",
        str(workdir / "compose.yaml"),
        "up",
        "--pull",
        "never",
        "--abort-on-container-exit",
        "--exit-code-from",
        "client",
    )


async def cleanup(workdir: Path) -> None:
    await run_command(
        "docker",
        "compose",
        "--project-name",
        COMPOSE_PROJECT,
        "-f",
        str(workdir / "compose.yaml"),
        "down",
        "--volumes",
        "--remove-orphans",
    )
    await run_command("docker", "image", "rm", "--force", BUILT_IMAGE, ROOTFS_IMAGE)


async def main() -> int:
    service = DockerService(get_logger("docker-smoke"))
    await service.start()
    try:
        with tempfile.TemporaryDirectory() as directory:
            workdir = Path(directory)
            try:
                await verify_workloads(workdir)
            finally:
                await cleanup(workdir)
        # The build path stops the daemon the same way before a snapshot.
        await service.prepare_for_snapshot()
    finally:
        await service.stop()
    return 0


if __name__ == "__main__":
    if os.geteuid() != 0:
        print("Docker verification must run as root", file=sys.stderr)
        sys.exit(1)
    sys.exit(asyncio.run(main()))
