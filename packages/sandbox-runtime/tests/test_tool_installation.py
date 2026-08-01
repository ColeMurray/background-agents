"""Tests for _install_tools() and _install_bin_scripts() in SandboxSupervisor."""

import json
import shutil
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import MagicMock, patch

from sandbox_runtime.entrypoint import SandboxSupervisor


def _make_supervisor() -> SandboxSupervisor:
    """Create a SandboxSupervisor with default test config."""
    with patch.dict(
        "os.environ",
        {
            "SANDBOX_ID": "test-sandbox",
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "REPO_OWNER": "acme",
            "REPO_NAME": "app",
        },
    ):
        return SandboxSupervisor()


@contextmanager
def _patch_paths(
    legacy: Path | str,
    tools: Path | str,
    skills: Path | str = "/nonexistent",
    bin_src: Path | str = "/nonexistent",
    bin_dest: Path | str = "/nonexistent",
    deps_cache: Path | str = "/nonexistent",
):
    """Patch entrypoint Path() calls to redirect legacy, tools, skills, and bin paths."""
    with patch("sandbox_runtime.entrypoint.Path") as MockPath:
        MockPath.side_effect = lambda p: Path(
            str(p)
            .replace("/app/sandbox_runtime/plugins/inspect-plugin.js", str(legacy))
            .replace("/app/sandbox_runtime/tools", str(tools))
            .replace("/app/sandbox_runtime/skills", str(skills))
            .replace("/app/sandbox_runtime/bin", str(bin_src))
            .replace("/app/opencode-deps", str(deps_cache))
            .replace("/usr/local/bin", str(bin_dest))
            .replace("/home/sandbox/.local/bin", str(bin_dest))
        )
        yield


