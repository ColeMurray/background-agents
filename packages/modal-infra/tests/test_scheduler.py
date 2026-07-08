"""Tests for the image build scheduler (cron)."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.scheduler.image_builder import (
    _git_ls_remote_sha,
    _should_rebuild,
    _should_rebuild_environment,
)


class TestGitLsRemoteSha:
    """Test the _git_ls_remote_sha function."""

    def test_returns_sha_on_success(self):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "abc123def456789\trefs/heads/main\n"

        with patch(
            "src.scheduler.image_builder.subprocess.run", return_value=mock_result
        ) as mock_run:
            sha = _git_ls_remote_sha("acme", "repo", "refs/heads/main", "token123")

        assert sha == "abc123def456789"
        args = mock_run.call_args[0][0]
        assert args[0] == "git"
        assert args[1] == "ls-remote"
        assert "x-access-token:token123@github.com/acme/repo.git" in args[2]
        assert args[3] == "refs/heads/main"

    def test_returns_none_on_failure(self):
        mock_result = MagicMock()
        mock_result.returncode = 128
        mock_result.stderr = "fatal: repository not found"

        with patch("src.scheduler.image_builder.subprocess.run", return_value=mock_result):
            sha = _git_ls_remote_sha("acme", "repo", "refs/heads/main", "token")

        assert sha is None

    def test_returns_none_on_empty_output(self):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = ""

        with patch("src.scheduler.image_builder.subprocess.run", return_value=mock_result):
            sha = _git_ls_remote_sha("acme", "repo", "refs/heads/main", "token")

        assert sha is None

    def test_returns_none_on_exception(self):
        with patch(
            "src.scheduler.image_builder.subprocess.run",
            side_effect=Exception("timeout"),
        ):
            sha = _git_ls_remote_sha("acme", "repo", "refs/heads/main", "token")

        assert sha is None

    def test_uses_unauthenticated_url_without_token(self):
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "abc123\trefs/heads/main\n"

        with patch(
            "src.scheduler.image_builder.subprocess.run", return_value=mock_result
        ) as mock_run:
            _git_ls_remote_sha("acme", "repo", "refs/heads/main", "")

        args = mock_run.call_args[0][0]
        assert args[2] == "https://github.com/acme/repo.git"

    def test_passes_head_ref_verbatim(self):
        """The ref is forwarded to git ls-remote verbatim (e.g. "HEAD")."""
        mock_result = MagicMock()
        mock_result.returncode = 0
        mock_result.stdout = "abc123\tHEAD\n"

        with patch(
            "src.scheduler.image_builder.subprocess.run", return_value=mock_result
        ) as mock_run:
            sha = _git_ls_remote_sha("acme", "repo", "HEAD", "token")

        assert sha == "abc123"
        args = mock_run.call_args[0][0]
        assert args[3] == "HEAD"


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


def _environment(fingerprint="fp-current", repositories=None):
    return {
        "id": "env_1",
        "name": "Flagship",
        "membersFingerprint": fingerprint,
        "repositories": repositories
        or [
            {"repoOwner": "acme", "repoName": "web", "baseBranch": "main"},
            {"repoOwner": "acme", "repoName": "api", "baseBranch": "develop"},
        ],
    }


def _environment_image(**overrides):
    image = {
        "id": "envimg-1",
        "environment_id": "env_1",
        "status": "ready",
        "members_fingerprint": "fp-current",
        "member_shas": json.dumps(
            [
                {"repoOwner": "acme", "repoName": "web", "baseSha": "sha-web"},
                {"repoOwner": "acme", "repoName": "api", "baseSha": "sha-api"},
            ]
        ),
        "runtime_version": "v53-list-native-runtime",
    }
    image.update(overrides)
    return image


class TestShouldRebuildEnvironment:
    """Test the _should_rebuild_environment trigger logic (design §7.3)."""

    def _ls_remote(self, shas_by_repo):
        def lookup(repo_owner, repo_name, ref, clone_token):
            return shas_by_repo.get(f"{repo_owner}/{repo_name}")

        return lookup

    def test_rebuild_when_no_ready_image(self):
        """Trigger 1: no images at all → rebuild."""
        assert _should_rebuild_environment(_environment(), [], 53, "") is True

    def test_rebuild_when_fingerprint_mismatch(self):
        """Trigger 1: ready image for an older member set → rebuild."""
        images = [_environment_image(members_fingerprint="fp-old")]
        assert _should_rebuild_environment(_environment(), images, 53, "") is True

    def test_skip_when_building(self):
        """Per-environment concurrency 1: in-flight build → skip."""
        images = [_environment_image(status="building")]
        assert _should_rebuild_environment(_environment(), images, 53, "") is False

    def test_rebuild_when_runtime_below_floor(self):
        """Trigger 3: baked runtime below the compatibility floor → rebuild."""
        images = [_environment_image(runtime_version="v52-old")]
        assert _should_rebuild_environment(_environment(), images, 53, "") is True

    def test_rebuild_when_runtime_unparseable(self):
        """Trigger 3 fails closed: unparseable runtime_version → rebuild."""
        images = [_environment_image(runtime_version="not-a-version")]
        assert _should_rebuild_environment(_environment(), images, 53, "") is True

    def test_rebuild_when_member_shas_malformed(self):
        """Malformed provenance means drift is undetectable → rebuild."""
        images = [_environment_image(member_shas="not-json")]
        assert _should_rebuild_environment(_environment(), images, 53, "") is True

    def test_rebuild_when_member_branch_drifts(self):
        """Trigger 2: any member's branch tip moved → rebuild."""
        images = [_environment_image()]
        with patch(
            "src.scheduler.image_builder._git_ls_remote_sha",
            side_effect=self._ls_remote({"acme/web": "sha-web", "acme/api": "sha-api-NEW"}),
        ):
            assert _should_rebuild_environment(_environment(), images, 53, "") is True

    def test_skip_when_all_members_match(self):
        """All shas match, runtime fine, fingerprint matches → skip."""
        images = [_environment_image()]
        with patch(
            "src.scheduler.image_builder._git_ls_remote_sha",
            side_effect=self._ls_remote({"acme/web": "sha-web", "acme/api": "sha-api"}),
        ):
            assert _should_rebuild_environment(_environment(), images, 53, "") is False

    def test_ls_remote_failure_is_not_drift(self):
        """A transient lookup failure must not cause rebuild storms."""
        images = [_environment_image()]
        with patch(
            "src.scheduler.image_builder._git_ls_remote_sha",
            side_effect=self._ls_remote({"acme/web": "sha-web", "acme/api": None}),
        ):
            assert _should_rebuild_environment(_environment(), images, 53, "") is False


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

        mock_enabled = {"repos": [{"repoOwner": "acme", "repoName": "repo"}]}
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

        mock_ls_remote = MagicMock(return_value="new-sha")

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
            patch(
                "src.scheduler.image_builder._git_ls_remote_sha",
                side_effect=mock_ls_remote,
            ),
            patch(
                "sandbox_runtime.auth.github_app.generate_installation_token",
                return_value="gh-token",
            ),
        ):
            from src.scheduler.image_builder import rebuild_repo_images

            await rebuild_repo_images.local()

        # Verify trigger was called
        trigger_calls = [c for c in mock_post.call_args_list if "trigger" in str(c)]
        assert len(trigger_calls) == 1
        assert "acme/repo" in str(trigger_calls[0])

        # Verify ls-remote followed HEAD (the default branch), not a hardcoded "main"
        assert mock_ls_remote.call_args[0][:3] == ("acme", "repo", "HEAD")

    @pytest.mark.asyncio
    async def test_skips_build_when_sha_matches(self):
        """Should not trigger a build when SHAs match."""
        env = {
            "CONTROL_PLANE_URL": "https://cp.test",
            "MODAL_API_SECRET": "test-secret",
        }

        mock_enabled = {"repos": [{"repoOwner": "acme", "repoName": "repo"}]}
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
            patch(
                "src.scheduler.image_builder._git_ls_remote_sha",
                return_value="same-sha",
            ),
            patch(
                "sandbox_runtime.auth.github_app.generate_installation_token",
                return_value="gh-token",
            ),
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
                return {"repos": [{"repoOwner": "acme", "repoName": "repo"}]}
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
            patch(
                "src.scheduler.image_builder._git_ls_remote_sha",
                return_value="abc123",
            ),
            patch(
                "sandbox_runtime.auth.github_app.generate_installation_token",
                return_value="gh-token",
            ),
        ):
            from src.scheduler.image_builder import rebuild_repo_images

            await rebuild_repo_images.local()

        # Both passes run their own mark-stale and cleanup
        stale_calls = [c for c in mock_post.call_args_list if "repo-images/mark-stale" in str(c)]
        assert len(stale_calls) == 1

        cleanup_calls = [c for c in mock_post.call_args_list if "repo-images/cleanup" in str(c)]
        assert len(cleanup_calls) == 1

        environment_stale_calls = [
            c for c in mock_post.call_args_list if "environment-images/mark-stale" in str(c)
        ]
        assert len(environment_stale_calls) == 1

        environment_cleanup_calls = [
            c for c in mock_post.call_args_list if "environment-images/cleanup" in str(c)
        ]
        assert len(environment_cleanup_calls) == 1
