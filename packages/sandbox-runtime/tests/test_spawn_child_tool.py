"""Tests for the agent-facing spawn-child tool."""

import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

import pytest

NODE_BINARY = shutil.which("node")
SPAWN_CHILD_TOOL = (
    Path(__file__).resolve().parents[1] / "src" / "sandbox_runtime" / "tools" / "spawn-child.js"
)
TOOL_SUBPROCESS_TIMEOUT_SECONDS = 10

pytestmark = pytest.mark.skipif(NODE_BINARY is None, reason="node is required")


def _tool_module(tmp_path: Path) -> Path:
    module = tmp_path / "spawn-child.js"
    shutil.copyfile(SPAWN_CHILD_TOOL, module)
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
        " optional() { this.isOptional = true; return this; }"
        "};"
        "export const z = { string() { return Object.create(schema); } };"
    )

    (tmp_path / "_bridge-client.js").write_text(
        "export async function bridgeFetch(path, options) {"
        " globalThis.capturedRequest = { path, options };"
        " return new Response(JSON.stringify({ sessionId: 'child-1' }), {"
        "   status: 201, headers: { 'Content-Type': 'application/json' }"
        " });"
        "}"
        "export async function extractError(response) { return response.text(); }"
    )
    return module


def _run_tool(tmp_path: Path, args: dict[str, str] | None = None) -> dict[str, Any]:
    script = """
      const tool = (await import(process.argv[1])).default;
      if (process.argv[2]) {
        await tool.execute(JSON.parse(process.argv[2]));
      }
      process.stdout.write(JSON.stringify({
        request: globalThis.capturedRequest,
      }));
    """
    result = subprocess.run(
        [
            NODE_BINARY,
            "--input-type=module",
            "-e",
            script,
            _tool_module(tmp_path).as_uri(),
            json.dumps(args) if args is not None else "",
        ],
        capture_output=True,
        text=True,
        check=True,
        timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
    )
    return json.loads(result.stdout)


def test_serializes_reasoning_as_reasoning_effort(tmp_path: Path) -> None:
    result = _run_tool(
        tmp_path,
        {"title": "Child task", "prompt": "Do the thing", "reasoning": "high"},
    )

    assert json.loads(result["request"]["options"]["body"]) == {
        "title": "Child task",
        "prompt": "Do the thing",
        "reasoningEffort": "high",
    }


def test_serializes_empty_reasoning_for_backend_compatibility_handling(tmp_path: Path) -> None:
    result = _run_tool(
        tmp_path,
        {"title": "Child task", "prompt": "Do the thing", "reasoning": ""},
    )

    assert json.loads(result["request"]["options"]["body"])["reasoningEffort"] == ""


def test_omits_reasoning_effort_to_inherit_parent_setting(tmp_path: Path) -> None:
    result = _run_tool(tmp_path, {"title": "Child task", "prompt": "Do the thing"})

    assert json.loads(result["request"]["options"]["body"]) == {
        "title": "Child task",
        "prompt": "Do the thing",
    }
