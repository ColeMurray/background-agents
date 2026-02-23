"""Tests for the async image builder (v2)."""

import time
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from src.auth.internal import generate_internal_token, verify_internal_token
from src.scheduler.image_builder import (
    CALLBACK_BACKOFF_BASE,
    CALLBACK_MAX_RETRIES,
    BuildError,
    _callback_with_retry,
    _read_sandbox_head_sha,
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


class TestReadSandboxHeadSha:
    """Test the _read_sandbox_head_sha function."""

    def test_reads_sha_from_sandbox(self):
        """Should read HEAD SHA via sandbox exec."""
        mock_process = MagicMock()
        mock_process.stdout.read.return_value = "abc123def456\n"

        mock_sandbox = MagicMock()
        mock_sandbox.exec.return_value = mock_process

        sha = _read_sandbox_head_sha(mock_sandbox, "my-repo")
        assert sha == "abc123def456"

        mock_sandbox.exec.assert_called_once_with(
            "git", "-C", "/workspace/my-repo", "rev-parse", "HEAD"
        )

    def test_returns_empty_on_error(self):
        """Should return empty string on error."""
        mock_sandbox = MagicMock()
        mock_sandbox.exec.side_effect = Exception("sandbox not running")

        sha = _read_sandbox_head_sha(mock_sandbox, "my-repo")
        assert sha == ""


class TestBuildError:
    """Test BuildError exception."""

    def test_build_error_is_exception(self):
        err = BuildError("sandbox exited with code 1")
        assert isinstance(err, Exception)
        assert str(err) == "sandbox exited with code 1"
