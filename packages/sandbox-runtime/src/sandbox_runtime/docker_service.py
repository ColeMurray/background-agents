"""Docker daemon supervision for sandbox runtime processes."""

import asyncio
import os
import shutil
import time
from contextlib import suppress
from pathlib import Path

DEFAULT_DOCKER_DATA_ROOT = Path("/opt/docker-data")
DEFAULT_IP_FORWARD_PATH = Path("/proc/sys/net/ipv4/ip_forward")
DOCKER_COMMAND_TIMEOUT_SECONDS = 5.0
DEFAULT_RUN_PATHS = (
    Path("/var/run/docker.sock"),
    Path("/var/run/docker.pid"),
    Path("/var/run/docker"),
    Path("/run/containerd"),
)


class DockerService:
    """Starts and stops the in-sandbox Docker daemon when enabled."""

    STALE_DATA_DIRS = ("network", "containers", "containerd", "runtimes", "tmp")
    READY_TIMEOUT_SECONDS = 30.0

    def __init__(
        self,
        log,
        enabled: bool = False,
        data_root: Path = DEFAULT_DOCKER_DATA_ROOT,
        run_paths: tuple[Path, ...] = DEFAULT_RUN_PATHS,
        ip_forward_path: Path = DEFAULT_IP_FORWARD_PATH,
    ):
        self.log = log
        self.enabled = enabled
        self.data_root = data_root
        self.run_paths = run_paths
        self.ip_forward_path = ip_forward_path
        self.process: asyncio.subprocess.Process | None = None
        self._log_task: asyncio.Task[None] | None = None

    @classmethod
    def from_env(cls, log) -> "DockerService":
        return cls(
            log,
            enabled=os.environ.get("OPENINSPECT_DOCKER_ENABLED", "").lower() == "true",
            data_root=Path(os.environ.get("DOCKER_DATA_ROOT", str(DEFAULT_DOCKER_DATA_ROOT))),
        )

    @property
    def exit_code(self) -> int | None:
        if not self.process:
            return None
        return self.process.returncode

    def has_crashed(self) -> bool:
        return self.enabled and self.exit_code is not None

    def prepare_runtime_state(self) -> None:
        """Remove stale daemon/container metadata while preserving images, cache, and volumes."""
        self.data_root.mkdir(parents=True, exist_ok=True)
        for dirname in self.STALE_DATA_DIRS:
            path = self.data_root / dirname
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            elif path.exists():
                path.unlink(missing_ok=True)

        for path in self.run_paths:
            if path.is_dir():
                shutil.rmtree(path, ignore_errors=True)
            else:
                path.unlink(missing_ok=True)

    async def _run_command(
        self,
        *args: str,
        check: bool = True,
        timeout_seconds: float = DOCKER_COMMAND_TIMEOUT_SECONDS,
    ) -> tuple[int, str]:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        try:
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_seconds)
        except TimeoutError:
            with suppress(ProcessLookupError):
                proc.kill()
            await proc.wait()
            raise RuntimeError(
                f"{' '.join(args)} timed out after {timeout_seconds:.1f}s"
            ) from None
        output = (stdout or b"").decode(errors="replace")
        if check and proc.returncode != 0:
            raise RuntimeError(f"{' '.join(args)} failed: {output.strip()}")
        return proc.returncode or 0, output

    async def configure_network(self) -> None:
        """Configure SNAT for Docker containers in Modal's gVisor environment."""
        _, route_output = await self._run_command("ip", "route", "show", "default")
        default_line = next(
            (line for line in route_output.splitlines() if line.startswith("default ")),
            "",
        )
        pieces = default_line.split()
        if "dev" not in pieces:
            raise RuntimeError("Could not determine default network device for Docker")
        dev = pieces[pieces.index("dev") + 1]

        _, addr_output = await self._run_command("ip", "-4", "addr", "show", "dev", dev)
        address = ""
        for line in addr_output.splitlines():
            stripped = line.strip()
            if stripped.startswith("inet "):
                address = stripped.split()[1].split("/")[0]
                break
        if not address:
            raise RuntimeError(f"Could not determine IPv4 address for Docker device {dev}")

        try:
            self.ip_forward_path.write_text("1\n")
        except OSError as e:
            self.log.warn("docker.ip_forward_failed", error=str(e))

        for proto in ("tcp", "udp"):
            rule = (
                "POSTROUTING",
                "-o",
                dev,
                "-p",
                proto,
                "-j",
                "SNAT",
                "--to-source",
                address,
            )
            exists, _ = await self._run_command(
                "iptables-legacy", "-t", "nat", "-C", *rule, check=False
            )
            if exists != 0:
                await self._run_command("iptables-legacy", "-t", "nat", "-A", *rule)

    async def start(self) -> None:
        if not self.enabled:
            self.log.info("docker.skip", reason="OPENINSPECT_DOCKER_ENABLED not true")
            return

        self.prepare_runtime_state()
        await self.configure_network()

        self.process = await asyncio.create_subprocess_exec(
            "dockerd",
            f"--data-root={self.data_root}",
            "--host=unix:///var/run/docker.sock",
            "--iptables=false",
            "--ip6tables=false",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        self._log_task = asyncio.create_task(self._forward_logs())
        try:
            await self.wait_until_ready()
        except Exception:
            await self.stop()
            raise
        self.log.info("docker.ready", data_root=str(self.data_root))

    async def wait_until_ready(self) -> None:
        start = time.time()
        while time.time() - start < self.READY_TIMEOUT_SECONDS:
            if self.process and self.process.returncode is not None:
                raise RuntimeError(f"dockerd exited early with code {self.process.returncode}")
            returncode, _ = await self._run_command("docker", "info", check=False)
            if returncode == 0:
                return
            await asyncio.sleep(0.5)
        raise RuntimeError("dockerd did not become ready before timeout")

    async def _forward_logs(self) -> None:
        if not self.process or not self.process.stdout:
            return
        try:
            async for line in self.process.stdout:
                self.log.info("docker.stdout", line=line.decode(errors="replace").rstrip())
        except Exception as e:
            self.log.warn("docker.log_forward_error", exc=e)

    async def _cancel_log_task(self) -> None:
        if not self._log_task:
            return
        if not self._log_task.done():
            self._log_task.cancel()
            with suppress(asyncio.CancelledError):
                await self._log_task
        self._log_task = None

    async def stop(self) -> None:
        process = self.process
        if not process:
            await self._cancel_log_task()
            return

        if process.returncode is None:
            self.log.info("docker.terminating")
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5.0)
            except TimeoutError:
                process.kill()
                await process.wait()

        await self._cancel_log_task()
        self.process = None
