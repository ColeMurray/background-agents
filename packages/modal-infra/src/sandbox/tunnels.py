"""Service port ownership and best-effort Modal tunnel publication."""

import asyncio
from typing import Any, NamedTuple

import modal

from sandbox_runtime.constants import (
    CODE_SERVER_PORT,
    CODE_SERVER_PORT_ENV_VAR,
    EXPECTED_TUNNEL_PORTS_ENV_VAR,
    NOVNC_PORT,
    NOVNC_PORT_ENV_VAR,
    TTYD_PROXY_PORT,
    TTYD_PROXY_PORT_ENV_VAR,
    TUNNEL_ENV_FILE_PATH,
    TUNNEL_ENV_SANDBOX_ID_KEY,
    VNC_PORT,
)
from sandbox_runtime.log_config import get_logger

# Preserve the logger name used by existing launch/tunnel dashboards.
log = get_logger("manager")
MAX_TUNNEL_PORTS = 10
DEFAULT_TUNNEL_RESOLUTION_RETRIES = 3
DEFAULT_TUNNEL_RESOLUTION_BACKOFF_SECONDS = 1.0


class TunnelUrls(NamedTuple):
    """Resolved service URLs and any user-requested tunnels."""

    code_server_url: str | None = None
    vnc_url: str | None = None
    ttyd_url: str | None = None
    tunnel_urls: dict[int, str] | None = None