class TestInstallTools:
    """Cases for _install_tools() tool installation."""

    def test_legacy_tool_copied(self, tmp_path):
        """inspect-plugin.js should be copied as create-pull-request.js."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        legacy_tool = tmp_path / "app" / "sandbox" / "inspect-plugin.js"
        legacy_tool.parent.mkdir(parents=True)
        legacy_tool.write_text("// legacy tool")

        with _patch_paths(legacy=legacy_tool, tools=tmp_path / "no-tools"):
            sup._install_tools(workdir / ".opencode")

        dest = workdir / ".opencode" / "tool" / "create-pull-request.js"
        assert dest.exists()
        assert dest.read_text() == "// legacy tool"

    def test_tools_dir_files_copied(self, tmp_path):
        """All .js files from tools/ directory should be copied."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        tools_dir = tmp_path / "app" / "sandbox" / "tools"
        tools_dir.mkdir(parents=True)
        (tools_dir / "_bridge-client.js").write_text("// bridge client")
        (tools_dir / "spawn-child.js").write_text("// spawn child")
        (tools_dir / "get-child-status.js").write_text("// get status")
        (tools_dir / "cancel-child.js").write_text("// cancel child")

        with _patch_paths(legacy=tmp_path / "no-legacy", tools=tools_dir):
            sup._install_tools(workdir / ".opencode")

        tool_dest = workdir / ".opencode" / "tool"
        assert (tool_dest / "_bridge-client.js").exists()
        assert (tool_dest / "spawn-child.js").exists()
        assert (tool_dest / "get-child-status.js").exists()
        assert (tool_dest / "cancel-child.js").exists()
        assert (tool_dest / "_bridge-client.js").read_text() == "// bridge client"

    def test_non_js_files_skipped(self, tmp_path):
        """Non-.js files in tools/ directory should not be copied."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        tools_dir = tmp_path / "app" / "sandbox" / "tools"
        tools_dir.mkdir(parents=True)
        (tools_dir / "spawn-child.js").write_text("// tool")
        (tools_dir / "README.md").write_text("# docs")
        (tools_dir / "helper.py").write_text("# python")

        with _patch_paths(legacy=tmp_path / "no-legacy", tools=tools_dir):
            sup._install_tools(workdir / ".opencode")

        tool_dest = workdir / ".opencode" / "tool"
        assert (tool_dest / "spawn-child.js").exists()
        assert not (tool_dest / "README.md").exists()
        assert not (tool_dest / "helper.py").exists()

    def test_graceful_without_tools_dir(self, tmp_path):
        """Only legacy tool should be copied when tools/ doesn't exist."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        legacy_tool = tmp_path / "app" / "sandbox" / "inspect-plugin.js"
        legacy_tool.parent.mkdir(parents=True)
        legacy_tool.write_text("// legacy")

        with _patch_paths(legacy=legacy_tool, tools=tmp_path / "no-tools"):
            sup._install_tools(workdir / ".opencode")

        tool_dest = workdir / ".opencode" / "tool"
        assert (tool_dest / "create-pull-request.js").exists()
        js_files = list(tool_dest.glob("*.js"))
        assert len(js_files) == 1

    def test_no_tools_at_all(self, tmp_path):
        """Should be a no-op when neither legacy tool nor tools/ exist."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        with _patch_paths(legacy=tmp_path / "no-legacy", tools=tmp_path / "no-tools"):
            sup._install_tools(workdir / ".opencode")

        assert not (workdir / ".opencode").exists()

    def test_copies_prebuilt_deps_from_cache(self, tmp_path):
        """Should copy package.json, package-lock.json, and node_modules from image cache."""
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        # Build a fake deps cache mimicking /app/opencode-deps
        deps_cache = tmp_path / "opencode-deps"
        deps_cache.mkdir()
        pkg_content = {
            "name": "opencode-tools",
            "type": "module",
            "dependencies": {"@opencode-ai/plugin": "*"},
        }
        (deps_cache / "package.json").write_text(json.dumps(pkg_content))
        (deps_cache / "package-lock.json").write_text('{"lockfileVersion": 3}')
        nm = deps_cache / "node_modules" / "@opencode-ai" / "plugin"
        nm.mkdir(parents=True)
        (nm / "index.js").write_text("module.exports = {}")

        opencode_dir = workdir / ".opencode"
        opencode_dir.mkdir()
        SandboxSupervisor._stage_opencode_deps(deps_cache, opencode_dir)
        # All three artefacts should be present
        assert (opencode_dir / "package.json").exists()
        assert (opencode_dir / "package-lock.json").exists()
        assert (opencode_dir / "node_modules").is_dir()

        pkg = json.loads((opencode_dir / "package.json").read_text())
        assert "@opencode-ai/plugin" in pkg["dependencies"]

    def test_does_not_overwrite_existing_files(self, tmp_path):
        """Pre-existing package.json or node_modules in .opencode/ should not be overwritten."""
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        # Build a fake deps cache
        deps_cache = tmp_path / "opencode-deps"
        deps_cache.mkdir()
        (deps_cache / "package.json").write_text('{"name": "cached"}')
        (deps_cache / "package-lock.json").write_text('{"lockfileVersion": 3}')
        (deps_cache / "node_modules").mkdir()

        # Pre-create .opencode/ with existing files (e.g. from snapshot restore)
        opencode_dir = workdir / ".opencode" / "tool"
        opencode_dir.mkdir(parents=True)
        existing_pkg = workdir / ".opencode" / "package.json"
        existing_pkg.write_text('{"name": "existing"}')

        SandboxSupervisor._stage_opencode_deps(deps_cache, workdir / ".opencode")

        # Existing package.json should be preserved, not overwritten by cache
        assert existing_pkg.read_text() == '{"name": "existing"}'

    def test_does_not_claim_a_divergent_existing_lockfile(self, tmp_path):
        """A user lockfile is not runtime-owned merely because package.json matches."""
        deps_cache = tmp_path / "opencode-deps"
        deps_cache.mkdir()
        (deps_cache / "package.json").write_text('{"name": "cached"}')
        (deps_cache / "package-lock.json").write_text('{"runtime": true}')

        opencode_dir = tmp_path / ".opencode"
        opencode_dir.mkdir()
        (opencode_dir / "package.json").write_text('{"name": "cached"}')
        user_lock = opencode_dir / "package-lock.json"
        user_lock.write_text('{"user": true}')

        SandboxSupervisor._stage_opencode_deps(deps_cache, opencode_dir)

        assert user_lock.read_text() == '{"user": true}'

    def test_does_not_claim_preexisting_modules_from_a_matching_package(self, tmp_path):
        """A matching package manifest does not establish ownership of a module tree."""
        deps_cache = tmp_path / "opencode-deps"
        (deps_cache / "node_modules").mkdir(parents=True)
        (deps_cache / "package.json").write_text('{"name": "cached"}')

        opencode_dir = tmp_path / ".opencode"
        user_modules = opencode_dir / "node_modules"
        user_modules.mkdir(parents=True)
        (opencode_dir / "package.json").write_text('{"name": "cached"}')
        user_module = user_modules / "user-package.js"
        user_module.write_text("user module\n")

        SandboxSupervisor._stage_opencode_deps(deps_cache, opencode_dir)

        assert user_module.read_text() == "user module\n"

    def test_legacy_and_tools_dir_combined(self, tmp_path):
        """Both legacy tool and tools/ directory files should be installed together."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        legacy_tool = tmp_path / "app" / "sandbox" / "inspect-plugin.js"
        legacy_tool.parent.mkdir(parents=True)
        legacy_tool.write_text("// legacy")

        tools_dir = tmp_path / "app" / "sandbox" / "tools"
        tools_dir.mkdir(parents=True)
        (tools_dir / "spawn-child.js").write_text("// spawn")
        (tools_dir / "_bridge-client.js").write_text("// bridge")

        with _patch_paths(legacy=legacy_tool, tools=tools_dir):
            sup._install_tools(workdir / ".opencode")

        tool_dest = workdir / ".opencode" / "tool"
        assert (tool_dest / "create-pull-request.js").exists()
        assert (tool_dest / "spawn-child.js").exists()
        assert (tool_dest / "_bridge-client.js").exists()
        js_files = list(tool_dest.glob("*.js"))
        assert len(js_files) == 3

    def test_repository_tools_skipped_without_repository(self, tmp_path):
        """Repo-only PR tools are skipped, but child-spawn tools remain available."""
        sup = _make_supervisor()
        sup.repo_owner = ""
        sup.repo_name = ""
        sup.has_repository = False
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        legacy_tool = tmp_path / "app" / "sandbox" / "inspect-plugin.js"
        legacy_tool.parent.mkdir(parents=True)
        legacy_tool.write_text("// legacy")

        tools_dir = tmp_path / "app" / "sandbox" / "tools"
        tools_dir.mkdir(parents=True)
        (tools_dir / "_bridge-client.js").write_text("// bridge")
        (tools_dir / "spawn-child.js").write_text("// spawn")
        (tools_dir / "get-child-status.js").write_text("// get")
        (tools_dir / "get-child-status-format.js").write_text("// format")
        (tools_dir / "cancel-child.js").write_text("// cancel")

        with _patch_paths(legacy=legacy_tool, tools=tools_dir):
            sup._install_tools(workdir / ".opencode")

        tool_dest = workdir / ".opencode" / "tool"
        assert (tool_dest / "_bridge-client.js").exists()
        assert not (tool_dest / "create-pull-request.js").exists()
        assert (tool_dest / "spawn-child.js").exists()
        assert (tool_dest / "get-child-status.js").exists()
        assert (tool_dest / "get-child-status-format.js").exists()
        assert (tool_dest / "cancel-child.js").exists()

    def test_slack_notify_installed_when_enabled(self, tmp_path):
        """slack-notify.js should be installed when AGENT_SLACK_NOTIFY_ENABLED=true."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        tools_dir = tmp_path / "app" / "sandbox" / "tools"
        tools_dir.mkdir(parents=True)
        (tools_dir / "slack-notify.js").write_text("// slack-notify")
        (tools_dir / "spawn-child.js").write_text("// spawn-child")

        with (
            patch.dict("os.environ", {"AGENT_SLACK_NOTIFY_ENABLED": "true"}),
            _patch_paths(legacy=tmp_path / "no-legacy", tools=tools_dir),
        ):
            sup._install_tools(workdir / ".opencode")

        tool_dest = workdir / ".opencode" / "tool"
        assert (tool_dest / "slack-notify.js").exists()
        assert (tool_dest / "spawn-child.js").exists()


class TestPrepareOpencodeFilesystem:
    def test_installs_runtime_assets_outside_checkout_and_reconciles_stale_files(self, tmp_path):
        sup = _make_supervisor()
        checkout = tmp_path / "checkout"
        project_config = checkout / ".opencode"
        project_config.mkdir(parents=True)
        project_tool = project_config / "tool" / "project.js"
        project_tool.parent.mkdir()
        project_tool.write_text("project tool")

        runtime_config = tmp_path / "runtime-config"
        stale_tool = runtime_config / "tool" / "stale.js"
        stale_tool.parent.mkdir(parents=True)
        stale_tool.write_text("stale")
        stale_plugin = runtime_config / "plugins" / "codex-auth-plugin.js"
        stale_plugin.parent.mkdir()
        stale_plugin.write_text("stale plugin")
        cached_module = runtime_config / "node_modules" / "cached" / "index.js"
        cached_module.parent.mkdir(parents=True)
        cached_module.write_text("cached")
        (runtime_config / "package.json").write_text('{"runtime": true}')

        tools_dir = tmp_path / "app" / "tools"
        tools_dir.mkdir(parents=True)
        (tools_dir / "spawn-child.js").write_text("runtime tool")
        skills_dir = tmp_path / "app" / "skills" / "record-video"
        skills_dir.mkdir(parents=True)
        (skills_dir / "SKILL.md").write_text("runtime skill")

        sup._assemble_workspace_opencode = MagicMock()
        sup._seed_global_opencode_deps = MagicMock()
        sup._install_bin_scripts = MagicMock()
        with _patch_paths(
            legacy=tmp_path / "no-legacy",
            tools=tools_dir,
            skills=skills_dir.parent,
        ):
            sup._prepare_opencode_filesystem(runtime_config)

        assert not stale_tool.exists()
        assert not stale_plugin.exists()
        assert cached_module.read_text() == "cached"
        assert (runtime_config / "tool" / "spawn-child.js").read_text() == "runtime tool"
        assert (
            runtime_config / "skills" / "record-video" / "SKILL.md"
        ).read_text() == "runtime skill"
        assert project_tool.read_text() == "project tool"
        sup._assemble_workspace_opencode.assert_called_once_with()

    def test_replaces_symlinked_runtime_config_without_touching_target(self, tmp_path):
        target = tmp_path / "checkout" / ".opencode"
        target.mkdir(parents=True)
        project_file = target / "project.json"
        project_file.write_text("project config")
        runtime_config = tmp_path / "runtime-config"
        runtime_config.symlink_to(target, target_is_directory=True)

        SandboxSupervisor._reset_runtime_opencode_config(runtime_config, tmp_path / "no-cache")

        assert project_file.read_text() == "project config"
        assert not runtime_config.is_symlink()
        assert runtime_config.is_dir()

    def test_removes_symlinked_module_cache_without_touching_target(self, tmp_path):
        target = tmp_path / "modules"
        target.mkdir()
        cached_file = target / "index.js"
        cached_file.write_text("external cache")
        runtime_config = tmp_path / "runtime-config"
        runtime_config.mkdir()
        (runtime_config / "node_modules").symlink_to(target, target_is_directory=True)

        SandboxSupervisor._reset_runtime_opencode_config(runtime_config, tmp_path / "no-cache")

        assert cached_file.read_text() == "external cache"
        assert not (runtime_config / "node_modules").exists()

    def test_replaces_stale_dependency_cache_as_one_unit(self, tmp_path):
        deps_cache = _make_opencode_deps_staging(tmp_path)
        (deps_cache / "package-lock.json").write_text('{"runtime": "current"}')
        runtime_config = tmp_path / "runtime-config"
        stale_module = runtime_config / "node_modules" / "stale" / "index.js"
        stale_module.parent.mkdir(parents=True)
        stale_module.write_text("stale")
        (runtime_config / "package.json").write_text('{"runtime": "old"}')
        (runtime_config / "package-lock.json").write_text('{"runtime": "old"}')

        SandboxSupervisor._reset_runtime_opencode_config(runtime_config, deps_cache)
        SandboxSupervisor._stage_opencode_deps(deps_cache, runtime_config)

        assert not stale_module.exists()
        assert (runtime_config / "package.json").read_text() == (
            deps_cache / "package.json"
        ).read_text()
        assert (runtime_config / "package-lock.json").read_text() == (
            deps_cache / "package-lock.json"
        ).read_text()
        assert (runtime_config / "node_modules" / "@opencode-ai" / "plugin" / "index.js").exists()

    def test_preserves_dependency_cache_when_staged_manifests_match(self, tmp_path):
        deps_cache = _make_opencode_deps_staging(tmp_path)
        runtime_config = tmp_path / "runtime-config"
        shutil.copytree(deps_cache, runtime_config)
        cached_module = runtime_config / "node_modules" / "@opencode-ai" / "plugin" / "index.js"
        stale_tool = runtime_config / "tool" / "stale.js"
        stale_tool.parent.mkdir()
        stale_tool.write_text("stale")

        SandboxSupervisor._reset_runtime_opencode_config(runtime_config, deps_cache)

        assert cached_module.read_text() == "module.exports = {}"
        assert not stale_tool.exists()


class TestInstallBinScripts:
    """Cases for _install_bin_scripts() standalone CLI installation."""

    def test_scripts_installed_to_bin(self, tmp_path):
        """Checked-in bin scripts should be installed as executable commands."""
        sup = _make_supervisor()

        src = tmp_path / "app" / "sandbox_runtime" / "bin"
        src.mkdir(parents=True)
        (src / "upload-media.js").write_text("#!/usr/bin/env node\n// upload cli")
        (src / "oi-git-sign").write_text("#!/bin/sh\n# signer launcher")

        dest = tmp_path / "usr-local-bin"
        dest.mkdir()

        with _patch_paths(
            legacy=tmp_path / "no-legacy", tools=tmp_path / "no-tools", bin_src=src, bin_dest=dest
        ):
            sup._install_bin_scripts()

        installed = dest / "upload-media"
        assert installed.exists()
        assert installed.read_text() == "#!/usr/bin/env node\n// upload cli"
        assert installed.stat().st_mode & 0o755
        signer = dest / "oi-git-sign"
        assert signer.exists()
        assert signer.read_text() == "#!/bin/sh\n# signer launcher"
        assert signer.stat().st_mode & 0o755

    def test_scripts_installed_to_configured_bin(self, tmp_path, monkeypatch):
        """OPENINSPECT_BIN_INSTALL_DIR can override the install directory."""
        sup = _make_supervisor()

        src = tmp_path / "app" / "sandbox_runtime" / "bin"
        src.mkdir(parents=True)
        (src / "upload-media.js").write_text("#!/usr/bin/env node\n// upload cli")

        default_dest = tmp_path / "usr-local-bin"
        default_dest.mkdir()
        user_dest = tmp_path / "configured-bin"
        monkeypatch.setenv("OPENINSPECT_BIN_INSTALL_DIR", str(user_dest))

        with _patch_paths(
            legacy=tmp_path / "no-legacy",
            tools=tmp_path / "no-tools",
            bin_src=src,
            bin_dest=default_dest,
        ):
            sup._install_bin_scripts()

        installed = user_dest / "upload-media"
        assert installed.exists()
        assert installed.read_text() == "#!/usr/bin/env node\n// upload cli"
        assert not (default_dest / "upload-media").exists()

    def test_non_js_files_skipped(self, tmp_path):
        """Non-.js files in bin/ should not be installed."""
        sup = _make_supervisor()

        src = tmp_path / "app" / "sandbox_runtime" / "bin"
        src.mkdir(parents=True)
        (src / "upload-media.js").write_text("// cli")
        (src / "README.md").write_text("# docs")

        dest = tmp_path / "usr-local-bin"
        dest.mkdir()

        with _patch_paths(
            legacy=tmp_path / "no-legacy", tools=tmp_path / "no-tools", bin_src=src, bin_dest=dest
        ):
            sup._install_bin_scripts()

        assert (dest / "upload-media").exists()
        assert not (dest / "README").exists()

    def test_noop_when_bin_dir_missing(self, tmp_path):
        """Should be a no-op when bin/ directory doesn't exist."""
        sup = _make_supervisor()

        dest = tmp_path / "usr-local-bin"
        dest.mkdir()

        with _patch_paths(
            legacy=tmp_path / "no-legacy",
            tools=tmp_path / "no-tools",
            bin_src=tmp_path / "no-bin",
            bin_dest=dest,
        ):
            sup._install_bin_scripts()

        assert list(dest.iterdir()) == []


