"""Tests for the image build scheduler (cron)."""

from unittest.mock import AsyncMock, patch

import pytest

from src.scheduler.image_builder import _should_rebuild


class TestShouldRebuild:
    """Test the _should_rebuild decision logic."""

    def test_rebuild_when_no_images(self):
        """No images at all → should rebuild."""
        result = _should_rebuild("acme", "repo", "abc123", [])
        assert result is True

    def test_skip_when_building(self):
        """Already building → skip."""
        images = [
            {
                "repo_owner": "acme",
                "repo_name": "repo",
                "status": "building",
                "base_sha": "",
            }
        ]
        result = _should_rebuild("acme", "repo", "abc123", images)
        assert result is False

    def test_rebuild_when_sha_mismatch(self):
        """Ready image with different SHA → rebuild."""
        images = [
            {
                "repo_owner": "acme",
                "repo_name": "repo",
                "status": "ready",
                "base_sha": "old-sha-111",
            }
        ]
        result = _should_rebuild("acme", "repo", "new-sha-222", images)
        assert result is True

    def test_skip_when_sha_matches(self):
        """Ready image with same SHA → skip."""
        images = [
            {
                "repo_owner": "acme",
                "repo_name": "repo",
                "status": "ready",
                "base_sha": "abc123",
            }
        ]
        result = _should_rebuild("acme", "repo", "abc123", images)
        assert result is False

    def test_rebuild_when_only_failed_images(self):
        """Only failed images → rebuild."""
        images = [
            {
                "repo_owner": "acme",
                "repo_name": "repo",
                "status": "failed",
                "base_sha": "",
            }
        ]
        result = _should_rebuild("acme", "repo", "abc123", images)
        assert result is True

    def test_case_insensitive_repo_match(self):
        """Should match repos case-insensitively."""
        images = [
            {
                "repo_owner": "Acme",
                "repo_name": "Repo",
                "status": "ready",
                "base_sha": "abc123",
            }
        ]
        result = _should_rebuild("acme", "repo", "abc123", images)
        assert result is False

    def test_ignores_other_repos(self):
        """Should only look at images for the specific repo."""
        images = [
            {
                "repo_owner": "acme",
                "repo_name": "other-repo",
                "status": "ready",
                "base_sha": "abc123",
            }
        ]
        result = _should_rebuild("acme", "repo", "abc123", images)
        assert result is True


