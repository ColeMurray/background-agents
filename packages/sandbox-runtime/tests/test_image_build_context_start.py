"""Behavioral tests for the stdin-context image-build launch protocol."""

import asyncio
import json
import os
import signal
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime import entrypoint, image_build_context_start
from sandbox_runtime.constants import IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_VAR
from sandbox_runtime.image_build_context_start import (
    DEFERRED_START_ENV_VAR,
    IMAGE_BUILD_CONTEXT_START_ARGUMENT,
    MAX_IMAGE_BUILD_CONTEXT_BYTES,
    ImageBuildContextError,
    compose_image_build_environment,
    deferred_start_requested,
    parse_image_build_context,
    run_deferred_start,
    run_image_build_context_start,
)
from sandbox_runtime.repo_image_callback import (
    BUILD_ID_ENV,
    CALLBACK_TOKEN_ENV,
    CALLBACK_URL_ENV,
    FAILURE_CALLBACK_URL_ENV,
    PROVIDER_SESSION_ID_ENV,
)

TOKEN = "a" * 64


def _context(**overrides) -> dict:
    context = {
        "version": 1,
        "build_id": "imgb-acme-repo-123-abc",
        "provider_session_id": "sandbox-abc123",
        "sandbox_id": "build-env-acme/repo",
        "callback_url": "https://control-plane.test/image-builds/build-complete",
        "failure_callback_url": "https://control-plane.test/image-builds/build-failed",
        "callback_token": TOKEN,
        "execution_timeout_seconds": 1800,
        "repositories": [
            {"repo_owner": "acme", "repo_name": "repo", "branch": "main"},
            {"repo_owner": "acme", "repo_name": "other", "branch": "develop"},
        ],
        "clone": {"host": "github.com", "username": "x-access-token", "token": "clone-secret"},
        "env": {"SCOPE_SECRET": "scope-value"},
    }
    context.update(overrides)
    return context


def _line(context: dict) -> bytes:
    return (json.dumps(context) + "\n").encode("utf-8")


def _reader(payload: bytes, *, eof: bool = True) -> asyncio.StreamReader:
    reader = asyncio.StreamReader(limit=MAX_IMAGE_BUILD_CONTEXT_BYTES + 1)
    if payload:
        reader.feed_data(payload)
    if eof:
        reader.feed_eof()
    return reader


@pytest.fixture
def launch_guard(monkeypatch, tmp_path):
    """Point the one-launch guard at a per-test file."""
    path = tmp_path / "oi-image-build.launched"
    monkeypatch.setattr(image_build_context_start, "IMAGE_BUILD_LAUNCH_GUARD_PATH", str(path))
    return path


@pytest.fixture
def stdin_context(monkeypatch):
    """Feed the launcher one stdin payload instead of the process's own."""

    def feed(payload: bytes, *, eof: bool = True):
        transport = MagicMock()
        monkeypatch.setattr(
            image_build_context_start,
            "_connect_context_reader",
            AsyncMock(return_value=(_reader(payload, eof=eof), transport)),
        )
        return transport

    return feed


class _FakeSupervisor:
    """Records what the launcher composed before it was constructed."""

    def __init__(self, shutdown_event: asyncio.Event, *, succeeds: bool = True):
        self.shutdown_event = shutdown_event
        self.log = MagicMock()
        self.callback = None
        self.observed_env = dict(os.environ)
        self._succeeds = succeeds

    async def run(self, repo_image_callback=None) -> bool:
        self.callback = repo_image_callback
        return self._succeeds


def _supervisor_factory(built: list, *, succeeds: bool = True):
    def build(shutdown_event: asyncio.Event) -> _FakeSupervisor:
        supervisor = _FakeSupervisor(shutdown_event, succeeds=succeeds)
        built.append(supervisor)
        return supervisor

    return build