class TestInstallSkills:
    """Cases for _install_skills() bundled Skill installation."""

    def test_complete_skill_directories_are_copied(self, tmp_path):
        """Bundled Skills should include companion files and directories."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        skills_dir = tmp_path / "app" / "sandbox" / "skills"
        agent_browser_dir = skills_dir / "agent-browser"
        scripts_dir = agent_browser_dir / "scripts"
        references_dir = agent_browser_dir / "references"
        scripts_dir.mkdir(parents=True)
        references_dir.mkdir()
        (agent_browser_dir / "SKILL.md").write_text("# agent-browser")
        (scripts_dir / "helper.py").write_text("print('helper')")
        (references_dir / "notes.md").write_text("Use this reference")
        pycache_dir = scripts_dir / "__pycache__"
        pycache_dir.mkdir()
        (pycache_dir / "helper.cpython-314.pyc").write_bytes(b"compiled")

        record_video_dir = skills_dir / "record-video"
        record_video_dir.mkdir()
        (record_video_dir / "SKILL.md").write_text("# record-video")
        (record_video_dir / "helper.txt").write_text("fresh install")

        (skills_dir / "README.md").write_text("not a skill")
        no_skill_dir = skills_dir / "not-a-skill"
        no_skill_dir.mkdir()
        (no_skill_dir / "notes.md").write_text("missing SKILL.md")

        existing_file = workdir / ".opencode" / "skills" / "agent-browser" / "local.txt"
        existing_file.parent.mkdir(parents=True)
        existing_file.write_text("keep me")

        with _patch_paths(
            legacy=tmp_path / "no-legacy",
            tools=tmp_path / "no-tools",
            skills=skills_dir,
        ):
            sup._install_skills(workdir / ".opencode")

        skill_dest = workdir / ".opencode" / "skills" / "agent-browser"
        assert (skill_dest / "SKILL.md").read_text() == "# agent-browser"
        assert (skill_dest / "scripts" / "helper.py").read_text() == "print('helper')"
        assert (skill_dest / "references" / "notes.md").read_text() == "Use this reference"
        assert not (skill_dest / "scripts" / "__pycache__").exists()
        assert existing_file.read_text() == "keep me"
        fresh_skill_dest = workdir / ".opencode" / "skills" / "record-video"
        assert (fresh_skill_dest / "SKILL.md").read_text() == "# record-video"
        assert (fresh_skill_dest / "helper.txt").read_text() == "fresh install"
        assert not (workdir / ".opencode" / "skills" / "README.md").exists()
        assert not (workdir / ".opencode" / "skills" / "not-a-skill").exists()

    def test_skills_dir_non_directory_is_ignored(self, tmp_path):
        """A non-directory skills path should not raise or copy files."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        skills_file = tmp_path / "app" / "sandbox" / "skills"
        skills_file.parent.mkdir(parents=True)
        skills_file.write_text("not a directory")

        with _patch_paths(
            legacy=tmp_path / "no-legacy",
            tools=tmp_path / "no-tools",
            skills=skills_file,
        ):
            sup._install_skills(workdir / ".opencode")

        assert not (workdir / ".opencode" / "skills").exists()


