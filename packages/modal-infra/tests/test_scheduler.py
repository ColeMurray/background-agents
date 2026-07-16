"""Tests for the unified image build scheduler (cron) and worker payloads."""

import json
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.scheduler.image_builder import (
    TRIGGER_CAP_PER_TICK,
    _git_ls_remote_sha,
    _should_rebuild_unit,
    _unit_trigger_path,
    build_image,
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


def _environment_unit(fingerprint="fp-current", repositories=None):
    return {
        "scopeKind": "environment",
        "scopeId": "env_1",
        "repositoriesFingerprint": fingerprint,
        "repositories": repositories
        or [
            {"repoOwner": "acme", "repoName": "web", "baseBranch": "main"},
            {"repoOwner": "acme", "repoName": "api", "baseBranch": "develop"},
        ],
    }


def _repo_unit(fingerprint="fp-repo", repositories=None):
    return {
        "scopeKind": "repo",
        "scopeId": "acme/web",
        "repositoriesFingerprint": fingerprint,
        "repositories": repositories
        or [{"repoOwner": "acme", "repoName": "web", "baseBranch": "main"}],
    }


def _image(**overrides):
    image = {
        "id": "imgb-1",
        "scope_kind": "environment",
        "scope_id": "env_1",
        "status": "ready",
        "repositories_fingerprint": "fp-current",
        "repository_shas": json.dumps(
            [
                {"repoOwner": "acme", "repoName": "web", "baseSha": "sha-web"},
                {"repoOwner": "acme", "repoName": "api", "baseSha": "sha-api"},
            ]
        ),
        "runtime_version": "v54-opencode-1-17-18",
    }
    image.update(overrides)
    return image


def _repo_image(**overrides):
    repo_defaults = {
        "scope_kind": "repo",
        "scope_id": "acme/web",
        "repositories_fingerprint": "fp-repo",
        "repository_shas": json.dumps(
            [{"repoOwner": "acme", "repoName": "web", "baseSha": "sha-web"}]
        ),
    }
    return _image(**{**repo_defaults, **overrides})


class TestShouldRebuildUnit:
    """Test the _should_rebuild_unit trigger logic (design §4)."""

    def _ls_remote(self, shas_by_repo):
        def lookup(repo_owner, repo_name, ref, clone_token):
            return shas_by_repo.get(f"{repo_owner}/{repo_name}")

        return lookup

    def test_rebuild_when_no_ready_image(self):
        """Trigger 1: no images at all → rebuild."""
        assert _should_rebuild_unit(_environment_unit(), [], 53, "") is True

    def test_rebuild_when_fingerprint_mismatch(self):
        """Trigger 1: ready image for an older repository set → rebuild."""
        images = [_image(repositories_fingerprint="fp-old")]
        assert _should_rebuild_unit(_environment_unit(), images, 53, "") is True

    def test_skip_when_building(self):
        """Per-unit concurrency 1: in-flight build → skip."""
        images = [_image(status="building")]
        assert _should_rebuild_unit(_environment_unit(), images, 53, "") is False

    def test_rebuild_when_runtime_below_floor(self):
        """Trigger 3: baked runtime below the compatibility floor → rebuild."""
        images = [_image(runtime_version="v52-old")]
        assert _should_rebuild_unit(_environment_unit(), images, 53, "") is True

    def test_rebuild_when_runtime_unparseable(self):
        """Trigger 3 fails closed: unparseable runtime_version → rebuild."""
        images = [_image(runtime_version="not-a-version")]
        assert _should_rebuild_unit(_environment_unit(), images, 53, "") is True

    def test_rebuild_when_repository_shas_malformed(self):
        """Malformed provenance means drift is undetectable → rebuild."""
        images = [_image(repository_shas="not-json")]
        assert _should_rebuild_unit(_environment_unit(), images, 53, "") is True

    def test_rebuild_when_repository_branch_drifts(self):
        """Trigger 2: any repository's branch tip moved → rebuild."""
        images = [_image()]
        with patch(
            "src.scheduler.image_builder._git_ls_remote_sha",
            side_effect=self._ls_remote({"acme/web": "sha-web", "acme/api": "sha-api-NEW"}),
        ):
            assert _should_rebuild_unit(_environment_unit(), images, 53, "") is True

    def test_skip_when_all_repositories_match(self):
        """All shas match, runtime fine, fingerprint matches → skip."""
        images = [_image()]
        with patch(
            "src.scheduler.image_builder._git_ls_remote_sha",
            side_effect=self._ls_remote({"acme/web": "sha-web", "acme/api": "sha-api"}),
        ):
            assert _should_rebuild_unit(_environment_unit(), images, 53, "") is False

    def test_ls_remote_failure_is_not_drift(self):
        """A transient lookup failure must not cause rebuild storms."""
        images = [_image()]
        with patch(
            "src.scheduler.image_builder._git_ls_remote_sha",
            side_effect=self._ls_remote({"acme/web": "sha-web", "acme/api": None}),
        ):
            assert _should_rebuild_unit(_environment_unit(), images, 53, "") is False

    def test_repo_unit_rebuilds_when_no_ready_image(self):
        """Repo scope, trigger 1: only failed rows → rebuild."""
        images = [_repo_image(status="failed")]
        assert _should_rebuild_unit(_repo_unit(), images, 53, "") is True

    def test_repo_unit_skips_while_building(self):
        """Repo scope: per-unit concurrency 1 applies identically."""
        images = [_repo_image(status="building")]
        assert _should_rebuild_unit(_repo_unit(), images, 53, "") is False

    def test_repo_unit_rebuilds_on_branch_drift(self):
        """Repo scope, trigger 2: the default branch tip moved → rebuild."""
        images = [_repo_image()]
        with patch(
            "src.scheduler.image_builder._git_ls_remote_sha",
            side_effect=self._ls_remote({"acme/web": "sha-web-NEW"}),
        ) as ls_remote:
            assert _should_rebuild_unit(_repo_unit(), images, 53, "") is True
        # Drift is checked against the unit's recorded base branch.
        assert ls_remote.call_args[0][:3] == ("acme", "web", "refs/heads/main")

    def test_repo_unit_skips_when_sha_matches(self):
        """Repo scope: ready image at the branch tip → skip."""
        images = [_repo_image()]
        with patch(
            "src.scheduler.image_builder._git_ls_remote_sha",
            side_effect=self._ls_remote({"acme/web": "sha-web"}),
        ):
            assert _should_rebuild_unit(_repo_unit(), images, 53, "") is False

    def test_repo_unit_rebuilds_when_runtime_below_floor(self):
        """Repo scope, trigger 3: stale runtime is rejected fail-closed."""
        images = [_repo_image(runtime_version="v52-old")]
        assert _should_rebuild_unit(_repo_unit(), images, 53, "") is True

    def test_recorded_shas_match_case_insensitively(self):
        """Recorded provenance casing must not read as drift."""
        images = [
            _repo_image(
                repository_shas=json.dumps(
                    [{"repoOwner": "Acme", "repoName": "Web", "baseSha": "sha-web"}]
                )
            )
        ]
        with patch(
            "src.scheduler.image_builder._git_ls_remote_sha",
            side_effect=self._ls_remote({"acme/web": "sha-web"}),
        ):
            assert _should_rebuild_unit(_repo_unit(), images, 53, "") is False

    def test_ignores_other_scopes_images(self):
        """Rows from other scopes never satisfy a unit's ready check."""
        images = [_image()]  # environment-scope row
        assert _should_rebuild_unit(_repo_unit(), images, 53, "") is True


class TestUnitTriggerPath:
    """Trigger POSTs go to the per-kind trigger routes."""

    def test_repo_unit_path(self):
        assert _unit_trigger_path(_repo_unit()) == "/image-builds/trigger/repo/acme/web"

    def test_repo_unit_path_encodes_nested_owner_namespace(self):
        unit = _repo_unit()
        unit["scopeId"] = "group/subgroup/web"

        assert _unit_trigger_path(unit) == "/image-builds/trigger/repo/group%2Fsubgroup/web"

    def test_environment_unit_path(self):
        assert _unit_trigger_path(_environment_unit()) == "/image-builds/trigger/environment/env_1"

    def test_malformed_units_have_no_path(self):
        assert _unit_trigger_path({"scopeKind": "repo", "scopeId": "not-a-pair"}) is None
        assert _unit_trigger_path({"scopeKind": "environment", "scopeId": ""}) is None
        assert _unit_trigger_path({"scopeKind": "mystery", "scopeId": "x"}) is None


class TestRebuildImages:
    """Test the rebuild_images cron function (integration-level with mocks)."""

    @pytest.mark.asyncio
    async def test_skips_when_no_control_plane_url(self):
        """Should log error and return when CONTROL_PLANE_URL is missing."""
        with patch.dict("os.environ", {}, clear=True):
            from src.scheduler.image_builder import rebuild_images

            # Call the .local() version which bypasses Modal decorator
            await rebuild_images.local()
            # No exception means it returned gracefully

    @staticmethod
    def _env():
        return {
            "CONTROL_PLANE_URL": "https://cp.test",
            "MODAL_API_SECRET": "test-secret",
        }

    async def _run_pass(self, units, images, ls_remote_shas=None):
        """Run the cron with mocked control-plane responses; returns mock_post."""

        async def mock_get_side_effect(url, **kwargs):
            if "image-builds/enabled" in url:
                return {"units": units, "minRuntimeVersion": 53}
            if "image-builds/status" in url:
                return {"images": images}
            return {}

        mock_post = AsyncMock(
            return_value={"ok": True, "markedFailed": 0, "deleted": 0, "status": "building"}
        )

        def ls_remote(repo_owner, repo_name, ref, clone_token):
            return (ls_remote_shas or {}).get(f"{repo_owner}/{repo_name}")

        with (
            patch.dict("os.environ", self._env(), clear=False),
            patch(
                "src.scheduler.image_builder._api_get",
                new_callable=AsyncMock,
                side_effect=mock_get_side_effect,
            ) as mock_get,
            patch("src.scheduler.image_builder._api_post", mock_post),
            patch("src.scheduler.image_builder._git_ls_remote_sha", side_effect=ls_remote),
            patch(
                "sandbox_runtime.auth.github_app.generate_installation_token",
                return_value="gh-token",
            ),
        ):
            from src.scheduler.image_builder import rebuild_images

            await rebuild_images.local()

        return mock_get, mock_post

    @pytest.mark.asyncio
    async def test_no_units_skips_status_but_still_maintains(self):
        """Zero units → no status fetch, but mark-stale and cleanup still run."""
        mock_get, mock_post = await self._run_pass(units=[], images=[])

        assert [c for c in mock_get.call_args_list if "image-builds/status" in str(c)] == []
        stale_calls = [c for c in mock_post.call_args_list if "image-builds/mark-stale" in str(c)]
        assert len(stale_calls) == 1
        cleanup_calls = [c for c in mock_post.call_args_list if "image-builds/cleanup" in str(c)]
        assert len(cleanup_calls) == 1

    @pytest.mark.asyncio
    async def test_triggers_by_unit_kind(self):
        """Repo and environment units POST to their per-kind trigger routes."""
        units = [_repo_unit(), _environment_unit()]

        _mock_get, mock_post = await self._run_pass(units=units, images=[])

        trigger_urls = [c.args[0] for c in mock_post.call_args_list if "/trigger/" in c.args[0]]
        assert trigger_urls == [
            "https://cp.test/image-builds/trigger/repo/acme/web",
            "https://cp.test/image-builds/trigger/environment/env_1",
        ]

    @pytest.mark.asyncio
    async def test_skips_units_with_in_flight_builds(self):
        """A building row suppresses the unit's trigger."""
        units = [_repo_unit(), _environment_unit()]
        images = [_repo_image(status="building"), _image(status="building")]

        _mock_get, mock_post = await self._run_pass(units=units, images=images)

        trigger_calls = [c for c in mock_post.call_args_list if "/trigger/" in str(c)]
        assert trigger_calls == []

    @pytest.mark.asyncio
    async def test_skips_up_to_date_units(self):
        """A matching ready image at the branch tips suppresses the trigger."""
        units = [_repo_unit()]
        images = [_repo_image()]

        _mock_get, mock_post = await self._run_pass(
            units=units, images=images, ls_remote_shas={"acme/web": "sha-web"}
        )

        trigger_calls = [c for c in mock_post.call_args_list if "/trigger/" in str(c)]
        assert trigger_calls == []

    @pytest.mark.asyncio
    async def test_caps_triggers_across_all_units_per_tick(self):
        """One TRIGGER_CAP_PER_TICK across every unit, regardless of kind."""
        units = [
            {
                "scopeKind": "repo",
                "scopeId": f"acme/repo-{i}",
                "repositoriesFingerprint": f"fp-{i}",
                "repositories": [
                    {"repoOwner": "acme", "repoName": f"repo-{i}", "baseBranch": "main"}
                ],
            }
            for i in range(TRIGGER_CAP_PER_TICK)
        ] + [_environment_unit(), _repo_unit()]

        _mock_get, mock_post = await self._run_pass(units=units, images=[])

        trigger_calls = [c for c in mock_post.call_args_list if "/trigger/" in str(c)]
        assert len(trigger_calls) == TRIGGER_CAP_PER_TICK
        # Maintenance still runs after the cap is reached.
        assert [c for c in mock_post.call_args_list if "mark-stale" in str(c)] != []
        assert [c for c in mock_post.call_args_list if "cleanup" in str(c)] != []

    @pytest.mark.asyncio
    async def test_calls_mark_stale_and_cleanup_once(self):
        """One maintenance sweep per tick on the unified paths."""
        _mock_get, mock_post = await self._run_pass(units=[_repo_unit()], images=[])

        stale_calls = [c for c in mock_post.call_args_list if "image-builds/mark-stale" in str(c)]
        assert len(stale_calls) == 1
        cleanup_calls = [c for c in mock_post.call_args_list if "image-builds/cleanup" in str(c)]
        assert len(cleanup_calls) == 1


REPO_SCOPE_KWARGS = {
    "scope_kind": "repo",
    "scope_id": "acme/web",
    "repositories": [{"repo_owner": "acme", "repo_name": "web", "branch": "main"}],
}
ENVIRONMENT_SCOPE_KWARGS = {
    "scope_kind": "environment",
    "scope_id": "env_1",
    "repositories": [
        {"repo_owner": "acme", "repo_name": "web", "branch": "main"},
        {"repo_owner": "acme", "repo_name": "api", "branch": "develop"},
    ],
}
REPOSITORY_SHAS = [
    {"repoOwner": "acme", "repoName": "web", "baseSha": "sha-web"},
    {"repoOwner": "acme", "repoName": "api", "baseSha": "sha-api"},
]
RUNTIME_VERSION = "v54-opencode-1-17-18"


class TestBuildImageCallbackPayloads:
    """
    Pin the exact callback JSON bodies for both scope kinds — the wire
    contract mirrored by packages/shared/src/types/image-builds.ts
    (ImageBuildCompleteCallback / ImageBuildFailedCallback).
    """

    @staticmethod
    def _async_stdout(lines):
        async def _aiter():
            for line in lines:
                yield line

        return _aiter()

    def _build_handle(self, *, stdout_lines, returncode=0):
        snapshot_filesystem = MagicMock()
        snapshot_filesystem.aio = AsyncMock(return_value=SimpleNamespace(object_id="im-test"))
        sandbox = SimpleNamespace(
            stdout=self._async_stdout(stdout_lines),
            snapshot_filesystem=snapshot_filesystem,
            terminate=SimpleNamespace(aio=AsyncMock()),
            returncode=returncode,
        )
        return SimpleNamespace(modal_sandbox=sandbox)

    @contextmanager
    def _patched_build(self, handle):
        manager = SimpleNamespace(create_build_sandbox=AsyncMock(return_value=handle))
        callback = AsyncMock(return_value=True)
        with (
            patch("src.scheduler.image_builder.validate_control_plane_url", return_value=True),
            patch("src.scheduler.image_builder.resolve_clone_token", return_value="gh-token"),
            patch("src.sandbox.manager.SandboxManager", return_value=manager),
            patch("src.scheduler.image_builder._callback_with_retry", callback),
        ):
            yield callback

    @pytest.mark.asyncio
    @pytest.mark.parametrize("scope_kwargs", [REPO_SCOPE_KWARGS, ENVIRONMENT_SCOPE_KWARGS])
    async def test_success_payload_is_identical_for_every_scope_kind(self, scope_kwargs):
        handle = self._build_handle(
            stdout_lines=[
                json.dumps(
                    {
                        "event": "git.sync_complete",
                        "head_sha": "sha-web",
                        "repository_shas": REPOSITORY_SHAS,
                    }
                ),
                json.dumps({"event": "image_build.complete", "runtime_version": RUNTIME_VERSION}),
            ]
        )
        with self._patched_build(handle) as callback:
            await build_image.local(
                **scope_kwargs,
                callback_url="https://cp.test/image-builds/build-complete",
                failure_callback_url="https://cp.test/image-builds/build-failed",
                build_id="imgb-1",
            )

        callback.assert_awaited_once()
        callback_url, payload = callback.await_args.args
        assert callback_url == "https://cp.test/image-builds/build-complete"
        duration = payload["build_duration_seconds"]
        assert isinstance(duration, float) and duration >= 0
        assert payload == {
            "build_id": "imgb-1",
            "provider_image_id": "im-test",
            "repository_shas": REPOSITORY_SHAS,
            "runtime_version": RUNTIME_VERSION,
            "build_duration_seconds": duration,
        }

    @pytest.mark.asyncio
    @pytest.mark.parametrize("scope_kwargs", [REPO_SCOPE_KWARGS, ENVIRONMENT_SCOPE_KWARGS])
    async def test_failure_payload_is_identical_for_every_scope_kind(self, scope_kwargs):
        handle = self._build_handle(
            stdout_lines=[
                json.dumps({"event": "setup.failed", "output_tail": "npm install failed"}),
            ],
            returncode=1,
        )
        with self._patched_build(handle) as callback:
            await build_image.local(
                **scope_kwargs,
                callback_url="https://cp.test/image-builds/build-complete",
                failure_callback_url="https://cp.test/image-builds/build-failed",
                build_id="imgb-1",
            )

        callback.assert_awaited_once()
        failure_url, payload = callback.await_args.args
        assert failure_url == "https://cp.test/image-builds/build-failed"
        assert payload == {
            "build_id": "imgb-1",
            "error": "Build sandbox exited without completing: setup.failed: npm install failed",
        }

    @pytest.mark.asyncio
    async def test_fails_closed_without_repository_shas_and_runtime_version(self):
        """A build log missing provenance/runtime must fail, never register."""
        handle = self._build_handle(
            stdout_lines=[
                json.dumps({"event": "git.sync_complete", "head_sha": "sha-web"}),
                json.dumps({"event": "image_build.complete"}),
            ]
        )
        with self._patched_build(handle) as callback:
            await build_image.local(
                **REPO_SCOPE_KWARGS,
                callback_url="https://cp.test/image-builds/build-complete",
                failure_callback_url="https://cp.test/image-builds/build-failed",
                build_id="imgb-1",
            )

        callback.assert_awaited_once()
        failure_url, payload = callback.await_args.args
        assert failure_url == "https://cp.test/image-builds/build-failed"
        assert payload["build_id"] == "imgb-1"
        assert "repository_shas/runtime_version" in payload["error"]
