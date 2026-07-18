"""Tests for _install_tools() and _install_bin_scripts() in SandboxSupervisor."""

import json
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch

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
            installed = sup._install_tools(workdir)

        dest = workdir / ".opencode" / "tool" / "create-pull-request.js"
        assert dest.exists()
        assert dest.read_text() == "// legacy tool"
        assert installed == {".opencode/tool/create-pull-request.js"}

    def test_tools_dir_files_copied(self, tmp_path):
        """All .js files from tools/ directory should be copied."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        tools_dir = tmp_path / "app" / "sandbox" / "tools"
        tools_dir.mkdir(parents=True)
        (tools_dir / "_bridge-client.js").write_text("// bridge client")
        (tools_dir / "spawn-task.js").write_text("// spawn task")
        (tools_dir / "get-task-status.js").write_text("// get status")
        (tools_dir / "cancel-task.js").write_text("// cancel task")

        with _patch_paths(legacy=tmp_path / "no-legacy", tools=tools_dir):
            sup._install_tools(workdir)

        tool_dest = workdir / ".opencode" / "tool"
        assert (tool_dest / "_bridge-client.js").exists()
        assert (tool_dest / "spawn-task.js").exists()
        assert (tool_dest / "get-task-status.js").exists()
        assert (tool_dest / "cancel-task.js").exists()
        assert (tool_dest / "_bridge-client.js").read_text() == "// bridge client"

    def test_non_js_files_skipped(self, tmp_path):
        """Non-.js files in tools/ directory should not be copied."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        tools_dir = tmp_path / "app" / "sandbox" / "tools"
        tools_dir.mkdir(parents=True)
        (tools_dir / "spawn-task.js").write_text("// tool")
        (tools_dir / "README.md").write_text("# docs")
        (tools_dir / "helper.py").write_text("# python")

        with _patch_paths(legacy=tmp_path / "no-legacy", tools=tools_dir):
            sup._install_tools(workdir)

        tool_dest = workdir / ".opencode" / "tool"
        assert (tool_dest / "spawn-task.js").exists()
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
            sup._install_tools(workdir)

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
            sup._install_tools(workdir)

        assert not (workdir / ".opencode").exists()

    def test_copies_prebuilt_deps_from_cache(self, tmp_path):
        """Should copy package.json, package-lock.json, and node_modules from image cache."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        legacy_tool = tmp_path / "app" / "sandbox" / "inspect-plugin.js"
        legacy_tool.parent.mkdir(parents=True)
        legacy_tool.write_text("// tool")

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

        with _patch_paths(legacy=legacy_tool, tools=tmp_path / "no-tools", deps_cache=deps_cache):
            installed = sup._install_tools(workdir)

        opencode_dir = workdir / ".opencode"
        # All three artefacts should be present
        assert (opencode_dir / "package.json").exists()
        assert (opencode_dir / "package-lock.json").exists()
        assert (opencode_dir / "node_modules").is_dir()

        pkg = json.loads((opencode_dir / "package.json").read_text())
        assert "@opencode-ai/plugin" in pkg["dependencies"]
        assert installed == {
            ".opencode/tool/create-pull-request.js",
            ".opencode/package.json",
            ".opencode/package-lock.json",
            ".opencode/node_modules/",
        }

    def test_does_not_overwrite_existing_files(self, tmp_path):
        """Pre-existing package.json or node_modules in .opencode/ should not be overwritten."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        legacy_tool = tmp_path / "app" / "sandbox" / "inspect-plugin.js"
        legacy_tool.parent.mkdir(parents=True)
        legacy_tool.write_text("// tool")

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

        with _patch_paths(legacy=legacy_tool, tools=tmp_path / "no-tools", deps_cache=deps_cache):
            installed = sup._install_tools(workdir)

        # Existing package.json should be preserved, not overwritten by cache
        assert existing_pkg.read_text() == '{"name": "existing"}'
        assert ".opencode/package.json" not in installed
        assert ".opencode/package-lock.json" in installed
        assert ".opencode/node_modules/" in installed

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

        installed = SandboxSupervisor._stage_opencode_deps(deps_cache, opencode_dir)

        assert installed == {"package.json"}
        assert user_lock.read_text() == '{"user": true}'

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
        (tools_dir / "spawn-task.js").write_text("// spawn")
        (tools_dir / "_bridge-client.js").write_text("// bridge")

        with _patch_paths(legacy=legacy_tool, tools=tools_dir):
            sup._install_tools(workdir)

        tool_dest = workdir / ".opencode" / "tool"
        assert (tool_dest / "create-pull-request.js").exists()
        assert (tool_dest / "spawn-task.js").exists()
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
        (tools_dir / "spawn-task.js").write_text("// spawn")
        (tools_dir / "get-task-status.js").write_text("// get")
        (tools_dir / "get-task-status-format.js").write_text("// format")
        (tools_dir / "cancel-task.js").write_text("// cancel")

        with _patch_paths(legacy=legacy_tool, tools=tools_dir):
            sup._install_tools(workdir)

        tool_dest = workdir / ".opencode" / "tool"
        assert (tool_dest / "_bridge-client.js").exists()
        assert not (tool_dest / "create-pull-request.js").exists()
        assert (tool_dest / "spawn-task.js").exists()
        assert (tool_dest / "get-task-status.js").exists()
        assert (tool_dest / "get-task-status-format.js").exists()
        assert (tool_dest / "cancel-task.js").exists()

    def test_slack_notify_installed_when_enabled(self, tmp_path):
        """slack-notify.js should be installed when AGENT_SLACK_NOTIFY_ENABLED=true."""
        sup = _make_supervisor()
        workdir = tmp_path / "workspace"
        workdir.mkdir()

        tools_dir = tmp_path / "app" / "sandbox" / "tools"
        tools_dir.mkdir(parents=True)
        (tools_dir / "slack-notify.js").write_text("// slack-notify")
        (tools_dir / "spawn-task.js").write_text("// spawn-task")

        with (
            patch.dict("os.environ", {"AGENT_SLACK_NOTIFY_ENABLED": "true"}),
            _patch_paths(legacy=tmp_path / "no-legacy", tools=tools_dir),
        ):
            sup._install_tools(workdir)

        tool_dest = workdir / ".opencode" / "tool"
        assert (tool_dest / "slack-notify.js").exists()
        assert (tool_dest / "spawn-task.js").exists()


