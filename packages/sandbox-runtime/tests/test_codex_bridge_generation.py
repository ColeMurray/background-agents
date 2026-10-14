"""Codex credentials follow the authenticated sandbox generation."""

import asyncio
from unittest.mock import AsyncMock

from sandbox_runtime.harness.base import TurnOutcome
from tests.conftest import ScriptedHarness
from tests.test_bridge_harness_lifecycle import _bridge
from tests.test_bridge_shutdown_preparation import (
    GENERATION,
    ShutdownPreparationHarness,
    establish_generation,
    make_bridge,
    prepare_command,
)


async def test_new_generation_reauthenticates_before_releasing_preservation_fence():
    harness = ShutdownPreparationHarness()
    bridge = make_bridge(harness)
    await establish_generation(bridge)
    await bridge._handle_command(prepare_command())
    entered, release = asyncio.Event(), asyncio.Event()

    async def reauthenticate(generation):
        entered.set()
        await release.wait()

    harness.reauthenticate_generation = reauthenticate
    advancing = asyncio.create_task(establish_generation(bridge, {**GENERATION, "createdAt": 2000}))
    await entered.wait()
    assert bridge.shutdown_preparation.fenced
    release.set()
    await advancing
    assert not bridge.shutdown_preparation.fenced


async def test_same_generation_reconnect_does_not_reauthenticate_active_turn():
    harness = ShutdownPreparationHarness()
    bridge = make_bridge(harness)
    await establish_generation(bridge)
    harness.reauthenticate_generation = AsyncMock()
    await establish_generation(bridge)
    harness.reauthenticate_generation.assert_not_awaited()


async def test_failed_generation_reauth_keeps_fence_and_does_not_ack():
    harness = ShutdownPreparationHarness()
    bridge = make_bridge(harness)
    await establish_generation(bridge)
    await bridge._handle_command(prepare_command())
    bridge._send_event.reset_mock()
    harness.reauthenticate_generation = AsyncMock(side_effect=RuntimeError("auth unavailable"))
    bridge.ws = AsyncMock()
    await establish_generation(bridge, {**GENERATION, "createdAt": 2000})
    assert bridge.shutdown_preparation.fenced
    assert bridge._reauthenticating_generation
    bridge._send_event.assert_not_awaited()
    # Reconnecting resends readiness, which makes the control plane resend the generation.
    bridge.ws.close.assert_awaited_once()


async def test_terminal_carries_zero_cost_even_when_step_delivery_is_lost():
    harness = ScriptedHarness()
    harness.run_prompt = AsyncMock(
        return_value=TurnOutcome.failed("native disconnected", message_cost_usd=0)
    )
    bridge = _bridge(harness)
    bridge._prepare_turn = AsyncMock(return_value=(harness, []))
    bridge._persist_rotated_session_id = AsyncMock()
    terminal = await bridge._handle_prompt({"messageId": "msg", "content": "work"})
    assert "costAvailability" not in terminal
    assert "costBasis" not in terminal
    assert terminal["messageCostUsd"] == 0
    assert terminal["success"] is False


async def test_superseded_reauthentication_cannot_ack_or_restore_an_old_generation():
    harness = ShutdownPreparationHarness()
    bridge = make_bridge(harness)
    await establish_generation(bridge)
    old_entered, release_old = asyncio.Event(), asyncio.Event()

    async def reauthenticate(generation):
        if generation["createdAt"] == 2000:
            old_entered.set()
            await release_old.wait()

    harness.reauthenticate_generation = reauthenticate
    old = asyncio.create_task(establish_generation(bridge, {**GENERATION, "createdAt": 2000}))
    await old_entered.wait()
    await establish_generation(bridge, {**GENERATION, "createdAt": 3000})
    release_old.set()
    await old
    assert bridge.shutdown_preparation.state.generation["createdAt"] == 3000
    assert not bridge._reauthenticating_generation
    acknowledgements = [call.args[0] for call in bridge._send_event.await_args_list]
    assert not any(
        event.get("generation", {}).get("createdAt") == 2000 for event in acknowledgements
    )


async def test_existing_harness_without_reauthentication_hook_keeps_generation_behavior():
    harness = ShutdownPreparationHarness()
    bridge = make_bridge(harness)
    await establish_generation(bridge)
    await bridge._handle_command(prepare_command())
    assert not hasattr(harness, "reauthenticate_generation")
    # The pre-Codex path delegates generation ordering to the existing coordinator.
    generation = {**GENERATION, "createdAt": GENERATION["createdAt"] - 1}
    await establish_generation(bridge, generation)
    assert bridge.shutdown_preparation.state.generation == generation
    assert not bridge.shutdown_preparation.fenced
    assert not bridge._reauthenticating_generation


async def test_stale_generation_does_not_reauthenticate_or_ack_codex():
    harness = ShutdownPreparationHarness()
    harness.reauthenticate_generation = AsyncMock()
    bridge = make_bridge(harness)
    await establish_generation(bridge)
    bridge._send_event.reset_mock()
    await establish_generation(bridge, {**GENERATION, "createdAt": GENERATION["createdAt"] - 1})
    assert bridge.shutdown_preparation.state.generation == GENERATION
    harness.reauthenticate_generation.assert_not_awaited()
    bridge._send_event.assert_not_awaited()
