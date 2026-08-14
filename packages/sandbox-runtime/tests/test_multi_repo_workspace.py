"""Tests for multi-repo sessions in the supervisor.

Covers the ordered repository list, the unified per-repo sync rule and its
boot-mode failure policy, hook ordering/fatality, the OpenCode workdir rule,
the generated workspace manifest, and .opencode assembly.
"""

import asyncio
import json
import os
from unittest.mock import ANY, AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.opencode_server import OpenCodeServer
from sandbox_runtime.repository_boot import RepositoryBoot
from sandbox_runtime.repository_sync import RepositorySyncResult
from sandbox_runtime.runtime_config import BootMode
from tests.runtime_helpers import make_repository_boot, make_runtime_config

MULTI_SESSION_CONFIG = json.dumps(
    {
        "session_id": "sess-1",
        "repo_owner": "acme",
        "repo_name": "frontend",
        "branch": "main",
        "working_branch_name": "open-inspect/sess-1",
        "repositories": [
            {"repo_owner": "acme", "repo_name": "frontend", "branch": "main"},
            {"repo_owner": "acme", "repo_name": "backend", "branch": "develop"},
        ],
    }
)


def _make_repository_boot(tmp_path, session_config: str = MULTI_SESSION_CONFIG) -> RepositoryBoot:
    return make_repository_boot(
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "frontend",
            "SESSION_CONFIG": session_config,
        },
        workspace_path=tmp_path,
    )


def _mock_repository_boot(sup: RepositoryBoot) -> None:
    sup._write_repo_manifest = MagicMock()
    sup.synchronizer.ensure_credentials_configured = AsyncMock()
    sup.synchronizer.sync = AsyncMock(
        return_value=RepositorySyncResult(tuple(sup.repositories), ())
    )
    sup.hooks.run_setup = AsyncMock(return_value=True)
    sup.hooks.run_start = AsyncMock(return_value=True)


def _make_opencode_server(tmp_path, session_config: str = MULTI_SESSION_CONFIG) -> OpenCodeServer:
    repository = _make_repository_boot(tmp_path, session_config)
    config = make_runtime_config(
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "frontend",
            "SESSION_CONFIG": session_config,
        },
        workspace_path=tmp_path,
    )
    core = OpenCodeServer(
        config.opencode_config(),
        asyncio.Event(),
        repository.log,
        repository.warnings.record,
    )
    core._test_repositories = tuple(repository.repositories)
    return core


class TestParseRepositories:
    def test_parses_ordered_list(self, tmp_path):
        sup = _make_repository_boot(tmp_path)

        assert [(r.owner, r.name, r.branch) for r in sup.repositories] == [
            ("acme", "frontend", "main"),
            ("acme", "backend", "develop"),
        ]
        assert sup.repositories[0].path == tmp_path / "frontend"
        assert sup.repositories[1].path == tmp_path / "backend"
        assert sup.is_multi_repo is True

    def test_member_branch_defaults_to_main(self, tmp_path):
        config = json.dumps(
            {
                "session_id": "s",
                "repositories": [{"repo_owner": "acme", "repo_name": "frontend"}],
            }
        )
        sup = _make_repository_boot(tmp_path, session_config=config)

        assert sup.repositories[0].branch == "main"

    def test_synthesizes_single_entry_from_scalar_env(self, tmp_path):
        config = json.dumps({"session_id": "s", "branch": "develop"})
        sup = _make_repository_boot(tmp_path, session_config=config)

        assert [(r.owner, r.name, r.branch) for r in sup.repositories] == [
            ("acme", "frontend", "develop")
        ]
        assert sup.is_multi_repo is False

    def test_unsafe_repo_name_defers_config_error(self, tmp_path):
        config = json.dumps(
            {
                "session_id": "s",
                "repositories": [{"repo_owner": "acme", "repo_name": "../../etc"}],
            }
        )
        sup = _make_repository_boot(tmp_path, session_config=config)

        assert sup.repositories == []
        assert "repo_name" in sup.repo_config_error

    def test_duplicate_repo_names_defer_config_error(self, tmp_path):
        config = json.dumps(
            {
                "session_id": "s",
                "repositories": [
                    {"repo_owner": "acme", "repo_name": "app"},
                    {"repo_owner": "globex", "repo_name": "App"},
                ],
            }
        )
        sup = _make_repository_boot(tmp_path, session_config=config)

        assert sup.repositories == []
        assert "duplicate" in sup.repo_config_error

    @pytest.mark.asyncio
    async def test_run_fails_fatally_on_config_error(self, tmp_path):
        config = json.dumps(
            {
                "session_id": "s",
                "repositories": [{"repo_owner": "acme", "repo_name": "a/b"}],
            }
        )
        sup = _make_repository_boot(tmp_path, session_config=config)
        _mock_repository_boot(sup)

        with (
            patch(
                "sandbox_runtime.boot_warnings.BOOT_WARNINGS_FILE_PATH",
                str(tmp_path / "warnings.jsonl"),
            ),
            pytest.raises(RuntimeError, match="invalid repository config"),
        ):
            await sup.boot(BootMode.FRESH, [])