class TestRebuildRepoImages:
    """Test the rebuild_repo_images cron function (integration-level with mocks)."""

    @pytest.mark.asyncio
    async def test_skips_when_no_control_plane_url(self):
        """Should log error and return when CONTROL_PLANE_URL is missing."""
        with patch.dict("os.environ", {}, clear=True):
            # Import fresh to get the function
            from src.scheduler.image_builder import rebuild_repo_images

            # Call the .local() version which bypasses Modal decorator
            await rebuild_repo_images.local()
            # No exception means it returned gracefully

    @pytest.mark.asyncio
    async def test_skips_when_no_enabled_repos(self):
        """Should return early when no repos have image building enabled."""
        env = {
            "CONTROL_PLANE_URL": "https://cp.test",
            "MODAL_API_SECRET": "test-secret",
        }

        mock_enabled = {"repos": []}

        with (
            patch.dict("os.environ", env, clear=False),
            patch(
                "src.scheduler.image_builder._api_get",
                new_callable=AsyncMock,
                return_value=mock_enabled,
            ) as mock_get,
        ):
            from src.scheduler.image_builder import rebuild_repo_images

            await rebuild_repo_images.local()

        mock_get.assert_called_once_with("https://cp.test/repo-images/enabled-repos")

    @pytest.mark.asyncio
    async def test_triggers_build_on_sha_mismatch(self):
        """Should trigger a build when remote SHA differs from ready image."""
        env = {
            "CONTROL_PLANE_URL": "https://cp.test",
            "MODAL_API_SECRET": "test-secret",
        }

        mock_enabled = {
            "repos": [{"repoOwner": "acme", "repoName": "repo", "headSha": "new-sha"}]
        }
        mock_status = {
            "images": [
                {
                    "repo_owner": "acme",
                    "repo_name": "repo",
                    "status": "ready",
                    "base_sha": "old-sha",
                }
            ]
        }
        mock_mark_stale = {"ok": True, "markedFailed": 0}
        mock_cleanup = {"ok": True, "deleted": 0}

        async def mock_get_side_effect(url, **kwargs):
            if "enabled-repos" in url:
                return mock_enabled
            if "status" in url:
                return mock_status
            return {}

        async def mock_post_side_effect(url, payload=None, **kwargs):
            if "trigger" in url:
                return {"buildId": "img-test", "status": "building"}
            if "mark-stale" in url:
                return mock_mark_stale
            if "cleanup" in url:
                return mock_cleanup
            return {}

        with (
            patch.dict("os.environ", env, clear=False),
            patch(
                "src.scheduler.image_builder._api_get",
                new_callable=AsyncMock,
                side_effect=mock_get_side_effect,
            ),
            patch(
                "src.scheduler.image_builder._api_post",
                new_callable=AsyncMock,
                side_effect=mock_post_side_effect,
            ) as mock_post,
        ):
            from src.scheduler.image_builder import rebuild_repo_images

            await rebuild_repo_images.local()

        # Verify trigger was called
        trigger_calls = [c for c in mock_post.call_args_list if "trigger" in str(c)]
        assert len(trigger_calls) == 1
        assert "acme/repo" in str(trigger_calls[0])

    @pytest.mark.asyncio
    async def test_skips_build_when_sha_matches(self):
        """Should not trigger a build when SHAs match."""
        env = {
            "CONTROL_PLANE_URL": "https://cp.test",
            "MODAL_API_SECRET": "test-secret",
        }

        mock_enabled = {
            "repos": [{"repoOwner": "acme", "repoName": "repo", "headSha": "same-sha"}]
        }
        mock_status = {
            "images": [
                {
                    "repo_owner": "acme",
                    "repo_name": "repo",
                    "status": "ready",
                    "base_sha": "same-sha",
                }
            ]
        }

        async def mock_get_side_effect(url, **kwargs):
            if "enabled-repos" in url:
                return mock_enabled
            if "status" in url:
                return mock_status
            return {}

        async def mock_post_side_effect(url, payload=None, **kwargs):
            return {"ok": True, "markedFailed": 0, "deleted": 0}

        with (
            patch.dict("os.environ", env, clear=False),
            patch(
                "src.scheduler.image_builder._api_get",
                new_callable=AsyncMock,
                side_effect=mock_get_side_effect,
            ),
            patch(
                "src.scheduler.image_builder._api_post",
                new_callable=AsyncMock,
                side_effect=mock_post_side_effect,
            ) as mock_post,
        ):
            from src.scheduler.image_builder import rebuild_repo_images

            await rebuild_repo_images.local()

        # Verify trigger was NOT called (only mark-stale + cleanup)
        trigger_calls = [c for c in mock_post.call_args_list if "trigger" in str(c)]
        assert len(trigger_calls) == 0

    @pytest.mark.asyncio
    async def test_calls_mark_stale_and_cleanup(self):
        """Should call mark-stale and cleanup endpoints."""
        env = {
            "CONTROL_PLANE_URL": "https://cp.test",
            "MODAL_API_SECRET": "test-secret",
        }

        async def mock_get_side_effect(url, **kwargs):
            if "enabled-repos" in url:
                return {
                    "repos": [{"repoOwner": "acme", "repoName": "repo", "headSha": "abc123"}]
                }
            if "status" in url:
                return {"images": []}
            return {}

        async def mock_post_side_effect(url, payload=None, **kwargs):
            return {
                "ok": True,
                "markedFailed": 0,
                "deleted": 0,
                "buildId": "b1",
                "status": "building",
            }

        with (
            patch.dict("os.environ", env, clear=False),
            patch(
                "src.scheduler.image_builder._api_get",
                new_callable=AsyncMock,
                side_effect=mock_get_side_effect,
            ),
            patch(
                "src.scheduler.image_builder._api_post",
                new_callable=AsyncMock,
                side_effect=mock_post_side_effect,
            ) as mock_post,
        ):
            from src.scheduler.image_builder import rebuild_repo_images

            await rebuild_repo_images.local()

        # Check that mark-stale and cleanup were called
        stale_calls = [c for c in mock_post.call_args_list if "mark-stale" in str(c)]
        assert len(stale_calls) == 1

        cleanup_calls = [c for c in mock_post.call_args_list if "cleanup" in str(c)]
        assert len(cleanup_calls) == 1