class TestParseImageBuildContext:
    def test_accepts_a_complete_context(self):
        context = parse_image_build_context(_line(_context())[:-1])

        assert context.build_id == "imgb-acme-repo-123-abc"
        assert context.provider_session_id == "sandbox-abc123"
        assert context.execution_timeout_seconds == 1800
        assert [repository.repo_name for repository in context.repositories] == ["repo", "other"]
        assert context.clone is not None
        assert context.clone.token == "clone-secret"
        assert context.env == {"SCOPE_SECRET": "scope-value"}

    def test_ignores_unknown_members_of_a_version_1_context(self):
        context = parse_image_build_context(_line(_context(future_field="ignored"))[:-1])

        assert context.build_id == "imgb-acme-repo-123-abc"

    def test_accepts_a_clone_identity_without_a_token(self):
        context = parse_image_build_context(
            _line(_context(clone={"host": "gitlab.com", "username": "oauth2"}))[:-1]
        )

        assert context.clone is not None
        assert context.clone.host == "gitlab.com"
        assert context.clone.token is None

    def test_accepts_a_context_without_clone_or_env(self):
        context = parse_image_build_context(_line(_context(clone=None, env=None))[:-1])

        assert context.clone is None
        assert context.env == {}

    @pytest.mark.parametrize(
        ("payload", "reason"),
        [
            (b"{not json", "invalid_json"),
            (b'"a string"', "invalid_context"),
            (b"\xff\xfe", "invalid_encoding"),
        ],
    )
    def test_rejects_undecodable_documents(self, payload, reason):
        with pytest.raises(ImageBuildContextError, match=reason):
            parse_image_build_context(payload)

    @pytest.mark.parametrize(
        ("overrides", "reason"),
        [
            ({"version": 2}, "unsupported_version"),
            ({"version": "1"}, "unsupported_version"),
            ({"build_id": ""}, "invalid_field:build_id"),
            ({"callback_token": "not-a-token"}, "invalid_field:callback_token"),
            ({"execution_timeout_seconds": 0}, "invalid_field:execution_timeout_seconds"),
            ({"execution_timeout_seconds": "1800"}, "invalid_field:execution_timeout_seconds"),
            ({"repositories": []}, "invalid_field:repositories"),
            ({"repositories": [{"repo_owner": "acme"}]}, "missing_field:repo_name"),
            ({"clone": {"host": "github.com"}}, "missing_field:username"),
            ({"clone": {"host": "github.com", "username": "x", "token": 7}}, "invalid_field:token"),
            ({"env": {"KEY": 7}}, "invalid_field:env"),
        ],
    )
    def test_rejects_invalid_fields(self, overrides, reason):
        with pytest.raises(ImageBuildContextError, match=reason):
            parse_image_build_context(_line(_context(**overrides))[:-1])

    @pytest.mark.parametrize(
        "field",
        [
            "build_id",
            "provider_session_id",
            "sandbox_id",
            "callback_url",
            "failure_callback_url",
            "callback_token",
            "execution_timeout_seconds",
            "repositories",
        ],
    )
    def test_rejects_a_context_missing_a_required_field(self, field):
        context = _context()
        del context[field]

        with pytest.raises(ImageBuildContextError, match=f"missing_field:{field}"):
            parse_image_build_context(_line(context)[:-1])