class SandboxTunnels:
    """Keep exposed ports, runtime environment, and URL routing in agreement.

    Service ownership is resolved once for a launch. Disabled service ports
    remain available as user tunnels; raw VNC is never an extra tunnel.
    """

    def __init__(
        self,
        *,
        code_server_enabled: bool = False,
        vnc_enabled: bool = False,
        settings: dict[str, Any] | None = None,
    ) -> None:
        settings = settings or {}
        code_server_port, novnc_port, ttyd_proxy_port = self._resolve_service_ports(settings)
        self._code_server_port = code_server_port if code_server_enabled else None
        self._novnc_port = novnc_port if vnc_enabled else None
        self._ttyd_proxy_port = (
            ttyd_proxy_port if bool(settings.get("terminalEnabled", False)) else None
        )
        service_ports = [
            port
            for port in (self._code_server_port, self._novnc_port, self._ttyd_proxy_port)
            if port is not None
        ]
        reserved = {VNC_PORT, *service_ports}
        raw_ports = settings.get("tunnelPorts", [])
        self._extra_ports = (
            [port for port in self._validate_ports(raw_ports) if port not in reserved]
            if raw_ports
            else []
        )
        self.exposed_ports = service_ports + self._extra_ports

    @property
    def environment(self) -> dict[str, str]:
        """Runtime settings derived from the same ports used for exposure."""
        env: dict[str, str] = {}
        if self._code_server_port is not None:
            env[CODE_SERVER_PORT_ENV_VAR] = str(self._code_server_port)
        if self._novnc_port is not None:
            env[NOVNC_PORT_ENV_VAR] = str(self._novnc_port)
        if self._ttyd_proxy_port is not None:
            env["TERMINAL_ENABLED"] = "true"
            env[TTYD_PROXY_PORT_ENV_VAR] = str(self._ttyd_proxy_port)
        if self._extra_ports:
            env[EXPECTED_TUNNEL_PORTS_ENV_VAR] = ",".join(str(p) for p in self._extra_ports)
        return env

    async def resolve(self, sandbox: modal.Sandbox, sandbox_id: str) -> TunnelUrls:
        """Resolve URLs and publish extras; partial resolution/write failures are non-fatal."""
        if not self.exposed_ports:
            return TunnelUrls()

        resolved = await self._resolve_tunnels(sandbox, sandbox_id, self.exposed_ports)
        # A disabled service does not own its default port: leave it in extras.
        code_server_url = (
            resolved.pop(self._code_server_port, None)
            if self._code_server_port is not None
            else None
        )
        vnc_url = resolved.pop(self._novnc_port, None) if self._novnc_port is not None else None
        ttyd_url = (
            resolved.pop(self._ttyd_proxy_port, None) if self._ttyd_proxy_port is not None else None
        )
        extra_urls = resolved or None
        if extra_urls:
            await self._write_tunnel_env_file(sandbox, sandbox_id, extra_urls)
        return TunnelUrls(
            code_server_url=code_server_url,
            vnc_url=vnc_url,
            ttyd_url=ttyd_url,
            tunnel_urls=extra_urls,
        )

    @staticmethod
    async def _resolve_tunnels(
        sandbox: modal.Sandbox,
        sandbox_id: str,
        ports: list[int],
        retries: int = DEFAULT_TUNNEL_RESOLUTION_RETRIES,
        backoff_seconds: float = DEFAULT_TUNNEL_RESOLUTION_BACKOFF_SECONDS,
    ) -> dict[int, str]:
        """Resolve tunnel URLs for the given ports from Modal, retrying on failure."""
        resolved: dict[int, str] = {}
        for attempt in range(retries):
            try:
                loop = asyncio.get_running_loop()
                tunnels = await loop.run_in_executor(None, sandbox.tunnels)
                for port in ports:
                    if port in tunnels and port not in resolved:
                        resolved[port] = tunnels[port].url
                        log.info(
                            "tunnel.resolved",
                            sandbox_id=sandbox_id,
                            port=port,
                            url=tunnels[port].url,
                        )
                if len(resolved) == len(ports):
                    return resolved
            except Exception as e:
                log.warn(
                    "tunnel.resolve_error",
                    sandbox_id=sandbox_id,
                    attempt=attempt + 1,
                    retries=retries,
                    error=type(e).__name__,
                    exc=e,
                )
            if attempt < retries - 1:
                await asyncio.sleep(backoff_seconds * (attempt + 1))
        return resolved

    @staticmethod
    def _validate_ports(raw: list[Any]) -> list[int]:
        """Validate and sanitize tunnel ports: must be int, 1-65535, max MAX_TUNNEL_PORTS."""
        ports: list[int] = []
        for p in raw:
            if isinstance(p, int) and not isinstance(p, bool) and 1 <= p <= 65535:
                ports.append(p)
            if len(ports) >= MAX_TUNNEL_PORTS:
                break
        return ports

    @staticmethod
    def _resolve_service_ports(settings: dict[str, Any] | None) -> tuple[int, int, int]:
        """Return effective (code_server_port, novnc_port, ttyd_proxy_port) from settings.

        Falls back to the service defaults when unset or invalid. The control
        plane validates these before they reach here.
        """
        s = settings or {}

        def coerce(value: Any, default: int) -> int:
            if isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 65535:
                return value
            return default

        return (
            coerce(s.get("codeServerPort"), CODE_SERVER_PORT),
            coerce(s.get("vncPort"), NOVNC_PORT),
            coerce(s.get("terminalPort"), TTYD_PROXY_PORT),
        )

    @staticmethod
    async def _write_tunnel_env_file(
        sandbox: modal.Sandbox,
        sandbox_id: str,
        tunnel_urls: dict[int, str],
    ) -> None:
        """Write tunnel URLs to TUNNEL_ENV_FILE_PATH as a dotenv file.

        The first line tags the file with this sandbox's ID so the supervisor's
        stale-file cleanup can tell a fresh write (this write can land before
        the entrypoint runs) from a snapshot/image leftover.

        Failures are logged but do not block sandbox creation; URLs are also
        returned to the control plane via the SandboxHandle.
        """
        lines = [f"{TUNNEL_ENV_SANDBOX_ID_KEY}={sandbox_id}"]
        lines += [f"TUNNEL_{port}={url}" for port, url in sorted(tunnel_urls.items())]
        content = "\n".join(lines) + "\n"
        try:
            await sandbox.filesystem.write_text.aio(content, TUNNEL_ENV_FILE_PATH)
            log.info(
                "tunnel.urls_written",
                sandbox_id=sandbox_id,
                path=TUNNEL_ENV_FILE_PATH,
                ports=list(tunnel_urls.keys()),
            )
        except Exception as e:
            log.warn(
                "tunnel.urls_write_failed",
                sandbox_id=sandbox_id,
                path=TUNNEL_ENV_FILE_PATH,
                exc=e,
            )