class TestSyncRepositories:
    @pytest.mark.asyncio
    async def test_returns_failed_members_in_order(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        sup.synchronizer._sync_repo = AsyncMock(side_effect=[True, False])

        result = await sup.synchronizer.sync(sup.repositories, BootMode.FRESH)

        assert result.failures == (sup.repositories[1],)
        assert sup.synchronizer._sync_repo.await_count == 2

    @pytest.mark.asyncio
    async def test_clone_subprocess_exception_is_a_member_failure(self, tmp_path):
        """An OSError from the clone subprocess must surface as a failed
        member, not abort the whole sync gather."""
        sup = _make_repository_boot(tmp_path)

        with patch(
            "sandbox_runtime.repository_sync.asyncio.create_subprocess_exec",
            AsyncMock(side_effect=OSError("no more processes")),
        ):
            result = await sup.synchronizer.sync(sup.repositories, BootMode.FRESH)

        assert result.failures == tuple(sup.repositories)

    @pytest.mark.asyncio
    async def test_fresh_boot_member_failure_is_fatal(self, tmp_path):
        """Deliberate change: a fresh boot no longer limps on repo-less."""
        sup = _make_repository_boot(tmp_path)
        _mock_repository_boot(sup)
        sup.synchronizer.sync = AsyncMock(
            return_value=RepositorySyncResult(tuple(sup.repositories), (sup.repositories[1],))
        )

        with (
            patch.dict(os.environ, {}, clear=False),
            patch(
                "sandbox_runtime.boot_warnings.BOOT_WARNINGS_FILE_PATH",
                str(tmp_path / "warnings.jsonl"),
            ),
            pytest.raises(RuntimeError, match="acme/backend"),
        ):
            await sup.boot(BootMode.FRESH, [])

    @pytest.mark.asyncio
    async def test_snapshot_boot_member_failure_warns_and_continues(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _mock_repository_boot(sup)
        sup.synchronizer.sync = AsyncMock(
            return_value=RepositorySyncResult(tuple(sup.repositories), (sup.repositories[1],))
        )

        with (
            patch.dict(os.environ, {"RESTORED_FROM_SNAPSHOT": "true"}, clear=False),
            patch(
                "sandbox_runtime.boot_warnings.BOOT_WARNINGS_FILE_PATH",
                str(tmp_path / "warnings.jsonl"),
            ),
        ):
            await sup.boot(BootMode.SNAPSHOT_RESTORE, [])
        warning = json.loads((tmp_path / "warnings.jsonl").read_text().splitlines()[0])
        assert warning["scope"] == "sync"
        assert warning["repoName"] == "backend"


class TestHookOrchestration:
    @pytest.mark.asyncio
    async def test_fresh_setup_failure_warns_and_runs_remaining_members(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _mock_repository_boot(sup)
        sup.hooks.run_setup = AsyncMock(side_effect=[False, True])

        with (
            patch.dict(os.environ, {}, clear=False),
            patch(
                "sandbox_runtime.boot_warnings.BOOT_WARNINGS_FILE_PATH",
                str(tmp_path / "warnings.jsonl"),
            ),
        ):
            await sup.boot(BootMode.FRESH, [])

        assert [c.args[0] for c in sup.hooks.run_setup.await_args_list] == sup.repositories
        warning = json.loads((tmp_path / "warnings.jsonl").read_text().splitlines()[0])
        assert warning["scope"] == "setup"
        assert warning["repoName"] == "frontend"

    @pytest.mark.asyncio
    async def test_build_setup_failure_is_fatal_naming_member(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _mock_repository_boot(sup)
        sup.hooks.run_setup = AsyncMock(side_effect=[True, False])

        with (
            patch.dict(os.environ, {"IMAGE_BUILD_MODE": "true"}, clear=False),
            patch(
                "sandbox_runtime.boot_warnings.BOOT_WARNINGS_FILE_PATH",
                str(tmp_path / "warnings.jsonl"),
            ),
            pytest.raises(RuntimeError, match="acme/backend"),
        ):
            await sup.boot(BootMode.BUILD, [])

    @pytest.mark.asyncio
    async def test_primary_start_failure_is_fatal(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _mock_repository_boot(sup)
        sup.hooks.run_start = AsyncMock(side_effect=[False, True])

        with (
            patch.dict(os.environ, {}, clear=False),
            patch(
                "sandbox_runtime.boot_warnings.BOOT_WARNINGS_FILE_PATH",
                str(tmp_path / "warnings.jsonl"),
            ),
            pytest.raises(RuntimeError, match="acme/frontend"),
        ):
            await sup.boot(BootMode.FRESH, [])

    @pytest.mark.asyncio
    async def test_secondary_start_failure_warns_and_continues(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        _mock_repository_boot(sup)
        sup.hooks.run_start = AsyncMock(side_effect=[True, False])

        with (
            patch.dict(os.environ, {}, clear=False),
            patch(
                "sandbox_runtime.boot_warnings.BOOT_WARNINGS_FILE_PATH",
                str(tmp_path / "warnings.jsonl"),
            ),
        ):
            await sup.boot(BootMode.FRESH, [])
        warning = json.loads((tmp_path / "warnings.jsonl").read_text().splitlines()[0])
        assert warning["scope"] == "start"
        assert warning["repoName"] == "backend"


class TestOpencodeWorkdir:
    def test_multi_repo_roots_at_workspace(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        (tmp_path / "frontend" / ".git").mkdir(parents=True)
        (tmp_path / "backend" / ".git").mkdir(parents=True)

        assert sup._opencode_workdir() == tmp_path

    def test_single_repo_roots_at_repo(self, tmp_path):
        config = json.dumps({"session_id": "s", "branch": "main"})
        sup = _make_repository_boot(tmp_path, session_config=config)
        (tmp_path / "frontend" / ".git").mkdir(parents=True)

        assert sup._opencode_workdir() == tmp_path / "frontend"

    def test_no_repo_roots_at_workspace(self, tmp_path):
        config = json.dumps({"session_id": "s"})
        sup = make_repository_boot(
            {
                "SANDBOX_ID": "t",
                "REPO_OWNER": "",
                "REPO_NAME": "",
                "SESSION_CONFIG": config,
            },
            workspace_path=tmp_path,
        )

        assert sup.repositories == []
        assert sup._opencode_workdir() == tmp_path


class TestWorkspaceManifest:
    def test_writes_manifest_with_members_and_working_branch(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        (tmp_path / "frontend").mkdir()
        (tmp_path / "backend").mkdir()
        (tmp_path / "backend" / "AGENTS.md").write_text("# backend rules")

        sup._write_workspace_manifest()

        manifest = (tmp_path / "AGENTS.md").read_text()
        assert "Generated by Open-Inspect" in manifest
        assert "| `./frontend/` | acme/frontend | `main` |" in manifest
        assert "| `./backend/` | acme/backend | `develop` |" in manifest
        assert "`open-inspect/sess-1`" in manifest
        assert "`./backend/AGENTS.md`" in manifest
        assert "`./frontend/AGENTS.md`" not in manifest
        assert "create-pull-request" in manifest
        assert "`repo`" in manifest

    def test_omits_working_branch_line_when_absent(self, tmp_path):
        config = json.loads(MULTI_SESSION_CONFIG)
        del config["working_branch_name"]
        sup = _make_repository_boot(tmp_path, session_config=json.dumps(config))

        sup._write_workspace_manifest()

        manifest = (tmp_path / "AGENTS.md").read_text()
        assert "open-inspect/sess-1" not in manifest

    def test_single_repo_writes_nothing(self, tmp_path):
        config = json.dumps({"session_id": "s", "branch": "main"})
        sup = _make_repository_boot(tmp_path, session_config=config)

        sup._write_workspace_manifest()

        assert not (tmp_path / "AGENTS.md").exists()


class TestOpencodeAssembly:
    def test_copies_in_position_order_with_collision_warning(self, tmp_path):
        sup = _make_opencode_server(tmp_path)
        front = tmp_path / "frontend" / ".opencode" / "command"
        back = tmp_path / "backend" / ".opencode" / "command"
        front.mkdir(parents=True)
        back.mkdir(parents=True)
        (front / "deploy.md").write_text("from-frontend")
        (back / "deploy.md").write_text("from-backend")
        (tmp_path / "backend" / ".opencode" / "tool").mkdir()
        (tmp_path / "backend" / ".opencode" / "tool" / "db.js").write_text("tool")

        with patch(
            "sandbox_runtime.boot_warnings.BOOT_WARNINGS_FILE_PATH",
            str(tmp_path / "warnings.jsonl"),
        ):
            sup._assemble_workspace_opencode(sup._test_repositories)

        merged = tmp_path / ".opencode"
        assert (merged / "command" / "deploy.md").read_text() == "from-backend"
        assert (merged / "tool" / "db.js").read_text() == "tool"
        warning = json.loads((tmp_path / "warnings.jsonl").read_text().splitlines()[0])
        assert warning["scope"] == "assembly"
        assert warning["repoName"] == "backend"
        assert "acme/frontend" in warning["message"]

    def test_rebuilds_from_clean_tree(self, tmp_path):
        """Stale generated files (e.g. from a previous boot's member set)
        must not survive reassembly on snapshot/repo-image boots."""
        sup = _make_opencode_server(tmp_path)
        stale = tmp_path / ".opencode" / "command" / "removed.md"
        stale.parent.mkdir(parents=True)
        stale.write_text("from a member no longer in the session")
        stale_manifest = tmp_path / ".opencode" / "package.json"
        stale_manifest.write_text("{}")
        src = tmp_path / "frontend" / ".opencode" / "command"
        src.mkdir(parents=True)
        (src / "deploy.md").write_text("current")

        sup._assemble_workspace_opencode(sup._test_repositories)

        assert not stale.exists()
        assert not stale_manifest.exists()
        assert (tmp_path / ".opencode" / "command" / "deploy.md").read_text() == "current"

    def test_rebuild_preserves_staged_node_modules(self, tmp_path):
        """The image-managed module tree survives the clean rebuild so
        snapshot restores keep _stage_opencode_deps' skip-if-present fast
        path instead of re-copying it every boot."""
        sup = _make_opencode_server(tmp_path)
        staged = tmp_path / ".opencode" / "node_modules" / "@opencode-ai" / "plugin"
        staged.mkdir(parents=True)
        (staged / "index.js").write_text("plugin")
        stale = tmp_path / ".opencode" / "tool" / "removed.js"
        stale.parent.mkdir(parents=True)
        stale.write_text("stale")

        sup._assemble_workspace_opencode(sup._test_repositories)

        assert (staged / "index.js").read_text() == "plugin"
        assert not stale.exists()

    def test_skips_node_modules(self, tmp_path):
        sup = _make_opencode_server(tmp_path)
        nm = tmp_path / "frontend" / ".opencode" / "node_modules" / "pkg"
        nm.mkdir(parents=True)
        (nm / "index.js").write_text("x")

        sup._assemble_workspace_opencode(sup._test_repositories)

        assert not (tmp_path / ".opencode" / "node_modules").exists()

    def test_noop_for_single_repo(self, tmp_path):
        config = json.dumps({"session_id": "s", "branch": "main"})
        sup = _make_opencode_server(tmp_path, session_config=config)
        src = tmp_path / "frontend" / ".opencode"
        src.mkdir(parents=True)
        (src / "a.md").write_text("a")

        sup._assemble_workspace_opencode(sup._test_repositories)

        assert not (tmp_path / ".opencode").exists()


class TestRepoManifestFile:
    def test_writes_canonical_entries_with_paths(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        manifest_path = tmp_path / "repo-manifest.json"

        with patch(
            "sandbox_runtime.repository_boot.REPO_MANIFEST_FILE_PATH",
            str(manifest_path),
        ):
            sup._write_repo_manifest()

        manifest = json.loads(manifest_path.read_text())
        assert manifest["repositories"] == [
            {
                "owner": "acme",
                "name": "frontend",
                "branch": "main",
                "path": str(tmp_path / "frontend"),
            },
            {
                "owner": "acme",
                "name": "backend",
                "branch": "develop",
                "path": str(tmp_path / "backend"),
            },
        ]


class TestBootWarningRecorder:
    def test_appends_jsonl_entries(self, tmp_path):
        sup = _make_repository_boot(tmp_path)
        sup.warnings.log = MagicMock()

        with patch(
            "sandbox_runtime.boot_warnings.BOOT_WARNINGS_FILE_PATH",
            str(tmp_path / "warnings.jsonl"),
        ):
            sup.warnings.record("setup", "m1", sup.repositories[0])
            sup.warnings.record("sync", "m2")

        lines = [
            json.loads(line) for line in (tmp_path / "warnings.jsonl").read_text().splitlines()
        ]
        assert lines[0] == {
            "scope": "setup",
            "message": "m1",
            "repoOwner": "acme",
            "repoName": "frontend",
        }
        assert lines[1] == {"scope": "sync", "message": "m2"}
        sup.warnings.log.warn.assert_any_call(
            "supervisor.boot_warning",
            scope="setup",
            warning_message="m1",
            repo_owner=ANY,
            repo_name=ANY,
        )
