"""Revision-qualified, fail-paused account application within the existing workspace."""

from __future__ import annotations

import asyncio
import json
import math
import os
import time
from pathlib import Path
from typing import Any

from .provider_switch_control import harness_control


class ProviderAccountSwitchRuntime:
    def __init__(self, bridge: Any) -> None:
        self.bridge = bridge
        self.fenced = False
        self.lock = asyncio.Lock()
        self.identity: dict[str, Any] | None = None
        self.quiesced = False
        self.applied = False

    def supported(self, provider: str | None = None) -> bool:
        harness = self.bridge._require_harness()
        qualified = os.environ.get("PROVIDER_ACCOUNT_SWITCH_QUALIFIED", "").split(",")
        return any(
            value == f"{harness.id.value}/{provider}"
            if provider
            else value.startswith(f"{harness.id.value}/")
            for value in qualified
        )

    def establish_generation(self, generation: dict[str, Any]) -> None:
        """Only the authenticated generation command may supersede retained state."""
        if self.identity is not None and self.identity["generation"] != generation:
            self.identity = None
            self.quiesced = False
            self.applied = False
            # Remain locally fenced until re-quiescence and qualified apply.
            self.fenced = True

    async def handle(self, command: dict[str, Any]) -> None:
        identity = {
            key: command.get(key)
            for key in (
                "operationId",
                "provider",
                "bindingRevision",
                "generation",
                "conversationId",
            )
        }
        generation = self.bridge._parse_generation(identity["generation"])
        provider = identity["provider"]
        revision = identity["bindingRevision"]
        operation = identity["operationId"]
        conversation = identity["conversationId"]
        deadline_ms = command.get("deadlineMs")
        model = command.get("model")
        reasoning_effort = command.get("reasoningEffort")
        if (
            provider not in ("openai", "xai", "anthropic")
            or not isinstance(operation, str)
            or not 1 <= len(operation) <= 128
            or not isinstance(conversation, str)
            or not conversation
            or isinstance(revision, bool)
            or not isinstance(revision, int)
            or revision < 2
            or isinstance(deadline_ms, bool)
            or not isinstance(deadline_ms, (int, float))
            or not math.isfinite(deadline_ms)
            or generation is None
            or generation != self.bridge.shutdown_preparation.generation
            or not isinstance(model, str)
            or not 1 <= len(model) <= 256
            or not model.startswith(f"{provider}/")
            or (
                reasoning_effort is not None
                and (not isinstance(reasoning_effort, str) or not 1 <= len(reasoning_effort) <= 32)
            )
        ):
            return
        event = {
            **identity,
            "type": "provider_account_switch",
            "outcome": "failed",
            "reason": "apply_outcome_unknown",
        }
        async with self.lock:
            if (
                self.identity is not None
                and self.identity != identity
                and self.identity["provider"] == provider
                and revision <= self.identity["bindingRevision"]
            ):
                return
            try:
                if not self.supported(provider) or self.bridge.shutdown_preparation.fenced:
                    raise RuntimeError("unsupported")
                if self.identity != identity:
                    if self.identity is not None and self.fenced and not self.applied:
                        raise RuntimeError("operation conflict")
                    self.identity, self.quiesced, self.applied = identity, False, False
                self.fenced = True
                harness = self.bridge._require_harness()
                if harness.session_id != conversation:
                    event["reason"] = "conversation_unavailable"
                    raise RuntimeError("conversation changed")
                if deadline_ms <= time.time() * 1000:
                    raise RuntimeError("deadline expired")
                deadline = asyncio.get_running_loop().time() + max(
                    0, min(120, (deadline_ms - time.time() * 1000) / 1000)
                )
                async with asyncio.timeout_at(deadline):
                    if command["type"] == "provider_account_quiesce":
                        if not self.quiesced:

                            async def stop_owned_execution(timeout: float) -> bool:
                                if harness.id.value == "opencode":
                                    # The service may already be stopped in a retained image.
                                    # Only its supervisor can prove process-group containment.
                                    await harness_control("stop", identity, self.bridge.auth_token)
                                    return True
                                return await harness.stop_execution(timeout) is True

                            stopped = await self.bridge.activity.drain_for_shutdown(
                                deadline=deadline,
                                prompt_error="Provider account switch interrupted this turn",
                                push_cancellation_event=self.bridge._shutdown_push_error_event,
                                stop_execution=stop_owned_execution,
                            )
                            if not stopped:
                                event["reason"] = "stop_not_confirmed"
                                raise RuntimeError("stop not confirmed")
                            await self.bridge._persist_rotated_session_id(harness, strict=True)
                            self.quiesced = True
                        event.update(outcome="quiesced")
                    elif command["type"] == "provider_account_apply":
                        if not self.quiesced:
                            raise RuntimeError("quiescence not established")
                        if not self.applied:
                            if harness.id.value == "opencode":
                                await harness_control("start", identity, self.bridge.auth_token)
                                if not await harness.resume_session(conversation):
                                    event["reason"] = "conversation_unavailable"
                                    raise RuntimeError("conversation unavailable")
                                # A request to the resumed session initializes its actual plugin instance.
                                proof = Path(f"/tmp/provider-account-proof-{provider}.json")
                                while True:
                                    try:
                                        applied = json.loads(proof.read_text())
                                    except (OSError, ValueError):
                                        applied = None
                                    if applied == identity:
                                        break
                                    await asyncio.sleep(0.05)
                            else:
                                await harness.apply_provider_account(
                                    identity, model=model, reasoning_effort=reasoning_effort
                                )
                            self.applied = True
                        event.update(outcome="applied")
                        self.fenced = False
                    else:
                        return
                event.pop("reason", None)
            except Exception:
                # Diagnostics are closed codes; provider SDK bodies can contain credentials.
                self.fenced = True
            await self.bridge._send_event(event)
