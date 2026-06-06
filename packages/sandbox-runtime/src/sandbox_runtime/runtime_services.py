"""Optional runtime service lifecycle for sandbox supervisor."""

from collections.abc import Awaitable, Callable

from .docker_service import DockerService

ReportFatalError = Callable[[str], Awaitable[None]]


class RuntimeServices:
    """Owns optional sidecar services started by the sandbox supervisor."""

    def __init__(self, log, docker: DockerService | None = None):
        self.log = log
        self.docker = docker

    async def start_before_hooks(self) -> None:
        if not self.docker:
            return
        await self.docker.start()

    async def ensure_healthy(self, report_fatal_error: ReportFatalError) -> bool:
        if not self.docker:
            return True

        if not self.docker.has_crashed():
            return True

        # Docker-backed hooks and Compose services depend on dockerd staying up.
        # Restarting only the daemon would not rerun start.sh, so fail the
        # session instead of leaving it alive with missing runtime services.
        exit_code = self.docker.exit_code
        self.log.error("docker.crash", exit_code=exit_code)
        await report_fatal_error(f"dockerd exited unexpectedly with code {exit_code}")
        return False

    async def stop(self) -> None:
        if not self.docker:
            return
        await self.docker.stop()
