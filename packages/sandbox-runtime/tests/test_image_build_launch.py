"""Behavioral tests for the one-shot image-build launch protocol."""

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime import image_build_launch
from sandbox_runtime.image_build_launch import (
    MAX_LAUNCH_PAYLOAD_BYTES,
    ImageBuildLaunchCancelled,
    ImageBuildLaunchError,
    read_image_build_launch,
)
from sandbox_runtime.repo_image_callback import (
    BUILD_ID_ENV,
    CALLBACK_TOKEN_ENV,
    CALLBACK_URL_ENV,
    FAILURE_CALLBACK_URL_ENV,
    PROVIDER_SESSION_ID_ENV,
)


def _payload(**overrides: object) -> bytes:
    values = {
        "version": 1,
        "build_id": "imgb-acme-repo-123-abc",
        "provider_session_id": "sb-provider-123",
        "callback_url": "https://control-plane.test/image-builds/build-complete",
        "failure_callback_url": "https://control-plane.test/image-builds/build-failed",
        "callback_token": "callback-token",
        **overrides,
    }
    return (json.dumps(values) + "\n").encode()


@pytest.mark.asyncio
async def test_valid_launch_creates_memory_only_callback_reporter():
    reader = asyncio.StreamReader()
    reader.feed_data(_payload())
    shutdown_event = asyncio.Event()

    launch = await read_image_build_launch(
        reader,
        expected_build_id="imgb-acme-repo-123-abc",
        shutdown_event=shutdown_event,
    )

    assert launch.build_id == "imgb-acme-repo-123-abc"
    assert launch.provider_session_id == "sb-provider-123"
    assert launch.callback.token == "callback-token"
    assert launch.callback.callback_url.endswith("/image-builds/build-complete")


@pytest.mark.asyncio
async def test_launch_rejects_build_id_that_does_not_match_create_time_identity():
    reader = asyncio.StreamReader()
    reader.feed_data(_payload(build_id="imgb-other-repo-456-def"))

    with pytest.raises(ImageBuildLaunchError, match="build_id_mismatch"):
        await read_image_build_launch(
            reader,
            expected_build_id="imgb-acme-repo-123-abc",
            shutdown_event=asyncio.Event(),
        )


@pytest.mark.asyncio
async def test_launch_rejects_unsupported_protocol_version():
    reader = asyncio.StreamReader()
    reader.feed_data(_payload(version=2))

    with pytest.raises(ImageBuildLaunchError, match="unsupported_version"):
        await read_image_build_launch(
            reader,
            expected_build_id="imgb-acme-repo-123-abc",
            shutdown_event=asyncio.Event(),
        )


@pytest.mark.asyncio
async def test_launch_rejects_boolean_protocol_version():
    reader = asyncio.StreamReader()
    reader.feed_data(_payload(version=True))

    with pytest.raises(ImageBuildLaunchError, match="unsupported_version"):
        await read_image_build_launch(
            reader,
            expected_build_id="imgb-acme-repo-123-abc",
            shutdown_event=asyncio.Event(),
        )


@pytest.mark.asyncio
async def test_launch_rejects_unknown_fields():
    reader = asyncio.StreamReader()
    reader.feed_data(_payload(unexpected="value"))

    with pytest.raises(ImageBuildLaunchError, match="invalid_fields"):
        await read_image_build_launch(
            reader,
            expected_build_id="imgb-acme-repo-123-abc",
            shutdown_event=asyncio.Event(),
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "field",
    [
        "build_id",
        "provider_session_id",
        "callback_url",
        "failure_callback_url",
        "callback_token",
    ],
)
async def test_launch_rejects_blank_required_values(field):
    reader = asyncio.StreamReader()
    reader.feed_data(_payload(**{field: ""}))

    with pytest.raises(ImageBuildLaunchError, match=f"invalid_{field}"):
        await read_image_build_launch(
            reader,
            expected_build_id=("" if field == "build_id" else "imgb-acme-repo-123-abc"),
            shutdown_event=asyncio.Event(),
        )


@pytest.mark.asyncio
async def test_launch_enforces_byte_limit_before_parsing_json():
    reader = asyncio.StreamReader()
    reader.feed_data(_payload(callback_token="x" * MAX_LAUNCH_PAYLOAD_BYTES))

    with pytest.raises(ImageBuildLaunchError, match="payload_too_large"):
        await read_image_build_launch(
            reader,
            expected_build_id="imgb-acme-repo-123-abc",
            shutdown_event=asyncio.Event(),
        )


@pytest.mark.asyncio
async def test_launch_maps_stream_reader_limit_failure_to_safe_reason():
    reader = asyncio.StreamReader(limit=MAX_LAUNCH_PAYLOAD_BYTES + 1)
    reader.feed_data(b"x" * (MAX_LAUNCH_PAYLOAD_BYTES + 2) + b"\n")

    with pytest.raises(ImageBuildLaunchError, match="payload_too_large"):
        await read_image_build_launch(
            reader,
            expected_build_id="imgb-acme-repo-123-abc",
            shutdown_event=asyncio.Event(),
        )


