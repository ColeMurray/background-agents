"""Tests for the async image builder (v2)."""

import json
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from sandbox_runtime.auth.internal import generate_internal_token, verify_internal_token
from src.sandbox.manager import SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS
from src.scheduler.image_builder import (
    CALLBACK_BACKOFF_BASE,
    CALLBACK_MAX_RETRIES,
    BuildError,
    _callback_with_retry,
    _stream_build_logs,
    build_repo_image,
)


class TestGenerateInternalToken:
    """Test the generate_internal_token function."""

    def test_generates_valid_token(self):
        """Generated token should pass verification."""
        secret = "test-secret-key"
        token = generate_internal_token(secret)

        # Token format: timestamp.signature
        parts = token.split(".")
        assert len(parts) == 2

        timestamp_str, signature = parts
        assert timestamp_str.isdigit()
        assert len(signature) == 64  # SHA-256 hex

        # Token should verify
        auth_header = f"Bearer {token}"
        assert verify_internal_token(auth_header, secret) is True

    def test_token_rejected_with_wrong_secret(self):
        """Token should fail verification with different secret."""
        token = generate_internal_token("secret-1")
        auth_header = f"Bearer {token}"
        assert verify_internal_token(auth_header, "secret-2") is False

    def test_timestamp_is_milliseconds(self):
        """Token timestamp should be in milliseconds."""
        token = generate_internal_token("test-secret")
        timestamp_str = token.split(".")[0]
        timestamp_ms = int(timestamp_str)

        # Should be within 1 second of current time in milliseconds
        now_ms = int(time.time() * 1000)
        assert abs(now_ms - timestamp_ms) < 1000


