"""Configuration helpers for the Daytona shim service."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_AUTO_STOP_INTERVAL_MINUTES = 120
DEFAULT_AUTO_ARCHIVE_INTERVAL_MINUTES = 10080
DEFAULT_PREVIEW_EXPIRY_SECONDS = 3900
MAX_TUNNEL_PORTS = 10
CODE_SERVER_PORT = 8080


@dataclass(frozen=True)
class DaytonaServiceConfig:
    """Runtime configuration for the Daytona shim service."""

    api_key: str
    api_url: str | None
    target: str | None
    base_snapshot: str
    auto_stop_interval_minutes: int
    auto_archive_interval_minutes: int
    repo_root: Path
    scm_provider: str


def load_config() -> DaytonaServiceConfig:
    """Load service configuration from environment variables."""
    repo_root = Path(
        os.environ.get("OPEN_INSPECT_REPO_ROOT", Path(__file__).resolve().parents[3])
    )

    return DaytonaServiceConfig(
        api_key=require_env("DAYTONA_API_KEY"),
        api_url=os.environ.get("DAYTONA_API_URL") or None,
        target=os.environ.get("DAYTONA_TARGET") or None,
        base_snapshot=require_env("DAYTONA_BASE_SNAPSHOT"),
        auto_stop_interval_minutes=int(
            os.environ.get(
                "DAYTONA_AUTO_STOP_INTERVAL_MINUTES",
                str(DEFAULT_AUTO_STOP_INTERVAL_MINUTES),
            )
        ),
        auto_archive_interval_minutes=int(
            os.environ.get(
                "DAYTONA_AUTO_ARCHIVE_INTERVAL_MINUTES",
                str(DEFAULT_AUTO_ARCHIVE_INTERVAL_MINUTES),
            )
        ),
        repo_root=repo_root,
        scm_provider=os.environ.get("SCM_PROVIDER", "github"),
    )


def require_env(name: str) -> str:
    """Return a required environment variable."""
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def normalize_control_plane_host(value: str) -> str:
    """Normalize a host allowlist entry or URL origin for comparisons."""
    parsed = urlparse(value if "://" in value else f"//{value}")
    if parsed.hostname is None:
        raise RuntimeError(f"Invalid control plane host: {value}")

    if parsed.port in (None, 443):
        return parsed.hostname.lower()

    return f"{parsed.hostname.lower()}:{parsed.port}"


def validate_control_plane_url(url: str) -> None:
    """Reject unexpected control-plane callback hosts."""
    allowed_hosts = {
        normalize_control_plane_host(host.strip())
        for host in os.environ.get("ALLOWED_CONTROL_PLANE_HOSTS", "").split(",")
        if host.strip()
    }
    if not allowed_hosts:
        raise RuntimeError("ALLOWED_CONTROL_PLANE_HOSTS must be configured")

    parsed = urlparse(url)
    if parsed.scheme != "https":
        raise RuntimeError(f"Invalid control plane URL: {url}")

    if normalize_control_plane_host(url) not in allowed_hosts:
        raise RuntimeError(f"Invalid control plane URL: {url}")


def resolve_tunnel_ports(raw_ports: list[object] | None) -> list[int]:
    """Validate tunnel port configuration from sandbox settings."""
    if not raw_ports:
        return []

    ports: list[int] = []
    for value in raw_ports:
        if isinstance(value, int) and 1 <= value <= 65535:
            ports.append(value)
        if len(ports) >= MAX_TUNNEL_PORTS:
            break
    return ports


def resolve_preview_expiry_seconds(timeout_seconds: int | None) -> int:
    """Compute preview expiry using the control-plane timeout policy."""
    if not timeout_seconds:
        return DEFAULT_PREVIEW_EXPIRY_SECONDS

    return min(86400, max(900, timeout_seconds + 300))