def _make_opencode_deps_staging(tmp_path: Path) -> Path:
    """Build a fake /app/opencode-deps staging tree (plugin-only, in sync)."""
    deps_cache = tmp_path / "opencode-deps"
    deps_cache.mkdir()
    (deps_cache / "package.json").write_text('{"dependencies": {"@opencode-ai/plugin": "1.17.18"}}')
    (deps_cache / "package-lock.json").write_text('{"lockfileVersion": 3}')
    plugin = deps_cache / "node_modules" / "@opencode-ai" / "plugin"
    plugin.mkdir(parents=True)
    (plugin / "index.js").write_text("module.exports = {}")
    return deps_cache


class TestResolveGlobalConfigDir:
    """Cases for _resolve_opencode_global_config_dir() — OpenCode's xdg-basedir resolution."""

    def test_ignores_opencode_config_dir_override(self, tmp_path, monkeypatch):
        """OPENCODE_CONFIG_DIR is an additional directory, not the XDG global directory."""
        monkeypatch.setenv("OPENCODE_CONFIG_DIR", str(tmp_path / "custom"))
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
        assert (
            SandboxSupervisor._resolve_opencode_global_config_dir() == tmp_path / "xdg" / "opencode"
        )

    def test_uses_xdg_config_home(self, tmp_path, monkeypatch):
        """Without the override, $XDG_CONFIG_HOME/opencode is used."""
        monkeypatch.delenv("OPENCODE_CONFIG_DIR", raising=False)
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
        assert (
            SandboxSupervisor._resolve_opencode_global_config_dir() == tmp_path / "xdg" / "opencode"
        )

    def test_falls_back_to_home_config(self, tmp_path, monkeypatch):
        """With neither set, ~/.config/opencode is used."""
        monkeypatch.delenv("OPENCODE_CONFIG_DIR", raising=False)
        monkeypatch.delenv("XDG_CONFIG_HOME", raising=False)
        monkeypatch.setenv("HOME", str(tmp_path / "home"))
        assert (
            SandboxSupervisor._resolve_opencode_global_config_dir()
            == tmp_path / "home" / ".config" / "opencode"
        )