class TestInstallBinScripts:
    """Cases for _install_bin_scripts() standalone CLI installation."""

    def test_scripts_installed_to_bin(self, tmp_path):
        """JS scripts in bin/ should be copied to /usr/local/bin without .js extension."""
        sup = _make_supervisor()

        src = tmp_path / "app" / "sandbox_runtime" / "bin"
        src.mkdir(parents=True)
        (src / "upload-media.js").write_text("#!/usr/bin/env node\n// upload cli")

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
            installed = sup._install_skills(workdir)

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
        assert installed == {
            ".opencode/skills/agent-browser/SKILL.md",
            ".opencode/skills/agent-browser/references/notes.md",
            ".opencode/skills/agent-browser/scripts/helper.py",
            ".opencode/skills/record-video/SKILL.md",
            ".opencode/skills/record-video/helper.txt",
        }
        assert ".opencode/skills/agent-browser/local.txt" not in installed

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
            sup._install_skills(workdir)

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

    def test_uses_opencode_config_dir_override(self, tmp_path, monkeypatch):
        """OPENCODE_CONFIG_DIR wins over XDG_CONFIG_HOME and is used verbatim."""
        monkeypatch.setenv("OPENCODE_CONFIG_DIR", str(tmp_path / "custom"))
        monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "xdg"))
        assert SandboxSupervisor._resolve_opencode_global_config_dir() == tmp_path / "custom"

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