class TestComposeImageBuildEnvironment:
    def test_overlays_system_values_over_the_scope_environment(self):
        context = parse_image_build_context(
            _line(
                _context(
                    env={
                        "SCOPE_SECRET": "scope-value",
                        "IMAGE_BUILD_MODE": "false",
                        "SANDBOX_ID": "hijacked",
                        BUILD_ID_ENV: "hijacked",
                        CALLBACK_TOKEN_ENV: "hijacked",
                        "VCS_CLONE_TOKEN": "scope-clone-token",
                    }
                )
            )[:-1]
        )
        environment = {
            "PATH": "/usr/bin",
            "FROM_REPO_IMAGE": "true",
            DEFERRED_START_ENV_VAR: "true",
            PROVIDER_SESSION_ID_ENV: "stale",
        }

        compose_image_build_environment(context, environment)

        assert environment["SCOPE_SECRET"] == "scope-value"
        assert environment["PATH"] == "/usr/bin"
        assert environment["SANDBOX_ID"] == "build-env-acme/repo"
        assert environment["IMAGE_BUILD_MODE"] == "true"
        assert environment["REPO_OWNER"] == "acme"
        assert environment["REPO_NAME"] == "repo"
        assert environment[IMAGE_BUILD_EXECUTION_TIMEOUT_ENV_VAR] == "1800"
        assert environment["VCS_HOST"] == "github.com"
        assert environment["VCS_CLONE_USERNAME"] == "x-access-token"
        # The brokered token wins over a scope-supplied one, exactly as
        # applyScmCloneEnv overwrites it in the shared build environment.
        assert environment["VCS_CLONE_TOKEN"] == "clone-secret"
        # The dormant marker and every inherited boot/callback key are gone, so
        # the build cannot inherit a stale mode or a stale callback identity.
        assert DEFERRED_START_ENV_VAR not in environment
        assert "FROM_REPO_IMAGE" not in environment
        for key in (
            BUILD_ID_ENV,
            CALLBACK_URL_ENV,
            FAILURE_CALLBACK_URL_ENV,
            CALLBACK_TOKEN_ENV,
            PROVIDER_SESSION_ID_ENV,
        ):
            assert key not in environment

    def test_session_config_carries_the_ordered_repository_manifest(self):
        context = parse_image_build_context(_line(_context())[:-1])
        environment: dict[str, str] = {}

        compose_image_build_environment(context, environment)

        assert json.loads(environment["SESSION_CONFIG"]) == {
            "branch": "main",
            "repositories": [
                {"repo_owner": "acme", "repo_name": "repo", "branch": "main"},
                {"repo_owner": "acme", "repo_name": "other", "branch": "develop"},
            ],
        }

    def test_omits_the_clone_token_when_none_was_brokered(self):
        context = parse_image_build_context(
            _line(_context(clone={"host": "gitlab.com", "username": "oauth2"}))[:-1]
        )
        environment = {"VCS_CLONE_TOKEN": "stale"}

        compose_image_build_environment(context, environment)

        assert environment["VCS_HOST"] == "gitlab.com"
        # A credential baked into the image is still dropped; only the scope's
        # own environment may supply one.
        assert "VCS_CLONE_TOKEN" not in environment

    def test_keeps_a_scope_clone_token_when_none_was_brokered(self):
        context = parse_image_build_context(
            _line(
                _context(
                    clone={"host": "gitlab.com", "username": "oauth2"},
                    env={"VCS_CLONE_TOKEN": "scope-clone-token"},
                )
            )[:-1]
        )
        environment = {"VCS_CLONE_TOKEN": "stale"}

        compose_image_build_environment(context, environment)

        # Same rule as buildImageBuildEnvVars on every other provider: with no
        # brokered token, a scope-supplied one is what the credential helper
        # clones with.
        assert environment["VCS_CLONE_TOKEN"] == "scope-clone-token"
        assert environment["VCS_HOST"] == "gitlab.com"
        assert environment["VCS_CLONE_USERNAME"] == "oauth2"


class TestDeferredStart:
    def test_only_the_exact_marker_defers_the_boot(self):
        assert deferred_start_requested({DEFERRED_START_ENV_VAR: "true"}) is True
        assert deferred_start_requested({DEFERRED_START_ENV_VAR: "false"}) is False
        assert deferred_start_requested({DEFERRED_START_ENV_VAR: "TRUE"}) is False
        assert deferred_start_requested({}) is False

    @pytest.mark.asyncio
    async def test_idles_until_stopped(self):
        task = asyncio.create_task(run_deferred_start())
        await asyncio.sleep(0)

        os.kill(os.getpid(), signal.SIGTERM)

        assert await asyncio.wait_for(task, timeout=5) == 0

    @pytest.mark.asyncio
    async def test_entrypoint_composes_nothing_while_deferred(self, monkeypatch):
        monkeypatch.setenv(DEFERRED_START_ENV_VAR, "true")
        supervisor_class = MagicMock()
        monkeypatch.setattr(entrypoint, "SandboxSupervisor", supervisor_class)
        monkeypatch.setattr(entrypoint, "install_signal_handlers", MagicMock())

        task = asyncio.create_task(entrypoint.main([]))
        await asyncio.sleep(0)
        os.kill(os.getpid(), signal.SIGTERM)

        assert await asyncio.wait_for(task, timeout=5) == 0
        supervisor_class.assert_not_called()


