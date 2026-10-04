"""Lookup-only recovery of named VM allocations and their provider-owned access metadata."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Literal

import modal

from sandbox_runtime.constants import VNC_PASSWORD_ENV_VAR

from ..app_config import APP_NAME
from .tunnels import SandboxTunnels

VM_LAUNCH_TAG = "openinspect_vm_launch"
VM_PORTS_TAG = "openinspect_vm_ports"
_METADATA_TAGS = {VM_LAUNCH_TAG, VM_PORTS_TAG}

type VMAllocationDetail = Literal[
    "not_visible", "other_generation", "window_closed", "race_pending"
]


class VMAllocationOutcome(RuntimeError):
    """A known named-VM lookup or launch outcome, distinct from provider failures."""

    def __init__(self, detail: VMAllocationDetail, message: str):
        super().__init__(message)
        self.detail = detail


@dataclass(frozen=True)
class VMServiceLaunch:
    code_server_enabled: bool
    vnc_enabled: bool
    terminal_enabled: bool
    code_server_port: int
    novnc_port: int
    ttyd_proxy_port: int
    tunnel_ports: list[int]

    @classmethod
    def from_tunnels(cls, tunnels: SandboxTunnels) -> "VMServiceLaunch":
        return cls(*tunnels.service_enabled, *tunnels.service_ports, tunnels.extra_ports)

    def tags(self) -> dict[str, str]:
        # Two short, tag-safe values keep even ten five-digit extra ports within Modal's limit.
        flags = "".join(
            "1" if enabled else "0"
            for enabled in (self.code_server_enabled, self.vnc_enabled, self.terminal_enabled)
        )
        return {
            VM_LAUNCH_TAG: (
                f"1-{flags}-{self.code_server_port}-{self.novnc_port}-{self.ttyd_proxy_port}"
            ),
            VM_PORTS_TAG: "-".join(map(str, self.tunnel_ports)) or "none",
        }


def owned_vm_tags_match(actual: dict[str, str], expected: dict[str, str]) -> bool:
    """Keep exact generation ownership, allowing only the two launch metadata tags."""
    return all(actual.get(key) == value for key, value in expected.items()) and (
        actual.keys() <= expected.keys() | _METADATA_TAGS
    )


def parse_vm_service_launch(tags: dict[str, str]) -> VMServiceLaunch | None:
    """Absent, unsupported, or incomplete metadata grants no access (including on legacy VMs)."""
    launch = tags.get(VM_LAUNCH_TAG, "").split("-")
    raw_ports = tags.get(VM_PORTS_TAG)
    if len(launch) != 5 or launch[0] != "1" or len(launch[1]) != 3:
        return None
    if any(flag not in "01" for flag in launch[1]) or raw_ports is None:
        return None

    def port(value: str) -> int | None:
        if not value.isascii() or not value.isdecimal() or len(value) > 5:
            return None
        number = int(value)
        return number if 1 <= number <= 65535 else None

    service_ports = [port(value) for value in launch[2:]]
    extras = [] if raw_ports == "none" else [port(value) for value in raw_ports.split("-")]
    if None in service_ports or None in extras or len(extras) > 10:
        return None
    return VMServiceLaunch(
        *(flag == "1" for flag in launch[1]),
        *service_ports,
        extras,
    )


async def find_owned_vm(
    name: str, expected_tags: dict[str, str]
) -> tuple[modal.Sandbox, dict[str, str]] | None:
    try:
        sandbox = await modal.Sandbox.from_name.aio(APP_NAME, name)
    except modal.exception.NotFoundError:
        return None
    tags = await sandbox.get_tags.aio()
    if not owned_vm_tags_match(tags, expected_tags):
        raise VMAllocationOutcome(
            "other_generation", "Docker sandbox allocation ownership mismatch"
        )
    return sandbox, tags


@dataclass
class VMAccess:
    code_server_url: str | None = None
    code_server_password: str | None = None
    vnc_url: str | None = None
    vnc_password: str | None = None
    ttyd_url: str | None = None
    tunnel_urls: dict[int, str] | None = None


async def recover_vm_access(
    sandbox: modal.Sandbox,
    sandbox_id: str,
    tags: dict[str, str],
    read_passwords: Callable[..., Awaitable[dict[str, str]]],
) -> VMAccess:
    launch = parse_vm_service_launch(tags)
    if launch is None:
        return VMAccess()
    passwords = await read_passwords(
        sandbox,
        code_server_enabled=launch.code_server_enabled,
        vnc_enabled=launch.vnc_enabled,
    )
    tunnels = SandboxTunnels(
        code_server_enabled=launch.code_server_enabled,
        vnc_enabled=launch.vnc_enabled,
        settings={
            "terminalEnabled": launch.terminal_enabled,
            "codeServerPort": launch.code_server_port,
            "vncPort": launch.novnc_port,
            "terminalPort": launch.ttyd_proxy_port,
            "tunnelPorts": launch.tunnel_ports,
        },
    )
    urls = await tunnels.resolve(sandbox, sandbox_id, write_env_file=False)
    # Launch returns whatever tunnels Modal published; only retry while none are readable.
    if tunnels.exposed_ports and not any(urls):
        raise VMAllocationOutcome("race_pending", "VM allocation tunnels are not yet visible")
    return VMAccess(
        code_server_url=urls.code_server_url,
        code_server_password=passwords.get("CODE_SERVER_PASSWORD"),
        vnc_url=urls.vnc_url,
        vnc_password=passwords.get(VNC_PASSWORD_ENV_VAR),
        ttyd_url=urls.ttyd_url,
        tunnel_urls=urls.tunnel_urls,
    )
