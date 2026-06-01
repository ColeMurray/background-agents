"""Optional runtime service lifecycle for sandbox supervisor."""

from collections.abc import Awaitable, Callable

from .docker_service import DockerService

ReportFatalError = Callable[[str], Awaitable[None]]


class RuntimeServices:
    """Owns optional sidecar services started by the sandbox supervisor."""

    def __init__(self, log, docker: DockerService):
        self.log = log
        self.docker = docker

    @classmethod
    def from_env(cls, log) -> "RuntimeServices":
        return cls(log, docker=DockerService.from_env(log))

    async def start_before_hooks(self) -> None:
        await self.docker.start()

    async def ensure_healthy(self, report_fatal_error: ReportFatalError) -> bool:
        if not self.docker.has_crashed():
            return True

        exit_code = self.docker.exit_code
        self.log.error("docker.crash", exit_code=exit_code)
        await report_fatal_error(f"dockerd exited unexpectedly with code {exit_code}")
        return False

    async def stop(self) -> None:
        await self.docker.stop()