class TestContextStartLauncher:
    @pytest.mark.asyncio
    async def test_composes_the_build_once_and_keeps_the_token_out_of_the_environment(
        self, monkeypatch, launch_guard, stdin_context
    ):
        monkeypatch.setenv(DEFERRED_START_ENV_VAR, "true")
        monkeypatch.setenv("IMAGE_BUILD_MODE", "false")
        transport = stdin_context(_line(_context()))
        built: list[_FakeSupervisor] = []

        exit_code = await run_image_build_context_start(_supervisor_factory(built), MagicMock())

        assert exit_code == 0
        assert len(built) == 1
        supervisor = built[0]
        assert supervisor.observed_env["IMAGE_BUILD_MODE"] == "true"
        assert supervisor.observed_env["SANDBOX_ID"] == "build-env-acme/repo"
        assert supervisor.observed_env["SCOPE_SECRET"] == "scope-value"
        assert supervisor.observed_env["VCS_CLONE_TOKEN"] == "clone-secret"
        assert DEFERRED_START_ENV_VAR not in supervisor.observed_env
        # The callback token rides the callback object; the build's children
        # (setup hooks included) never see it in their environment.
        assert CALLBACK_TOKEN_ENV not in supervisor.observed_env
        assert CALLBACK_TOKEN_ENV not in os.environ
        assert supervisor.callback is not None
        assert supervisor.callback.token == TOKEN
        assert supervisor.callback.build_id == "imgb-acme-repo-123-abc"
        assert supervisor.callback.provider_session_id == "sandbox-abc123"
        transport.close.assert_called_once_with()
        assert launch_guard.read_text() == "imgb-acme-repo-123-abc"

    @pytest.mark.asyncio
    async def test_reports_a_failed_build(self, launch_guard, stdin_context):
        stdin_context(_line(_context()))
        built: list[_FakeSupervisor] = []

        exit_code = await run_image_build_context_start(
            _supervisor_factory(built, succeeds=False), MagicMock()
        )

        assert exit_code == 1
        assert len(built) == 1

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "payload",
        [
            b"{not json\n",
            b"",
            json.dumps(_context()).encode("utf-8"),
            json.dumps(_context(version=2)).encode("utf-8") + b"\n",
            json.dumps(_context(callback_token="short")).encode("utf-8") + b"\n",
        ],
        ids=["invalid_json", "stdin_closed", "incomplete_line", "wrong_version", "invalid_token"],
    )
    async def test_fails_closed_without_building_a_supervisor(
        self, launch_guard, stdin_context, payload
    ):
        stdin_context(payload)
        built: list[_FakeSupervisor] = []

        exit_code = await run_image_build_context_start(_supervisor_factory(built), MagicMock())

        assert exit_code == 1
        assert built == []

    @pytest.mark.asyncio
    async def test_rejects_an_oversized_context(self, launch_guard, stdin_context):
        padded = _context(env={"BIG": "x" * (MAX_IMAGE_BUILD_CONTEXT_BYTES + 16)})
        stdin_context(_line(padded))
        built: list[_FakeSupervisor] = []

        exit_code = await run_image_build_context_start(_supervisor_factory(built), MagicMock())

        assert exit_code == 1
        assert built == []

    @pytest.mark.asyncio
    async def test_refuses_a_second_launch_on_the_same_sandbox(self, launch_guard, stdin_context):
        launch_guard.write_text("imgb-earlier-build")
        stdin_context(_line(_context()))
        built: list[_FakeSupervisor] = []

        exit_code = await run_image_build_context_start(_supervisor_factory(built), MagicMock())

        assert exit_code == 1
        assert built == []
        assert launch_guard.read_text() == "imgb-earlier-build"

    @pytest.mark.asyncio
    async def test_exits_cleanly_when_stopped_before_its_context_arrives(
        self, launch_guard, stdin_context
    ):
        transport = stdin_context(b"", eof=False)
        built: list[_FakeSupervisor] = []

        task = asyncio.create_task(
            run_image_build_context_start(_supervisor_factory(built), MagicMock())
        )
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        os.kill(os.getpid(), signal.SIGTERM)

        assert await asyncio.wait_for(task, timeout=5) == 0
        assert built == []
        transport.close.assert_called_once_with()


class TestEntrypointRouting:
    @pytest.mark.asyncio
    async def test_routes_the_context_argument_to_the_launcher(self, monkeypatch):
        monkeypatch.setenv(DEFERRED_START_ENV_VAR, "true")
        launcher = AsyncMock(return_value=0)
        monkeypatch.setattr(entrypoint, "run_image_build_context_start", launcher)
        monkeypatch.setattr(entrypoint, "SandboxSupervisor", MagicMock())

        exit_code = await entrypoint.main([IMAGE_BUILD_CONTEXT_START_ARGUMENT])

        assert exit_code == 0
        # The launcher owns environment composition, so it is handed the
        # supervisor factory rather than a supervisor built from the dormant
        # sandbox's environment.
        launcher.assert_awaited_once_with(
            entrypoint.build_supervisor, entrypoint.install_signal_handlers
        )


def test_launch_protocol_constants_match_the_cross_plane_manifest():
    manifest = json.loads(
        (
            Path(image_build_context_start.__file__).parent / "image_build_callback_env.json"
        ).read_text()
    )

    assert manifest["deferred_start_env_var"] == DEFERRED_START_ENV_VAR
    assert manifest["context_start_argument"] == IMAGE_BUILD_CONTEXT_START_ARGUMENT
