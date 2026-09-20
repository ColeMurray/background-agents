"""Native VM verification of the actual baked Docker image and runtime service."""

import asyncio
import logging

from sandbox_runtime.docker_service import DockerService


async def main() -> None:
    service = DockerService(logging.getLogger("docker-verification"))
    try:
        await service.start()
        process = await asyncio.create_subprocess_exec(
            "docker",
            "info",
            "--format",
            "{{.Driver}}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        async with asyncio.timeout(10):
            output, _ = await process.communicate()
        if process.returncode != 0 or output.strip() != b"overlay2":
            raise RuntimeError("Docker image must use the verified overlay2 layout")
        await service.prepare_for_snapshot()
    finally:
        await service.stop()


if __name__ == "__main__":
    asyncio.run(main())