class TestCallbackWithRetry:
    """Test the _callback_with_retry function."""

    @pytest.mark.asyncio
    async def test_success_on_first_try(self):
        """Should succeed on first attempt."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("src.scheduler.image_builder.httpx.AsyncClient", return_value=mock_client):
            result = await _callback_with_retry(
                "https://example.com/callback",
                {"build_id": "test-123"},
                secret="test-secret",
            )

        assert result is True
        mock_client.post.assert_called_once()

    @pytest.mark.asyncio
    async def test_retries_on_failure(self):
        """Should retry on failure with backoff."""
        mock_response_fail = MagicMock()
        mock_response_fail.status_code = 500
        mock_response_fail.raise_for_status = MagicMock(
            side_effect=httpx.HTTPStatusError(
                "500",
                request=httpx.Request("POST", "http://test"),
                response=httpx.Response(500),
            )
        )

        mock_response_ok = MagicMock()
        mock_response_ok.status_code = 200
        mock_response_ok.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=[mock_response_fail, mock_response_ok])
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with (
            patch("src.scheduler.image_builder.httpx.AsyncClient", return_value=mock_client),
            patch(
                "src.scheduler.image_builder.asyncio.sleep", new_callable=AsyncMock
            ) as mock_sleep,
        ):
            result = await _callback_with_retry(
                "https://example.com/callback",
                {"build_id": "test-123"},
                secret="test-secret",
            )

        assert result is True
        assert mock_client.post.call_count == 2
        # Should have slept once with backoff
        mock_sleep.assert_called_once_with(CALLBACK_BACKOFF_BASE**1)

    @pytest.mark.asyncio
    async def test_returns_false_after_all_retries_exhausted(self):
        """Should return False after all retries fail."""
        mock_client = AsyncMock()
        mock_client.post = AsyncMock(side_effect=Exception("connection refused"))
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with (
            patch("src.scheduler.image_builder.httpx.AsyncClient", return_value=mock_client),
            patch("src.scheduler.image_builder.asyncio.sleep", new_callable=AsyncMock),
        ):
            result = await _callback_with_retry(
                "https://example.com/callback",
                {"build_id": "test-123"},
                secret="test-secret",
            )

        assert result is False
        assert mock_client.post.call_count == CALLBACK_MAX_RETRIES

    @pytest.mark.asyncio
    async def test_includes_auth_header(self):
        """Should include Bearer token in auth header."""
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post = AsyncMock(return_value=mock_response)
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)

        with patch("src.scheduler.image_builder.httpx.AsyncClient", return_value=mock_client):
            await _callback_with_retry(
                "https://example.com/callback",
                {"build_id": "test-123"},
                secret="test-secret",
            )

        # Verify the auth header was included
        call_kwargs = mock_client.post.call_args
        headers = call_kwargs.kwargs.get("headers", {})
        assert "Authorization" in headers
        assert headers["Authorization"].startswith("Bearer ")

        # Verify the token is valid
        token = headers["Authorization"]
        assert verify_internal_token(token, "test-secret") is True


class TestStreamBuildLogs:
    """Test the _stream_build_logs function."""

    @staticmethod
    def _async_stdout(lines):
        """Create an async iterator from a list of strings."""

        async def _aiter():
            for line in lines:
                yield line

        return _aiter()

    @pytest.mark.asyncio
    async def test_returns_sha_and_complete(self):
        """Should return head_sha and build_complete=True on success."""
        log_lines = [
            json.dumps({"level": "info", "event": "supervisor.start"}),
            json.dumps({"level": "info", "event": "git.clone_start"}),
            json.dumps({"level": "info", "event": "git.sync_complete", "head_sha": "abc123def456"}),
            json.dumps({"level": "info", "event": "image_build.complete", "duration_ms": 5000}),
        ]
        mock_sandbox = MagicMock()
        mock_sandbox.stdout = self._async_stdout(log_lines)

        sha, complete, error = await _stream_build_logs(mock_sandbox)
        assert sha == "abc123def456"
        assert complete is True
        assert error is None

    @pytest.mark.asyncio
    async def test_complete_without_sha(self):
        """Should return empty SHA but build_complete=True if sync_complete missing."""
        log_lines = [
            json.dumps({"level": "info", "event": "supervisor.start"}),
            json.dumps({"level": "info", "event": "image_build.complete"}),
        ]
        mock_sandbox = MagicMock()
        mock_sandbox.stdout = self._async_stdout(log_lines)

        sha, complete, error = await _stream_build_logs(mock_sandbox)
        assert sha == ""
        assert complete is True
        assert error is None

    @pytest.mark.asyncio
    async def test_incomplete_when_sandbox_exits(self):
        """Should return build_complete=False if sandbox exits without image_build.complete."""
        log_lines = [
            json.dumps({"level": "info", "event": "supervisor.start"}),
            json.dumps({"level": "info", "event": "git.sync_complete", "head_sha": "abc123"}),
            json.dumps({"level": "error", "event": "git.clone_error"}),
        ]
        mock_sandbox = MagicMock()
        mock_sandbox.stdout = self._async_stdout(log_lines)

        sha, complete, error = await _stream_build_logs(mock_sandbox)
        assert sha == "abc123"
        assert complete is False
        assert error is None

    @pytest.mark.asyncio
    async def test_captures_setup_failure_tail(self):
        """Should preserve the setup failure that caused a build to exit."""
        log_lines = [
            json.dumps({"level": "info", "event": "git.sync_complete", "head_sha": "abc123"}),
            json.dumps(
                {
                    "level": "error",
                    "event": "supervisor.error",
                    "error_message": "setup hook failed in build mode",
                }
            ),
            json.dumps(
                {
                    "level": "error",
                    "event": "setup.failed",
                    "output_tail": "npm install\nmissing dependency",
                }
            ),
        ]
        mock_sandbox = MagicMock()
        mock_sandbox.stdout = self._async_stdout(log_lines)

        sha, complete, error = await _stream_build_logs(mock_sandbox)
        assert sha == "abc123"
        assert complete is False
        assert error == "setup.failed: npm install\nmissing dependency"

    @pytest.mark.asyncio
    async def test_falls_back_to_supervisor_error(self):
        """Should use supervisor errors when no setup failure was emitted."""
        log_lines = [
            json.dumps(
                {
                    "level": "error",
                    "event": "supervisor.error",
                    "error_message": "unexpected startup failure",
                }
            ),
        ]
        mock_sandbox = MagicMock()
        mock_sandbox.stdout = self._async_stdout(log_lines)

        sha, complete, error = await _stream_build_logs(mock_sandbox)
        assert sha == ""
        assert complete is False
        assert error == "supervisor.error: unexpected startup failure"

    @pytest.mark.asyncio
    async def test_falls_back_to_supervisor_fatal(self):
        """Should use fatal supervisor errors when no setup failure was emitted."""
        log_lines = [
            json.dumps(
                {
                    "level": "error",
                    "event": "supervisor.fatal",
                    "error_message": "unexpected startup failure",
                }
            ),
        ]
        mock_sandbox = MagicMock()
        mock_sandbox.stdout = self._async_stdout(log_lines)

        sha, complete, error = await _stream_build_logs(mock_sandbox)
        assert sha == ""
        assert complete is False
        assert error == "supervisor.fatal: unexpected startup failure"

    @pytest.mark.asyncio
    async def test_returns_incomplete_on_error(self):
        """Should return build_complete=False on stream error."""

        async def _raise():
            raise Exception("stream error")
            yield  # pragma: no cover - makes this an async generator

        mock_sandbox = MagicMock()
        mock_sandbox.stdout = _raise()

        sha, complete, error = await _stream_build_logs(mock_sandbox)
        assert sha == ""
        assert complete is False
        assert error is None

    @pytest.mark.asyncio
    async def test_handles_malformed_json(self):
        """Should skip malformed JSON lines containing keywords."""
        log_lines = [
            "not json but has git.sync_complete in it",
            json.dumps({"level": "info", "event": "git.sync_complete", "head_sha": "abc123"}),
            json.dumps({"level": "info", "event": "image_build.complete"}),
        ]
        mock_sandbox = MagicMock()
        mock_sandbox.stdout = self._async_stdout(log_lines)

        sha, complete, error = await _stream_build_logs(mock_sandbox)
        assert sha == "abc123"
        assert complete is True
        assert error is None


class TestBuildError:
    """Test BuildError exception."""

    def test_build_error_is_exception(self):
        err = BuildError("sandbox exited with code 1")
        assert isinstance(err, Exception)
        assert str(err) == "sandbox exited with code 1"


class TestBuildRepoImage:
    """Test the async repo image build worker."""

    @staticmethod
    def _async_stdout(lines):
        async def _aiter():
            for line in lines:
                yield line

        return _aiter()

    def _build_handle(self, *, snapshot_side_effect=None, stdout_lines=None, returncode=0):
        snapshot_aio = AsyncMock(
            side_effect=snapshot_side_effect,
            return_value=SimpleNamespace(object_id="im-test"),
        )
        snapshot_filesystem = MagicMock()
        snapshot_filesystem.aio = snapshot_aio
        terminate_aio = AsyncMock()
        terminate = SimpleNamespace(aio=terminate_aio)
        if stdout_lines is None:
            stdout_lines = [
                json.dumps({"event": "git.sync_complete", "head_sha": "abc123"}),
                json.dumps({"event": "image_build.complete", "duration_ms": 5000}),
            ]
        sandbox = SimpleNamespace(
            stdout=self._async_stdout(stdout_lines),
            snapshot_filesystem=snapshot_filesystem,
            terminate=terminate,
            returncode=returncode,
        )
        return SimpleNamespace(modal_sandbox=sandbox), snapshot_aio, terminate_aio

    @pytest.mark.asyncio
    async def test_uses_snapshot_timeout_and_terminates_on_success(self):
        handle, snapshot_aio, terminate_aio = self._build_handle()
        manager = SimpleNamespace(create_build_sandbox=AsyncMock(return_value=handle))

        with (
            patch("src.scheduler.image_builder.validate_control_plane_url", return_value=True),
            patch("src.scheduler.image_builder.resolve_clone_token", return_value="gh-token"),
            patch("src.sandbox.manager.SandboxManager", return_value=manager),
            patch(
                "src.scheduler.image_builder._callback_with_retry",
                new_callable=AsyncMock,
                return_value=True,
            ) as callback,
        ):
            await build_repo_image.local(
                repo_owner="acme",
                repo_name="repo",
                default_branch="main",
                callback_url="https://cp.test/repo-images/build-complete",
                build_id="img-1",
            )

        snapshot_aio.assert_awaited_once_with(timeout=SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS, ttl=None)
        terminate_aio.assert_awaited_once()
        callback.assert_awaited_once()
        callback_payload = callback.await_args.args[1]
        assert callback_payload["build_id"] == "img-1"
        assert callback_payload["provider_image_id"] == "im-test"
        assert callback_payload["base_sha"] == "abc123"

    @pytest.mark.asyncio
    async def test_forwards_build_timeout_to_create_build_sandbox(self):
        handle, _snapshot_aio, _terminate_aio = self._build_handle()
        create_build_sandbox = AsyncMock(return_value=handle)
        manager = SimpleNamespace(create_build_sandbox=create_build_sandbox)

        with (
            patch("src.scheduler.image_builder.validate_control_plane_url", return_value=True),
            patch("src.scheduler.image_builder.resolve_clone_token", return_value="gh-token"),
            patch("src.sandbox.manager.SandboxManager", return_value=manager),
            patch(
                "src.scheduler.image_builder._callback_with_retry",
                new_callable=AsyncMock,
                return_value=True,
            ),
        ):
            await build_repo_image.local(
                repo_owner="acme",
                repo_name="repo",
                default_branch="main",
                callback_url="https://cp.test/repo-images/build-complete",
                build_id="img-1",
                build_timeout_seconds=2400,
            )

        assert create_build_sandbox.await_args.kwargs["timeout_seconds"] == 2400

    @pytest.mark.asyncio
    async def test_defaults_build_timeout_when_unset(self):
        from src.sandbox.manager import DEFAULT_BUILD_TIMEOUT_SECONDS

        handle, _snapshot_aio, _terminate_aio = self._build_handle()
        create_build_sandbox = AsyncMock(return_value=handle)
        manager = SimpleNamespace(create_build_sandbox=create_build_sandbox)

        with (
            patch("src.scheduler.image_builder.validate_control_plane_url", return_value=True),
            patch("src.scheduler.image_builder.resolve_clone_token", return_value="gh-token"),
            patch("src.sandbox.manager.SandboxManager", return_value=manager),
            patch(
                "src.scheduler.image_builder._callback_with_retry",
                new_callable=AsyncMock,
                return_value=True,
            ),
        ):
            await build_repo_image.local(
                repo_owner="acme",
                repo_name="repo",
                default_branch="main",
                callback_url="https://cp.test/repo-images/build-complete",
                build_id="img-1",
            )

        assert (
            create_build_sandbox.await_args.kwargs["timeout_seconds"]
            == DEFAULT_BUILD_TIMEOUT_SECONDS
        )

    @pytest.mark.asyncio
    async def test_terminates_and_reports_failure_when_snapshot_times_out(self):
        handle, snapshot_aio, terminate_aio = self._build_handle(
            snapshot_side_effect=TimeoutError("Timed out waiting for image to be created")
        )
        manager = SimpleNamespace(create_build_sandbox=AsyncMock(return_value=handle))

        with (
            patch("src.scheduler.image_builder.validate_control_plane_url", return_value=True),
            patch("src.scheduler.image_builder.resolve_clone_token", return_value="gh-token"),
            patch("src.sandbox.manager.SandboxManager", return_value=manager),
            patch(
                "src.scheduler.image_builder._callback_with_retry",
                new_callable=AsyncMock,
                return_value=True,
            ) as callback,
        ):
            await build_repo_image.local(
                repo_owner="acme",
                repo_name="repo",
                default_branch="main",
                callback_url="https://cp.test/repo-images/build-complete",
                build_id="img-1",
            )

        snapshot_aio.assert_awaited_once_with(timeout=SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS, ttl=None)
        terminate_aio.assert_awaited_once()
        callback.assert_awaited_once()
        failure_url, failure_payload = callback.await_args.args
        assert failure_url == "https://cp.test/repo-images/build-failed"
        assert failure_payload == {
            "build_id": "img-1",
            "error": "Timed out waiting for image to be created",
        }

    @pytest.mark.asyncio
    async def test_reports_build_log_failure_when_stream_never_completes(self):
        handle, snapshot_aio, terminate_aio = self._build_handle(
            stdout_lines=[
                json.dumps({"event": "git.sync_complete", "head_sha": "abc123"}),
                json.dumps(
                    {
                        "event": "setup.failed",
                        "output_tail": "npm install failed: PIN=123 TOKEN=abcd1234",
                    }
                ),
                json.dumps(
                    {
                        "event": "supervisor.error",
                        "error_message": "setup hook failed in build mode",
                    }
                ),
            ],
            returncode=1,
        )
        manager = SimpleNamespace(create_build_sandbox=AsyncMock(return_value=handle))

        with (
            patch("src.scheduler.image_builder.validate_control_plane_url", return_value=True),
            patch("src.scheduler.image_builder.resolve_clone_token", return_value="gh-token"),
            patch("src.sandbox.manager.SandboxManager", return_value=manager),
            patch(
                "src.scheduler.image_builder._callback_with_retry",
                new_callable=AsyncMock,
                return_value=True,
            ) as callback,
        ):
            await build_repo_image.local(
                repo_owner="acme",
                repo_name="repo",
                default_branch="main",
                callback_url="https://cp.test/repo-images/build-complete",
                build_id="img-1",
                user_env_vars={"PIN": "123", "API_TOKEN": "abcd1234"},
            )

        snapshot_aio.assert_not_awaited()
        terminate_aio.assert_awaited_once()
        callback.assert_awaited_once()
        failure_url, failure_payload = callback.await_args.args
        assert failure_url == "https://cp.test/repo-images/build-failed"
        assert failure_payload == {
            "build_id": "img-1",
            "error": "Build sandbox exited without completing: setup.failed: npm install failed: PIN=*** TOKEN=***",
        }
