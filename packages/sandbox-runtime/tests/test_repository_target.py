"""Tests for create-pull-request repository target resolution."""

import json
import shutil
import subprocess
from pathlib import Path

import pytest

NODE_BINARY = shutil.which("node")
TARGET_MODULE = (
    Path(__file__).resolve().parents[1]
    / "src"
    / "sandbox_runtime"
    / "plugins"
    / "repository-target.js"
)

pytestmark = pytest.mark.skipif(NODE_BINARY is None, reason="node is required")


def _resolve(repo: str, repositories: list[dict[str, str]]) -> dict[str, str] | None:
    script = """
      const { resolveRepositoryTarget } = await import(process.argv[1]);
      const result = resolveRepositoryTarget(process.argv[2], JSON.parse(process.argv[3]));
      console.log(JSON.stringify(result));
    """
    result = subprocess.run(
        [
            NODE_BINARY,
            "--input-type=module",
            "-e",
            script,
            TARGET_MODULE.as_uri(),
            repo,
            json.dumps(repositories),
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=10,
    )
    return json.loads(result.stdout)


def test_resolves_nested_owner_from_manifest() -> None:
    repositories = [{"owner": "Group/Subgroup", "name": "Web", "path": "/workspace/web"}]

    assert _resolve("group/subgroup/web", repositories) == repositories[0]


def test_parses_nested_owner_without_manifest() -> None:
    assert _resolve("group/subgroup/web", []) == {
        "owner": "group/subgroup",
        "name": "web",
    }


@pytest.mark.parametrize("repo", ["web", "/web", "group/", "group//web"])
def test_rejects_malformed_repository_names(repo: str) -> None:
    assert _resolve(repo, []) is None
