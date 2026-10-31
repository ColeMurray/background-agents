"""Owned personal MCP lifecycle; routing and sandbox credentials stay static."""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from dataclasses import replace
from enum import StrEnum
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

import httpx

from .log_config import get_logger

if TYPE_CHECKING:
    from .harness.base import (
        EventSink,
        HarnessId,
        HarnessPrompt,
        ManagedMcpNativeHarness,
        TurnOutcome,
    )

log = get_logger("managed_mcp")

MANAGED_MCP_VERSION = 1
MANAGED_MCP_PREPARE_TIMEOUT_SECONDS = 60.0
MANAGED_MCP_CLOSE_TIMEOUT_SECONDS = 15.0


def managed_marker(server: Mapping[str, Any]) -> Mapping[str, Any] | None:
    marker = server.get("managed_proxy")
    if marker is None:
        return None
    if (
        not isinstance(marker, Mapping)
        or marker.get("version") != MANAGED_MCP_VERSION
        or marker.get("auth_mode") not in {"none", "service_credentials", "user_oauth"}
        or server.get("type") != "remote"
        or set(server.get("headers") or {}) != {"Authorization"}
        or server.get("env")
    ):
        raise ValueError("Unsupported managed MCP runtime configuration")
    return marker


def personal_names(servers: Sequence[Mapping[str, Any]]) -> tuple[str, ...]:
    return tuple(
        str(server["name"])
        for server in servers
        if (marker := managed_marker(server)) and marker["auth_mode"] == "user_oauth"
    )


class ManagedMcpState(StrEnum):
    CLEAN = "clean"
    ACTIVE = "active"
    UNCERTAIN = "uncertain"


class ManagedMcpHarness:
    """Wrap only the existing harness task; failed cleanup prevents another delegated turn."""

    def __init__(
        self,
        harness: ManagedMcpNativeHarness,
        *,
        servers: Sequence[Mapping[str, Any]],
        control_plane_url: str,
        session_id: str,
        auth_token: str,
    ) -> None:
        self.harness = harness
        self.names = personal_names(servers)
        self.close_url = f"{control_plane_url.rstrip('/')}/sessions/{quote(session_id, safe='')}/mcp-context/close"
        self.auth_token = auth_token
        self._state = ManagedMcpState.CLEAN

    @property
    def cleanup_failed(self) -> bool:
        return self._state is ManagedMcpState.UNCERTAIN

    @property
    def id(self) -> HarnessId:
        return self.harness.id

    @property
    def session_id(self) -> str | None:
        return self.harness.session_id

    @session_id.setter
    def session_id(self, value: str | None) -> None:
        self.harness.session_id = value

    async def open(self) -> None:
        await self.harness.open()

    async def close(self) -> None:
        await self.harness.close()

    async def resume_session(self, persisted_id: str) -> bool:
        return await self.harness.resume_session(persisted_id)

    async def create_session(self) -> None:
        await self.harness.create_session()

    async def abort(self) -> bool:
        return await self.harness.abort()

    async def stop_execution(self, timeout_seconds: float) -> bool:
        return await self.harness.stop_execution(timeout_seconds)

    async def run_prompt(self, prompt: HarnessPrompt, emit: EventSink) -> TurnOutcome:
        from .harness.base import TurnOutcome

        if not self.names:
            return await self.harness.run_prompt(prompt, emit)
        if self.cleanup_failed:
            return TurnOutcome.failed(
                "Managed MCP state is uncertain; restart the sandbox before continuing."
            )
        context = prompt.managed_mcp
        if not isinstance(context, Mapping) or context.get("messageId") != prompt.message_id:
            return TurnOutcome.failed("Managed MCP execution context is unavailable.")
        allowed = context.get("servers", [])
        if (
            not isinstance(allowed, (list, tuple))
            or not all(isinstance(name, str) for name in allowed)
            or not set(allowed).issubset(self.names)
        ):
            return TurnOutcome.failed("Invalid managed MCP execution context.")
        loop = asyncio.get_running_loop()
        budget_seconds = (
            self.harness.limits.prompt_max_duration_seconds
            if prompt.max_duration_seconds is None
            else prompt.max_duration_seconds
        )
        deadline = loop.time() + max(budget_seconds, 0.0)
        preparation_started = False
        preparation_settled = False
        self._state = ManagedMcpState.ACTIVE
        try:
            # Preparation and warnings spend the caller's remaining turn budget.
            # End this scope before entering the native harness: its SDK owns
            # its own cancellation scopes on this same task.
            try:
                async with asyncio.timeout_at(deadline):
                    for unavailable in context.get("unavailable", []):
                        recovery = (
                            "Restart or replace the sandbox allocation before using personal MCP again."
                            if unavailable["code"] == "mcp_runtime_restart_required"
                            else "Connect or reconnect in Settings: "
                            f"{context.get('connectionUrl', '/settings?tab=mcp-connections')}."
                        )
                        await emit(
                            {
                                "type": "warning",
                                "scope": "mcp",
                                "messageId": prompt.message_id,
                                "message": f"Personal MCP {unavailable['name']} is unavailable ({unavailable['code']}). "
                                f"{recovery} "
                                "Other tools remain available.",
                            }
                        )
                    async with asyncio.timeout(MANAGED_MCP_PREPARE_TIMEOUT_SECONDS):
                        preparation_started = True
                        failed = await self.harness.prepare_managed_mcp(set(allowed))
                        preparation_settled = True
                    for name in failed:
                        await emit(
                            {
                                "type": "warning",
                                "scope": "mcp",
                                "messageId": prompt.message_id,
                                "message": f"Personal MCP {name} could not connect. Reconnect in Settings. Other tools remain available.",
                            }
                        )
            except TimeoutError:
                return TurnOutcome.failed("Managed MCP preparation timed out.")
            remaining_seconds = deadline - loop.time()
            if remaining_seconds <= 0:
                return TurnOutcome.failed("Prompt time budget exhausted during MCP preparation.")
            return await self.harness.run_prompt(
                replace(prompt, max_duration_seconds=remaining_seconds), emit
            )
        finally:
            # Cancellation of a native control request does not fence late connection.
            if preparation_started and not preparation_settled:
                self._state = ManagedMcpState.UNCERTAIN
            # Close authority before disposing owned clients, while queue processing
            # ownership still prevents dispatch of the next foreground prompt.
            # Authority is turn-scoped: it also ends when execution_complete
            # settles this message, so a failed close is not native uncertainty.
            try:
                async with (
                    asyncio.timeout(MANAGED_MCP_CLOSE_TIMEOUT_SECONDS),
                    httpx.AsyncClient(timeout=MANAGED_MCP_CLOSE_TIMEOUT_SECONDS) as client,
                ):
                    response = await client.post(
                        self.close_url,
                        headers={"Authorization": f"Bearer {self.auth_token}"},
                        json={"messageId": prompt.message_id, "revision": context.get("revision")},
                    )
                    response.raise_for_status()
            except (httpx.HTTPError, TimeoutError) as error:
                log.warn(
                    "managed_mcp.authority_close_failed",
                    message_id=prompt.message_id,
                    error=str(error),
                )
            finally:
                try:
                    async with asyncio.timeout(MANAGED_MCP_CLOSE_TIMEOUT_SECONDS):
                        await self.harness.close_managed_mcp()
                except BaseException:
                    self._state = ManagedMcpState.UNCERTAIN
                    raise
                if self._state is not ManagedMcpState.UNCERTAIN:
                    self._state = ManagedMcpState.CLEAN