@pytest.mark.asyncio
async def test_launch_rejects_eof_after_partial_payload():
    reader = asyncio.StreamReader()
    reader.feed_data(_payload().rstrip(b"\n"))
    reader.feed_eof()

    with pytest.raises(ImageBuildLaunchError, match="incomplete_payload"):
        await read_image_build_launch(
            reader,
            expected_build_id="imgb-acme-repo-123-abc",
            shutdown_event=asyncio.Event(),
        )


@pytest.mark.asyncio
async def test_launch_rejects_empty_eof():
    reader = asyncio.StreamReader()
    reader.feed_eof()

    with pytest.raises(ImageBuildLaunchError, match="stdin_closed"):
        await read_image_build_launch(
            reader,
            expected_build_id="imgb-acme-repo-123-abc",
            shutdown_event=asyncio.Event(),
        )


@pytest.mark.asyncio
async def test_launch_rejects_non_http_callback_urls():
    reader = asyncio.StreamReader()
    reader.feed_data(_payload(callback_url="file:///tmp/callback"))

    with pytest.raises(ImageBuildLaunchError, match="invalid_callback_url"):
        await read_image_build_launch(
            reader,
            expected_build_id="imgb-acme-repo-123-abc",
            shutdown_event=asyncio.Event(),
        )


@pytest.mark.asyncio
async def test_launch_preserves_endpoint_validated_local_http_callback():
    reader = asyncio.StreamReader()
    reader.feed_data(_payload(callback_url="http://localhost:8787/image-builds/build-complete"))

    launch = await read_image_build_launch(
        reader,
        expected_build_id="imgb-acme-repo-123-abc",
        shutdown_event=asyncio.Event(),
    )

    assert launch.callback.callback_url.startswith("http://localhost:8787/")


@pytest.mark.asyncio
async def test_launch_rejects_invalid_provider_session_id_shape():
    reader = asyncio.StreamReader()
    reader.feed_data(_payload(provider_session_id="sb id with spaces"))

    with pytest.raises(ImageBuildLaunchError, match="invalid_provider_session_id"):
        await read_image_build_launch(
            reader,
            expected_build_id="imgb-acme-repo-123-abc",
            shutdown_event=asyncio.Event(),
        )


@pytest.mark.asyncio
async def test_shutdown_cancels_an_incomplete_pipe_read_cleanly():
    reader = asyncio.StreamReader()
    reader.feed_data(b'{"version":1')
    shutdown_event = asyncio.Event()
    operation = asyncio.create_task(
        read_image_build_launch(
            reader,
            expected_build_id="imgb-acme-repo-123-abc",
            shutdown_event=shutdown_event,
        )
    )
    await asyncio.sleep(0)
    assert not operation.done()

    shutdown_event.set()

    with pytest.raises(ImageBuildLaunchCancelled):
        await operation


@pytest.mark.asyncio
async def test_cancelling_receiver_cleans_up_pipe_read_task():
    read_cancelled = asyncio.Event()

    class BlockingReader:
        async def readline(self):
            try:
                await asyncio.Event().wait()
            finally:
                read_cancelled.set()

    operation = asyncio.create_task(
        read_image_build_launch(
            BlockingReader(),
            expected_build_id="imgb-acme-repo-123-abc",
            shutdown_event=asyncio.Event(),
        )
    )
    await asyncio.sleep(0)

    operation.cancel()
    with pytest.raises(asyncio.CancelledError):
        await operation

    assert read_cancelled.is_set()


