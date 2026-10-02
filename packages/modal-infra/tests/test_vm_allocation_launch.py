"""VM allocation launch adoption, ownership, retirement, deadline, and race behavior."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from modal.exception import AlreadyExistsError, NotFoundError, SandboxTimeoutError

from sandbox_runtime.constants import VNC_PASSWORD_ENV_VAR
from src.sandbox.launch import ACCESS_PASSWORD_READ_TIMEOUT_SECONDS, SandboxLauncher
from src.sandbox.launch_policy import docker_allocation_name, docker_allocation_tags
from src.sandbox.tunnels import SandboxTunnels
from src.sandbox.vm_recovery import VMAllocationOutcome, VMServiceLaunch
from tests.modal_sdk_contract import sandbox_exec_request
from tests.sandbox_launch_helpers import (
    DOCKER_SETTINGS,
    _docker_config,
    _docker_manager,
    _not_found,
)


@pytest.mark.asyncio
@pytest.mark.parametrize("image_source", ["base", "snapshot"])
@pytest.mark.parametrize("holder_exists", [False, True])
async def test_expired_vm_launch_cannot_retire_or_create(monkeypatch, image_source, holder_exists):
    manager, captured, _ = _docker_manager(monkeypatch)
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", lambda _id: object())
    holder = SimpleNamespace(
        object_id="existing-holder",
        get_tags=SimpleNamespace(
            aio=AsyncMock(
                return_value={
                    **docker_allocation_tags("session-1", "sandbox-acme-repo-1699999999999"),
                    "openinspect_generation_created_at_ms": "1699999999999",
                }
            )
        ),
        terminate=SimpleNamespace(aio=AsyncMock()),
    )
    lookup = AsyncMock(side_effect=[holder] if holder_exists else [NotFoundError("not found")])
    monkeypatch.setattr(
        "src.sandbox.launch.modal.Sandbox.from_name",
        SimpleNamespace(aio=lookup),
    )
    if image_source == "base":
        launch = manager.create_sandbox(_docker_config(launch_deadline_at_ms=1))
    else:
        launch = manager.restore_from_snapshot(
            clone_host="github.com",
            clone_username="x-access-token",
            snapshot_image_id="snapshot-1",
            session_config={"session_id": "session-1"},
            sandbox_id="sandbox-acme-repo-1700000000000",
            settings=dict(DOCKER_SETTINGS),
            sandbox_backend="modal-vm",
            launch_deadline_at_ms=1,
        )
    with pytest.raises(VMAllocationOutcome) as exc:
        await launch
    assert exc.value.detail == "window_closed"
    assert "kwargs" not in captured
    lookup.assert_not_awaited()
    holder.terminate.aio.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("has_generation_order", [False, True])
async def test_docker_launch_adopts_an_existing_owned_allocation(monkeypatch, has_generation_order):
    manager, captured, _ = _docker_manager(monkeypatch)
    tags = docker_allocation_tags("session-1", "sandbox-acme-repo-1700000000000")
    if has_generation_order:
        tags["openinspect_generation_created_at_ms"] = "1700000000000"
    existing = SimpleNamespace(object_id="modal-existing", get_tags=AsyncMock(return_value=tags))
    existing.get_tags.aio = existing.get_tags
    from_name = AsyncMock(return_value=existing)
    monkeypatch.setattr(
        "src.sandbox.launch.modal.Sandbox.from_name", SimpleNamespace(aio=from_name)
    )

    handle = await manager.create_sandbox(_docker_config())

    assert "kwargs" not in captured
    assert handle.modal_object_id == "modal-existing"
    from_name.assert_awaited_once_with("open-inspect", docker_allocation_name("session-1"))


@pytest.mark.asyncio
@pytest.mark.parametrize("create_race", [False, True])
@pytest.mark.parametrize("image_source", ["base", "snapshot"])
async def test_docker_retry_returns_the_original_access_credentials(
    monkeypatch, create_race, image_source
):
    manager, captured, _ = _docker_manager(monkeypatch)
    monkeypatch.setattr("src.sandbox.launch.modal.Image.from_id", lambda _id: object())
    monkeypatch.setattr(
        SandboxLauncher, "_generate_code_server_password", Mock(side_effect=["original", "new"])
    )
    monkeypatch.setattr(
        SandboxLauncher, "_generate_vnc_password", Mock(side_effect=["old-vnc", "new-vnc"])
    )
    from_name = AsyncMock(side_effect=NotFoundError("not created"))
    monkeypatch.setattr(
        "src.sandbox.launch.modal.Sandbox.from_name", SimpleNamespace(aio=from_name)
    )

    async def launch():
        config = _docker_config(code_server_enabled=True, vnc_enabled=True)
        if image_source == "base":
            return await manager.create_sandbox(config)
        return await manager.restore_from_snapshot(
            clone_host="github.com",
            clone_username="x-access-token",
            snapshot_image_id="snapshot-1",
            session_config=config.session_config,
            sandbox_id=config.sandbox_id,
            code_server_enabled=True,
            vnc_enabled=True,
            settings=config.settings,
            sandbox_backend=config.sandbox_backend,
        )

    original = await launch()
    original_env = captured["kwargs"]["env"]
    credential_output = json.dumps(
        {key: original_env[key] for key in ("CODE_SERVER_PASSWORD", VNC_PASSWORD_ENV_VAR)}
    )
    process = SimpleNamespace(
        stdout=SimpleNamespace(read=SimpleNamespace(aio=AsyncMock(return_value=credential_output))),
        wait=SimpleNamespace(aio=AsyncMock(return_value=0)),
    )
    existing = SimpleNamespace(
        object_id=original.modal_object_id,
        get_tags=SimpleNamespace(aio=AsyncMock(return_value=captured["kwargs"]["tags"])),
        exec=SimpleNamespace(aio=AsyncMock(return_value=process)),
    )
    from_name.side_effect = [NotFoundError("racing"), existing] if create_race else [existing]
    create = AsyncMock(side_effect=AlreadyExistsError("already created"))
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.create", SimpleNamespace(aio=create))

    adopted = await launch()

    assert adopted.modal_object_id == original.modal_object_id
    assert adopted.code_server_password == original.code_server_password == "original"
    assert adopted.vnc_password == original.vnc_password == "old-vnc"
    assert create.await_count == int(create_race)
    assert existing.exec.aio.call_args.args[-2:] == ("CODE_SERVER_PASSWORD", VNC_PASSWORD_ENV_VAR)
    sandbox_exec_request(*existing.exec.aio.await_args.args, **existing.exec.aio.await_args.kwargs)


@pytest.mark.asyncio
@pytest.mark.parametrize("code_server_enabled", [False, True])
@pytest.mark.parametrize("vnc_enabled", [False, True])
async def test_access_password_read_arguments_match_enabled_services(
    code_server_enabled, vnc_enabled
):
    passwords = {"CODE_SERVER_PASSWORD": "code-password", VNC_PASSWORD_ENV_VAR: "vnc-pass"}
    process = SimpleNamespace(
        stdout=SimpleNamespace(
            read=SimpleNamespace(aio=AsyncMock(return_value=json.dumps(passwords)))
        ),
        wait=SimpleNamespace(aio=AsyncMock(return_value=0)),
    )
    execute = AsyncMock(return_value=process)
    recovered = await SandboxLauncher._read_access_passwords(
        SimpleNamespace(exec=SimpleNamespace(aio=execute)),
        code_server_enabled=code_server_enabled,
        vnc_enabled=vnc_enabled,
    )

    keys = []
    if code_server_enabled:
        keys.append("CODE_SERVER_PASSWORD")
    if vnc_enabled:
        keys.append(VNC_PASSWORD_ENV_VAR)
    assert recovered == {key: passwords[key] for key in keys}
    if not keys:
        execute.assert_not_awaited()
    else:
        execute.assert_awaited_once()
        request = sandbox_exec_request(*execute.await_args.args, **execute.await_args.kwargs)
        assert list(request.command_args[:3]) == ["python", "-I", "-c"]
        assert list(request.command_args[4:]) == keys
        assert request.timeout_secs == ACCESS_PASSWORD_READ_TIMEOUT_SECONDS


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "output,exit_code", [("{}", 0), ('{"CODE_SERVER_PASSWORD": ""}', 0), ("invalid", 0), ("", 1)]
)
async def test_docker_adoption_fails_if_original_credentials_cannot_be_recovered(
    monkeypatch, output, exit_code
):
    manager, captured, _ = _docker_manager(monkeypatch)
    process = SimpleNamespace(
        stdout=SimpleNamespace(read=SimpleNamespace(aio=AsyncMock(return_value=output))),
        wait=SimpleNamespace(aio=AsyncMock(return_value=exit_code)),
    )
    existing = SimpleNamespace(
        object_id="modal-existing",
        get_tags=SimpleNamespace(
            aio=AsyncMock(
                return_value=docker_allocation_tags("session-1", "sandbox-acme-repo-1700000000000")
            )
        ),
        exec=SimpleNamespace(aio=AsyncMock(return_value=process)),
    )
    monkeypatch.setattr(
        "src.sandbox.launch.modal.Sandbox.from_name",
        SimpleNamespace(aio=AsyncMock(return_value=existing)),
    )

    with pytest.raises(RuntimeError, match="Could not recover adopted sandbox access credentials"):
        await manager.create_sandbox(_docker_config(code_server_enabled=True))

    assert "kwargs" not in captured
    SandboxTunnels.resolve.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("create_race", [False, True])
@pytest.mark.parametrize(
    "invalid_tag, invalid_value",
    [
        (None, None),
        ("openinspect_session_id", "another-session"),
        ("openinspect_kind", "other"),
        ("openinspect_backend", "modal"),
        ("openinspect_session_id", None),
        ("openinspect_kind", None),
        ("openinspect_backend", None),
        ("openinspect_sandbox_id", None),
        ("openinspect_sandbox_id", ""),
        ("openinspect_sandbox_id", "g" * 48),
        ("openinspect_sandbox_id", "A" * 48),
        ("openinspect_sandbox_id", "0" * 47),
        ("openinspect_sandbox_id", "0" * 49),
        ("openinspect_generation_created_at_ms", None),
        ("openinspect_generation_created_at_ms", "1700000000000"),
        ("openinspect_generation_created_at_ms", "1700000000001"),
        ("openinspect_generation_created_at_ms", "invalid"),
        ("openinspect_generation_created_at_ms", "-1"),
        ("openinspect_generation_created_at_ms", "0"),
        ("unexpected_tag", "foreign"),
    ],
    ids=[
        "no-tags",
        "another-session",
        "another-kind",
        "another-backend",
        "missing-session",
        "missing-kind",
        "missing-backend",
        "missing-generation",
        "empty-generation",
        "non-hex-generation",
        "uppercase-generation",
        "short-generation",
        "long-generation",
        "legacy-unnamed-generation",
        "equal-generation-order",
        "newer-generation",
        "malformed-generation-order",
        "negative-generation-order",
        "zero-generation-order",
        "unexpected-tag",
    ],
)
async def test_docker_launch_refuses_a_same_named_allocation_it_does_not_own(
    monkeypatch, create_race, invalid_tag, invalid_value
):
    manager, captured, _ = _docker_manager(monkeypatch)
    tags = {
        **docker_allocation_tags("session-1", "sandbox-acme-repo-1699999999999"),
        "openinspect_generation_created_at_ms": "1699999999999",
    }
    if invalid_tag is None:
        tags = {}
    elif invalid_value is None:
        del tags[invalid_tag]
    else:
        tags[invalid_tag] = invalid_value
    foreign = SimpleNamespace(
        object_id="modal-foreign",
        get_tags=SimpleNamespace(aio=AsyncMock(return_value=tags)),
        terminate=SimpleNamespace(aio=AsyncMock()),
    )
    lookup = AsyncMock(side_effect=[NotFoundError("racing"), foreign] if create_race else [foreign])
    monkeypatch.setattr(
        "src.sandbox.launch.modal.Sandbox.from_name",
        SimpleNamespace(aio=lookup),
    )
    created = SimpleNamespace(object_id="unexpected-create")
    create = AsyncMock(
        side_effect=[AlreadyExistsError("name occupied"), created] if create_race else [created]
    )
    monkeypatch.setattr("src.sandbox.launch._create_sandbox", create)

    with pytest.raises(VMAllocationOutcome, match="ownership mismatch") as exc:
        await manager.create_sandbox(_docker_config())

    assert exc.value.detail == "other_generation"
    assert "kwargs" not in captured
    foreign.terminate.aio.assert_not_awaited()
    assert create.await_count == int(create_race)


@pytest.mark.asyncio
async def test_unordered_launch_cannot_retire_an_ordered_holder(monkeypatch):
    manager, captured, _ = _docker_manager(monkeypatch)
    holder = SimpleNamespace(
        object_id="existing-holder",
        get_tags=SimpleNamespace(
            aio=AsyncMock(
                return_value={
                    **docker_allocation_tags("session-1", "sandbox-acme-repo-1699999999999"),
                    "openinspect_generation_created_at_ms": "1699999999999",
                }
            )
        ),
        terminate=SimpleNamespace(aio=AsyncMock()),
    )
    monkeypatch.setattr(
        "src.sandbox.launch.modal.Sandbox.from_name",
        SimpleNamespace(aio=AsyncMock(return_value=holder)),
    )

    with pytest.raises(VMAllocationOutcome, match="ownership mismatch"):
        await manager.create_sandbox(_docker_config(sandbox_id="unversioned-generation"))

    holder.terminate.aio.assert_not_awaited()
    assert "kwargs" not in captured


@pytest.mark.asyncio
async def test_docker_launch_retires_the_prior_generation_only_when_owned(monkeypatch):
    manager, captured, _ = _docker_manager(monkeypatch)
    prior_tags = {
        **docker_allocation_tags("session-1", "sandbox-acme-repo-1699999999999"),
        "openinspect_vm_launch": "1-000-8080-6080-7680",
        "openinspect_vm_ports": "none",
    }
    prior = SimpleNamespace(
        object_id="modal-prior",
        get_tags=AsyncMock(return_value=prior_tags),
        terminate=AsyncMock(),
    )
    prior.get_tags.aio = prior.get_tags
    prior.terminate.aio = prior.terminate
    prior_name = docker_allocation_name("session-1")

    async def from_name(_app, name):
        if name == prior_name and not prior.terminate.await_count:
            return prior
        _not_found()

    monkeypatch.setattr(
        "src.sandbox.launch.modal.Sandbox.from_name", SimpleNamespace(aio=from_name)
    )

    await manager.create_sandbox(
        _docker_config(retire_sandbox_id="sandbox-acme-repo-1699999999999")
    )

    prior.terminate.assert_awaited_once_with(wait=True)
    assert captured["kwargs"]["name"] == docker_allocation_name("session-1")

    prior.terminate.reset_mock()
    prior.get_tags = AsyncMock(return_value={"openinspect_kind": "other"})
    prior.get_tags.aio = prior.get_tags
    with pytest.raises(VMAllocationOutcome, match="ownership mismatch"):
        await manager.create_sandbox(
            _docker_config(retire_sandbox_id="sandbox-acme-repo-1699999999999")
        )
    prior.terminate.assert_not_awaited()


@pytest.mark.asyncio
async def test_docker_launch_retires_a_same_session_vm_that_timed_out(monkeypatch):
    manager, captured, _ = _docker_manager(monkeypatch)
    terminate = AsyncMock(side_effect=SandboxTimeoutError())
    sandbox = SimpleNamespace(
        object_id="modal-prior",
        returncode=124,
        get_tags=SimpleNamespace(
            aio=AsyncMock(return_value=docker_allocation_tags("session-1", "sandbox-prior"))
        ),
        terminate=SimpleNamespace(aio=terminate),
    )
    monkeypatch.setattr(
        "src.sandbox.launch.modal.Sandbox.from_name",
        SimpleNamespace(aio=AsyncMock(return_value=sandbox)),
    )

    await manager.create_sandbox(_docker_config(retire_sandbox_id="sandbox-prior"))

    terminate.assert_awaited_once_with(wait=True)
    assert captured["kwargs"]["name"] == docker_allocation_name("session-1")


@pytest.mark.asyncio
@pytest.mark.parametrize("create_race", [False, True])
async def test_late_predecessor_cannot_materialize_beside_successor(monkeypatch, create_race):
    _docker_manager(monkeypatch)
    launcher = SandboxLauncher()
    predecessor_name = docker_allocation_name("session-1")
    predecessor = SimpleNamespace(
        object_id="late-predecessor",
        get_tags=SimpleNamespace(
            aio=AsyncMock(
                return_value={
                    **docker_allocation_tags("session-1", "sandbox-acme-repo-1699999999999"),
                    "openinspect_generation_created_at_ms": "1699999999999",
                }
            )
        ),
        terminate=SimpleNamespace(aio=AsyncMock()),
    )
    lookup = AsyncMock(
        side_effect=[NotFoundError("still creating"), predecessor] if create_race else [predecessor]
    )
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.from_name", SimpleNamespace(aio=lookup))
    successor = SimpleNamespace(object_id="successor")

    async def create(kwargs, *, repository_image):
        assert kwargs["name"] == predecessor_name
        if not predecessor.terminate.aio.await_count:
            raise AlreadyExistsError("predecessor won the name")
        predecessor.terminate.aio.assert_awaited_once_with(wait=True)
        return successor

    create_mock = AsyncMock(side_effect=create)
    monkeypatch.setattr("src.sandbox.launch._create_sandbox", create_mock)
    sandbox, adopted = await launcher._launch_docker_sandbox(
        session_id="session-1",
        sandbox_id="sandbox-acme-repo-1700000000000",
        create_kwargs={},
        repository_image=False,
        service_launch=VMServiceLaunch(False, False, False, 8080, 6080, 7680, []),
    )

    assert sandbox is successor
    assert not adopted
    predecessor.terminate.aio.assert_awaited_once_with(wait=True)
    assert create_mock.await_count == 1 + int(create_race)


@pytest.mark.asyncio
@pytest.mark.parametrize("retire_sandbox_id", [None, "immediate-predecessor"])
async def test_docker_launch_retires_an_older_same_session_generation(
    monkeypatch, retire_sandbox_id
):
    manager, captured, _ = _docker_manager(monkeypatch)
    older = SimpleNamespace(
        object_id="older-generation",
        get_tags=SimpleNamespace(
            aio=AsyncMock(
                return_value={
                    **docker_allocation_tags("session-1", "sandbox-acme-repo-1699999999998"),
                    **VMServiceLaunch(False, False, False, 8080, 6080, 7680, []).tags(),
                    "openinspect_generation_created_at_ms": "1699999999998",
                }
            )
        ),
        terminate=SimpleNamespace(aio=AsyncMock()),
    )
    monkeypatch.setattr(
        "src.sandbox.launch.modal.Sandbox.from_name",
        SimpleNamespace(aio=AsyncMock(return_value=older)),
    )

    handle = await manager.create_sandbox(_docker_config(retire_sandbox_id=retire_sandbox_id))

    older.terminate.aio.assert_awaited_once_with(wait=True)
    assert captured["kwargs"]["name"] == docker_allocation_name("session-1")
    assert handle.modal_object_id == "modal-object-1"


@pytest.mark.asyncio
@pytest.mark.parametrize("final_holder", ["owned", "stale", "invisible"])
async def test_docker_launch_retries_a_name_race_at_most_once(monkeypatch, final_holder):
    _docker_manager(monkeypatch)
    stale = SimpleNamespace(
        object_id="stale-generation",
        get_tags=SimpleNamespace(
            aio=AsyncMock(
                return_value={
                    **docker_allocation_tags("session-1", "sandbox-acme-repo-1699999999999"),
                    "openinspect_generation_created_at_ms": "1699999999999",
                }
            )
        ),
        terminate=SimpleNamespace(aio=AsyncMock()),
    )
    final = SimpleNamespace(
        object_id="final-holder",
        get_tags=SimpleNamespace(
            aio=AsyncMock(
                return_value={
                    **docker_allocation_tags(
                        "session-1",
                        "sandbox-acme-repo-1700000000000"
                        if final_holder == "owned"
                        else "sandbox-acme-repo-1699999999998",
                    ),
                    "openinspect_generation_created_at_ms": "1700000000000"
                    if final_holder == "owned"
                    else "1699999999998",
                }
            )
        ),
        terminate=SimpleNamespace(aio=AsyncMock()),
    )
    lookup = AsyncMock(
        side_effect=[
            NotFoundError("not created"),
            stale,
            NotFoundError("not visible") if final_holder == "invisible" else final,
        ]
    )
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.from_name", SimpleNamespace(aio=lookup))
    create = AsyncMock(side_effect=AlreadyExistsError("name occupied"))
    monkeypatch.setattr("src.sandbox.launch._create_sandbox", create)
    launch = SandboxLauncher()._launch_docker_sandbox(
        session_id="session-1",
        sandbox_id="sandbox-acme-repo-1700000000000",
        create_kwargs={},
        repository_image=False,
        service_launch=VMServiceLaunch(False, False, False, 8080, 6080, 7680, []),
    )

    if final_holder == "owned":
        sandbox, adopted = await launch
        assert sandbox is final
        assert adopted
        final.terminate.aio.assert_not_awaited()
    else:
        with pytest.raises(VMAllocationOutcome) as exc:
            await launch
        assert exc.value.detail == (
            "other_generation" if final_holder == "stale" else "race_pending"
        )
        final.terminate.aio.assert_not_awaited()

    stale.terminate.aio.assert_awaited_once_with(wait=True)
    assert create.await_count == 2


@pytest.mark.asyncio
async def test_docker_name_race_retry_respects_the_launch_deadline(monkeypatch):
    _docker_manager(monkeypatch)
    now = [0.0]
    stale = SimpleNamespace(
        object_id="stale-generation",
        get_tags=SimpleNamespace(
            aio=AsyncMock(
                return_value={
                    **docker_allocation_tags("session-1", "sandbox-acme-repo-1699999999999"),
                    "openinspect_generation_created_at_ms": "1699999999999",
                }
            )
        ),
        terminate=SimpleNamespace(aio=AsyncMock()),
    )
    monkeypatch.setattr(
        "src.sandbox.launch.modal.Sandbox.from_name",
        SimpleNamespace(aio=AsyncMock(side_effect=[NotFoundError("not created"), stale])),
    )
    monkeypatch.setattr("src.sandbox.launch.time", SimpleNamespace(time=lambda: now[0]))

    async def create_race(*_args, **_kwargs):
        now[0] = 2.0
        raise AlreadyExistsError("name occupied")

    create = AsyncMock(side_effect=create_race)
    monkeypatch.setattr("src.sandbox.launch._create_sandbox", create)

    with pytest.raises(VMAllocationOutcome) as exc:
        await SandboxLauncher()._launch_docker_sandbox(
            session_id="session-1",
            sandbox_id="sandbox-acme-repo-1700000000000",
            create_kwargs={},
            repository_image=False,
            service_launch=VMServiceLaunch(False, False, False, 8080, 6080, 7680, []),
            launch_deadline_at_ms=1000,
        )

    assert exc.value.detail == "window_closed"
    stale.terminate.aio.assert_not_awaited()
    create.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("create_race", [False, True])
async def test_docker_retirement_rechecks_deadline_after_lookup(monkeypatch, create_race):
    _docker_manager(monkeypatch)
    now = [0.0]

    async def read_tags():
        now[0] = 2.0
        return {
            **docker_allocation_tags("session-1", "sandbox-acme-repo-1699999999999"),
            "openinspect_generation_created_at_ms": "1699999999999",
        }

    holder = SimpleNamespace(
        object_id="existing-holder",
        get_tags=SimpleNamespace(aio=AsyncMock(side_effect=read_tags)),
        terminate=SimpleNamespace(aio=AsyncMock()),
    )
    lookup = AsyncMock(side_effect=[NotFoundError("racing"), holder] if create_race else [holder])
    monkeypatch.setattr("src.sandbox.launch.modal.Sandbox.from_name", SimpleNamespace(aio=lookup))
    monkeypatch.setattr("src.sandbox.launch.time", SimpleNamespace(time=lambda: now[0]))
    create = AsyncMock(side_effect=AlreadyExistsError("name occupied"))
    monkeypatch.setattr("src.sandbox.launch._create_sandbox", create)

    with pytest.raises(VMAllocationOutcome) as exc:
        await SandboxLauncher()._launch_docker_sandbox(
            session_id="session-1",
            sandbox_id="sandbox-acme-repo-1700000000000",
            create_kwargs={},
            repository_image=False,
            service_launch=VMServiceLaunch(False, False, False, 8080, 6080, 7680, []),
            launch_deadline_at_ms=1000,
        )

    assert exc.value.detail == "window_closed"
    holder.terminate.aio.assert_not_awaited()
    assert create.await_count == int(create_race)


@pytest.mark.asyncio
@pytest.mark.parametrize("retire_sandbox_id", [None, "sandbox-prior"])
@pytest.mark.parametrize("termination_fails", [False, True])
async def test_docker_successor_waits_for_confirmed_predecessor_retirement(
    monkeypatch, termination_fails, retire_sandbox_id
):
    manager, captured, _ = _docker_manager(monkeypatch)
    termination_requested = asyncio.Event()
    termination_finished = asyncio.Event()

    async def terminate(*, wait=False):
        termination_requested.set()
        if wait:
            await termination_finished.wait()
        if termination_fails:
            raise RuntimeError("termination unconfirmed")

    prior = SimpleNamespace(
        object_id="modal-prior",
        get_tags=SimpleNamespace(
            aio=AsyncMock(
                return_value={
                    **docker_allocation_tags("session-1", "sandbox-prior"),
                    "openinspect_generation_created_at_ms": "1699999999999",
                }
            )
        ),
        terminate=SimpleNamespace(aio=terminate),
    )
    monkeypatch.setattr(
        "src.sandbox.launch.modal.Sandbox.from_name",
        SimpleNamespace(aio=AsyncMock(side_effect=[prior, NotFoundError("no successor")])),
    )
    launch = asyncio.create_task(
        manager.create_sandbox(_docker_config(retire_sandbox_id=retire_sandbox_id))
    )
    try:
        await asyncio.wait_for(termination_requested.wait(), timeout=1)
        assert not launch.done()
        assert "kwargs" not in captured

        termination_finished.set()
        if termination_fails:
            with pytest.raises(RuntimeError, match="termination unconfirmed"):
                await launch
            assert "kwargs" not in captured
        else:
            await launch
            assert "kwargs" in captured
    finally:
        launch.cancel()
        await asyncio.gather(launch, return_exceptions=True)