class TestSeedGlobalOpencodeDeps:
    """Cases for _seed_global_opencode_deps() — seeding OpenCode's global config dir."""

    def test_seeds_empty_global_config_dir(self, tmp_path, monkeypatch):
        """The staged plugin tree is copied into $XDG_CONFIG_HOME/opencode when it is empty."""
        sup = _make_supervisor()
        deps_cache = _make_opencode_deps_staging(tmp_path)
        cfg = tmp_path / "xdg"
        monkeypatch.delenv("OPENCODE_CONFIG_DIR", raising=False)
        monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg))

        with _patch_paths(
            legacy=tmp_path / "no-legacy", tools=tmp_path / "no-tools", deps_cache=deps_cache
        ):
            sup._seed_global_opencode_deps()

        seeded = cfg / "opencode"
        assert (seeded / "package.json").exists()
        assert (seeded / "package-lock.json").exists()
        assert (seeded / "node_modules" / "@opencode-ai" / "plugin").is_dir()

    def test_does_not_clobber_populated_global_dir(self, tmp_path, monkeypatch):
        """An existing global config dir that already has node_modules is left untouched."""
        sup = _make_supervisor()
        deps_cache = _make_opencode_deps_staging(tmp_path)
        cfg = tmp_path / "xdg"
        seeded = cfg / "opencode"
        (seeded / "node_modules").mkdir(parents=True)
        existing_pkg = seeded / "package.json"
        existing_pkg.write_text('{"name": "existing"}')
        monkeypatch.delenv("OPENCODE_CONFIG_DIR", raising=False)
        monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg))

        with _patch_paths(
            legacy=tmp_path / "no-legacy", tools=tmp_path / "no-tools", deps_cache=deps_cache
        ):
            sup._seed_global_opencode_deps()

        assert existing_pkg.read_text() == '{"name": "existing"}'

    def test_skips_when_manifest_present_without_node_modules(self, tmp_path, monkeypatch):
        """A global dir with a user package.json but no node_modules is left untouched —
        seeding our node_modules against a foreign manifest would be an out-of-sync tree."""
        sup = _make_supervisor()
        deps_cache = _make_opencode_deps_staging(tmp_path)
        cfg = tmp_path / "xdg"
        seeded = cfg / "opencode"
        seeded.mkdir(parents=True)
        existing_pkg = seeded / "package.json"
        existing_pkg.write_text('{"name": "user-global"}')
        monkeypatch.delenv("OPENCODE_CONFIG_DIR", raising=False)
        monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg))

        with _patch_paths(
            legacy=tmp_path / "no-legacy", tools=tmp_path / "no-tools", deps_cache=deps_cache
        ):
            sup._seed_global_opencode_deps()

        assert existing_pkg.read_text() == '{"name": "user-global"}'
        assert not (seeded / "node_modules").exists()

    def test_noop_when_staging_absent(self, tmp_path, monkeypatch):
        """No global dir is created when the /app/opencode-deps staging is missing."""
        sup = _make_supervisor()
        cfg = tmp_path / "xdg"
        monkeypatch.delenv("OPENCODE_CONFIG_DIR", raising=False)
        monkeypatch.setenv("XDG_CONFIG_HOME", str(cfg))

        with _patch_paths(
            legacy=tmp_path / "no-legacy",
            tools=tmp_path / "no-tools",
            deps_cache=tmp_path / "missing",
        ):
            sup._seed_global_opencode_deps()

        assert not (cfg / "opencode").exists()