@pytest.mark.asyncio
async def test_gated_entrypoint_runs_supervisor_with_in_memory_callback(monkeypatch):
    from sandbox_runtime import entrypoint

    for name in (
        BUILD_ID_ENV,
        CALLBACK_URL_ENV,
        FAILURE_CALLBACK_URL_ENV,
        CALLBACK_TOKEN_ENV,
        PROVIDER_SESSION_ID_ENV,
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("OI_IMAGE_BUILD_ID", "imgb-acme-repo-123-abc")
    monkeypatch.setenv("IMAGE_BUILD_MODE", "true")
    monkeypatch.setenv("SANDBOX_ID", "build-imgb-acme-repo-123-abc")
    monkeypatch.setenv("REPO_OWNER", "acme")
    monkeypatch.setenv("REPO_NAME", "repo")
    monkeypatch.setenv("SESSION_CONFIG", "{}")

    reader = asyncio.StreamReader()
    reader.feed_data(_payload())
    transport = MagicMock()
    monkeypatch.setattr(
        image_build_launch,
        "_connect_stdin_reader",
        AsyncMock(return_value=(reader, transport)),
    )
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())

    observed_hook_env = {}
    observed_supervisor = {}

    async def finish_build(supervisor, _expected_tunnel_ports):
        observed_supervisor["value"] = supervisor
        observed_hook_env.update(supervisor._hook_env())
        return entrypoint.RepositoryBootResult(True, "abc123", [], True, None)

    monkeypatch.setattr(entrypoint.SandboxSupervisor, "_run_image_build_execution", finish_build)

    async def report_success_and_release(**_kwargs):
        observed_supervisor["value"].shutdown_event.set()
        return True

    report_success = AsyncMock(side_effect=report_success_and_release)
    monkeypatch.setattr(
        "sandbox_runtime.repo_image_callback.RepoImageBuildCallback.report_success",
        report_success,
    )

    exit_code = await entrypoint.main(["--await-image-build-start-stdin-v1"])

    assert exit_code == 0
    report_success.assert_awaited_once()
    assert CALLBACK_TOKEN_ENV not in entrypoint.os.environ
    assert CALLBACK_TOKEN_ENV not in observed_hook_env
    assert CALLBACK_URL_ENV not in observed_hook_env
    transport.close.assert_called_once_with()


@pytest.mark.asyncio
async def test_unflagged_entrypoint_uses_legacy_environment_path(monkeypatch):
    from sandbox_runtime import entrypoint

    run = AsyncMock()
    supervisor = MagicMock(run=run, shutdown_event=asyncio.Event())
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())
    connect_stdin = AsyncMock()
    monkeypatch.setattr(image_build_launch, "_connect_stdin_reader", connect_stdin)

    exit_code = await entrypoint.main([])

    assert exit_code == 0
    run.assert_awaited_once_with()
    connect_stdin.assert_not_awaited()


@pytest.mark.asyncio
async def test_gated_entrypoint_fails_closed_outside_image_build_mode(monkeypatch):
    from sandbox_runtime import entrypoint

    monkeypatch.setenv("OI_IMAGE_BUILD_ID", "imgb-acme-repo-123-abc")
    monkeypatch.delenv("IMAGE_BUILD_MODE", raising=False)
    run = AsyncMock()
    supervisor = MagicMock(run=run, shutdown_event=asyncio.Event())
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())
    connect_stdin = AsyncMock()
    monkeypatch.setattr(image_build_launch, "_connect_stdin_reader", connect_stdin)

    exit_code = await entrypoint.main(["--await-image-build-start-stdin-v1"])

    assert exit_code == 1
    run.assert_not_awaited()
    connect_stdin.assert_not_awaited()
    supervisor.log.error.assert_called_once_with(
        "image_build.launch_failed", reason="invalid_build_mode"
    )


@pytest.mark.asyncio
async def test_gated_entrypoint_rejects_malformed_payload_without_starting(monkeypatch):
    from sandbox_runtime import entrypoint

    monkeypatch.setenv("OI_IMAGE_BUILD_ID", "imgb-acme-repo-123-abc")
    monkeypatch.setenv("IMAGE_BUILD_MODE", "true")
    reader = asyncio.StreamReader()
    reader.feed_data(b"{malformed\n")
    transport = MagicMock()
    run = AsyncMock()
    supervisor = MagicMock(run=run, shutdown_event=asyncio.Event())
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())
    monkeypatch.setattr(
        image_build_launch,
        "_connect_stdin_reader",
        AsyncMock(return_value=(reader, transport)),
    )

    exit_code = await entrypoint.main(["--await-image-build-start-stdin-v1"])

    assert exit_code == 1
    run.assert_not_awaited()
    supervisor.log.error.assert_called_once_with(
        "image_build.launch_failed",
        build_id="imgb-acme-repo-123-abc",
        reason="invalid_json",
    )
    transport.close.assert_called_once_with()


@pytest.mark.asyncio
async def test_gated_entrypoint_accepts_only_first_payload(monkeypatch):
    from sandbox_runtime import entrypoint

    monkeypatch.setenv("OI_IMAGE_BUILD_ID", "imgb-acme-repo-123-abc")
    monkeypatch.setenv("IMAGE_BUILD_MODE", "true")
    reader = asyncio.StreamReader()
    reader.feed_data(_payload() + _payload(callback_token="second-token"))
    transport = MagicMock()
    run = AsyncMock()
    supervisor = MagicMock(run=run, shutdown_event=asyncio.Event())
    monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock(return_value=supervisor))
    monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())
    monkeypatch.setattr(
        image_build_launch,
        "_connect_stdin_reader",
        AsyncMock(return_value=(reader, transport)),
    )

    exit_code = await entrypoint.main(["--await-image-build-start-stdin-v1"])

    assert exit_code == 0
    run.assert_awaited_once()
    callback = run.await_args.args[0]
    assert callback.token == "callback-token"
