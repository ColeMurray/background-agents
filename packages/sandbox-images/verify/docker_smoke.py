"""Native VM verification of the actual baked Docker image and runtime service."""

import asyncio
import contextlib
import logging
import tempfile
from pathlib import Path

from sandbox_runtime.docker_service import DockerService
from sandbox_runtime.process_output import (
    finish_cancellation_cleanup,
    spawn_owned_subprocess,
    terminate_owned_subprocess,
)

COMMAND_TIMEOUT_SECONDS = 30
TERMINATE_GRACE_SECONDS = 2
ROOTFS_TAR = "/opt/openinspect/docker-smoke/rootfs.tar"
ROOTFS_IMAGE = "openinspect/docker-smoke-rootfs:local"
BUILT_IMAGE = "openinspect/docker-smoke:local"
COMPOSE_PROJECT = "openinspect-docker-smoke"


async def _terminate(process: asyncio.subprocess.Process) -> None:
    cleanup = asyncio.create_task(
        terminate_owned_subprocess(process, terminate_grace_seconds=TERMINATE_GRACE_SECONDS)
    )
    await finish_cancellation_cleanup(cleanup)


async def run_command(
    *command: str,
    check: bool = True,
    stdout: int | None = asyncio.subprocess.DEVNULL,
) -> bytes:
    process = await spawn_owned_subprocess(
        asyncio.create_subprocess_exec(
            *command,
            stdout=stdout,
            stderr=asyncio.subprocess.DEVNULL,
            start_new_session=True,
        )
    )
    try:
        async with asyncio.timeout(COMMAND_TIMEOUT_SECONDS):
            output, _ = await process.communicate()
    except BaseException:
        await _terminate(process)
        raise
    if check and process.returncode != 0:
        raise RuntimeError(f"Docker verification command failed: {command[1]}")
    return output or b""


def _write_workload(directory: Path) -> Path:
    (directory / "Dockerfile").write_text(
        f"FROM {ROOTFS_IMAGE}\nRUN mkdir -p /www && printf compose-network-ok > /www/marker\n"
    )
    compose_path = directory / "compose.yaml"
    compose_path.write_text(
        f"""services:
  server:
    image: {BUILT_IMAGE}
    pull_policy: never
    command: [httpd, -f, -p, '8080', -h, /www]
  client:
    image: {BUILT_IMAGE}
    pull_policy: never
    depends_on: [server]
    command: [sh, -c, 'until wget -qO- http://server:8080/marker | grep -qx compose-network-ok; do sleep 0.1; done']
"""
    )
    return compose_path


async def _cleanup(compose_path: Path, *, preserve_primary_error: bool) -> None:
    commands = (
        (
            (
                "docker",
                "compose",
                "--project-name",
                COMPOSE_PROJECT,
                "-f",
                str(compose_path),
                "down",
                "--volumes",
                "--remove-orphans",
            ),
            True,
        ),
        (("docker", "rm", "--force", "openinspect-docker-smoke-run"), False),
        (("docker", "image", "rm", "--force", BUILT_IMAGE, ROOTFS_IMAGE), True),
    )
    cleanup_error: BaseException | None = None
    for command, required in commands:
        try:
            await run_command(*command, check=required and not preserve_primary_error)
        except BaseException as error:
            cleanup_error = cleanup_error or error
    if cleanup_error is not None and not preserve_primary_error:
        raise cleanup_error


async def main() -> None:
    service = DockerService(logging.getLogger("docker-verification"))
    primary_error: BaseException | None = None
    try:
        await service.start()
        output = await run_command(
            "docker", "info", "--format", "{{.Driver}}", stdout=asyncio.subprocess.PIPE
        )
        if output.strip() != b"overlay2":
            raise RuntimeError("Docker image must use the verified overlay2 layout")
        with tempfile.TemporaryDirectory(prefix="openinspect-docker-smoke-") as workdir:
            compose_path = _write_workload(Path(workdir))
            workload_error: BaseException | None = None
            try:
                await run_command("docker", "import", ROOTFS_TAR, ROOTFS_IMAGE)
                await run_command(
                    "docker",
                    "buildx",
                    "build",
                    "--pull=false",
                    "--load",
                    "--tag",
                    BUILT_IMAGE,
                    workdir,
                )
                marker = await run_command(
                    "docker",
                    "run",
                    "--pull=never",
                    "--rm",
                    "--name",
                    "openinspect-docker-smoke-run",
                    BUILT_IMAGE,
                    "cat",
                    "/www/marker",
                    stdout=asyncio.subprocess.PIPE,
                )
                if marker != b"compose-network-ok":
                    raise RuntimeError("Docker verification container returned an invalid marker")
                await run_command(
                    "docker",
                    "compose",
                    "--project-name",
                    COMPOSE_PROJECT,
                    "-f",
                    str(compose_path),
                    "up",
                    "--pull",
                    "never",
                    "--abort-on-container-exit",
                    "--exit-code-from",
                    "client",
                )
            except BaseException as error:
                workload_error = error
                raise
            finally:
                await _cleanup(compose_path, preserve_primary_error=workload_error is not None)
        await service.prepare_for_snapshot()
    except BaseException as error:
        primary_error = error
        raise
    finally:
        if primary_error is None:
            await service.stop()
        else:
            with contextlib.suppress(BaseException):
                await service.stop()


if __name__ == "__main__":
    asyncio.run(main())
