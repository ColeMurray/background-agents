"""Provider termination must confirm cessation, not just submit a stop request."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import modal
import pytest
from fastapi import HTTPException

from src import web_api
from src.sandbox import manager as manager_module


async def _call_terminate(request, authorization="Bearer test"):
    return await web_api.api_terminate_sandbox.get_raw_f()(
        request,
        authorization=authorization,
        x_trace_id=None,
        x_request_id=None,
        x_session_id=None,
        x_sandbox_id=None,
    )


def _mock_lookup(monkeypatch, *, terminate=None, lookup_error=None):
    terminate = terminate or AsyncMock(return_value=137)
    lookup = AsyncMock(
        return_value=SimpleNamespace(terminate=SimpleNamespace(aio=terminate)),
        side_effect=lookup_error,
    )
    monkeypatch.setattr(manager_module.modal.Sandbox, "from_id", SimpleNamespace(aio=lookup))
    return lookup, terminate


@pytest.mark.asyncio
async def test_termination_response_waits_for_provider_confirmation(monkeypatch):
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)
    requested = asyncio.Event()
    confirmed = asyncio.Event()

    async def terminate(*, wait):
        assert wait is True
        requested.set()
        await confirmed.wait()
        return 137

    lookup, _ = _mock_lookup(monkeypatch, terminate=terminate)
    task = asyncio.create_task(_call_terminate({"sandbox_id": "sb-object-1"}))
    try:
        await asyncio.wait_for(requested.wait(), timeout=1)
        assert not task.done()
        confirmed.set()
        response = await asyncio.wait_for(task, timeout=1)
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    lookup.assert_awaited_once_with("sb-object-1")
    assert response == {
        "success": True,
        "data": {"sandbox_id": "sb-object-1", "terminated": True},
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["lookup", "termination"])
async def test_absent_sandbox_is_confirmed_idempotently(monkeypatch, phase):
    not_found = modal.exception.NotFoundError("already absent")
    lookup, terminate = _mock_lookup(
        monkeypatch,
        lookup_error=not_found if phase == "lookup" else None,
        terminate=AsyncMock(side_effect=not_found) if phase == "termination" else None,
    )

    await manager_module.SandboxManager().terminate_sandbox("sb-object-1")

    lookup.assert_awaited_once_with("sb-object-1")
    if phase == "termination":
        terminate.assert_awaited_once_with(wait=True)
    else:
        terminate.assert_not_awaited()


@pytest.mark.asyncio
async def test_provider_expired_terminal_result_is_confirmed(monkeypatch):
    _mock_lookup(
        monkeypatch, terminate=AsyncMock(side_effect=modal.exception.SandboxTimeoutError())
    )

    await manager_module.SandboxManager().terminate_sandbox("sb-object-1")


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["lookup", "termination"])
async def test_provider_failures_do_not_confirm_termination(monkeypatch, phase):
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)
    failure = RuntimeError("sensitive provider response")
    _mock_lookup(
        monkeypatch,
        lookup_error=failure if phase == "lookup" else None,
        terminate=AsyncMock(side_effect=failure) if phase == "termination" else None,
    )

    with pytest.raises(HTTPException) as exc_info:
        await _call_terminate({"sandbox_id": "sb-object-1"})

    assert exc_info.value.status_code == 500
    assert exc_info.value.detail == "Internal server error"


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["lookup", "termination"])
async def test_hung_provider_operation_is_bounded_and_unconfirmed(monkeypatch, phase):
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)
    monkeypatch.setattr(manager_module, "SANDBOX_TERMINATION_TIMEOUT_SECONDS", 0.01)
    cancelled = asyncio.Event()

    async def hang(*_args, **_kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    lookup, _ = _mock_lookup(monkeypatch, terminate=hang if phase == "termination" else None)
    if phase == "lookup":
        lookup.side_effect = hang

    with pytest.raises(HTTPException) as exc_info:
        await asyncio.wait_for(_call_terminate({"sandbox_id": "sb-object-1"}), timeout=1)

    assert exc_info.value.status_code == 504
    assert cancelled.is_set()


@pytest.mark.asyncio
async def test_acknowledgement_without_exit_code_is_unconfirmed(monkeypatch):
    _mock_lookup(monkeypatch, terminate=AsyncMock(return_value=None))

    with pytest.raises(RuntimeError, match="did not confirm"):
        await manager_module.SandboxManager().terminate_sandbox("sb-object-1")


@pytest.mark.asyncio
async def test_authentication_precedes_validation_and_provider_lookup(monkeypatch):
    monkeypatch.setattr(web_api, "verify_internal_token", lambda _authorization: False)
    lookup, _ = _mock_lookup(monkeypatch)

    with pytest.raises(HTTPException) as exc_info:
        await _call_terminate({}, authorization=None)

    assert exc_info.value.status_code == 401
    lookup.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [{}, {"sandbox_id": ""}, {"sandbox_id": 123}])
async def test_invalid_target_is_rejected_before_provider_lookup(monkeypatch, payload):
    monkeypatch.setattr(web_api, "require_auth", lambda _authorization: None)
    lookup, _ = _mock_lookup(monkeypatch)

    with pytest.raises(HTTPException) as exc_info:
        await _call_terminate(payload)

    assert exc_info.value.status_code == 400
    lookup.assert_not_awaited()
