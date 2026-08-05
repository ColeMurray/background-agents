"""Tests for create-pull-request repository target resolution."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

NODE_BINARY = shutil.which("node")
INSPECT_PLUGIN = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "sandbox_runtime"
    / "plugins"
    / "inspect-plugin.js"
)

pytestmark = pytest.mark.skipif(NODE_BINARY is None, reason="node is required")
TOOL_SUBPROCESS_TIMEOUT_SECONDS = 10


def _plugin_module(tmp_path: Path) -> Path:
    module = tmp_path / "inspect-plugin.js"
    shutil.copyfile(INSPECT_PLUGIN, module)
    (tmp_path / "package.json").write_text('{"type":"module"}')

    plugin_package = tmp_path / "node_modules" / "@opencode-ai" / "plugin"
    plugin_package.mkdir(parents=True)
    (plugin_package / "package.json").write_text('{"type":"module","exports":"./index.js"}')
    (plugin_package / "index.js").write_text("export const tool = (config) => config;")

    zod_package = tmp_path / "node_modules" / "zod"
    zod_package.mkdir(parents=True)
    (zod_package / "package.json").write_text('{"type":"module","exports":"./index.js"}')
    (zod_package / "index.js").write_text(
        "const schema = {"
        " describe(description) { this.description = description; return this; },"
        " optional() { return this; }"
        "};"
        "export const z = {"
        " string() { return Object.create(schema); },"
        " boolean() { return Object.create(schema); }"
        "};"
    )
    return module


def _resolve(
    tmp_path: Path, repo: str, repositories: list[dict[str, str]]
) -> dict[str, str] | None:
    script = """
      console.log = () => {};
      const { resolveRepositoryTarget } = await import(process.argv[1]);
      const result = resolveRepositoryTarget(process.argv[2], JSON.parse(process.argv[3]));
      process.stdout.write(JSON.stringify(result));
    """
    target_module = _plugin_module(tmp_path)
    result = subprocess.run(
        [
            NODE_BINARY,
            "--input-type=module",
            "-e",
            script,
            target_module.as_uri(),
            repo,
            json.dumps(repositories),
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
    )
    return json.loads(result.stdout)


def test_resolves_nested_owner_from_manifest(tmp_path: Path) -> None:
    repositories = [{"owner": "Group/Subgroup", "name": "Web", "path": "/workspace/web"}]

    assert _resolve(tmp_path, "group/subgroup/web", repositories) == repositories[0]


def test_parses_nested_owner_without_manifest(tmp_path: Path) -> None:
    assert _resolve(tmp_path, "group/subgroup/web", []) == {
        "owner": "group/subgroup",
        "name": "web",
    }


@pytest.mark.parametrize("repo", ["web", "/web", "group/", "group//web"])
def test_rejects_malformed_repository_names(tmp_path: Path, repo: str) -> None:
    assert _resolve(tmp_path, repo, []) is None


def test_draft_mode_requires_explicit_user_request(tmp_path: Path) -> None:
    script = """
      console.log = () => {};
      const { default: pullRequestTool } = await import(process.argv[1]);
      process.stdout.write(pullRequestTool.args.draft.description);
    """
    result = subprocess.run(
        [
            NODE_BINARY,
            "--input-type=module",
            "-e",
            script,
            _plugin_module(tmp_path).as_uri(),
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
    )

    assert "true only when the user explicitly asks for a draft" in result.stdout
    assert "otherwise omit this field" in result.stdout


@pytest.mark.parametrize(
    ("state", "message"),
    [
        ("draft", "The pull request is in draft mode."),
        ("open", "The pull request is now ready for review."),
    ],
)
def test_formats_pull_request_state(tmp_path: Path, state: str, message: str) -> None:
    script = """
      console.log = () => {};
      const { formatPullRequestSuccess } = await import(process.argv[1]);
      process.stdout.write(formatPullRequestSuccess({
        prNumber: 42,
        prUrl: "https://example.test/pull/42",
        state: process.argv[2],
      }));
    """
    result = subprocess.run(
        [
            NODE_BINARY,
            "--input-type=module",
            "-e",
            script,
            _plugin_module(tmp_path).as_uri(),
            state,
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
    )

    assert message in result.stdout
