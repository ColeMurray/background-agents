"""Tests for sandbox media tool scripts."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

NODE_BINARY = shutil.which("node")
TOOLS_DIR = Path(__file__).resolve().parents[1] / "src" / "sandbox_runtime" / "tools"
UPLOAD_MEDIA_SCRIPT = TOOLS_DIR / "upload-media.js"
BRIDGE_CLIENT_MODULE = TOOLS_DIR / "_bridge-client.js"
TOOL_SUBPROCESS_TIMEOUT_SECONDS = 10


pytestmark = pytest.mark.skipif(NODE_BINARY is None, reason="node is required for media tool tests")


def _tool_env(overrides: dict[str, str] | None = None) -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "sandbox-token",
            "SESSION_CONFIG": json.dumps({"sessionId": "session-1"}),
        }
    )
    if overrides:
        env.update(overrides)
    return env


def test_upload_media_rejects_non_file_paths(tmp_path: Path) -> None:
    result = subprocess.run(
        [NODE_BINARY, str(UPLOAD_MEDIA_SCRIPT), str(tmp_path)],
        capture_output=True,
        text=True,
        env=_tool_env(),
        check=False,
        timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
    )

    assert result.returncode == 1
    assert "requires a path to a file" in result.stderr


def test_upload_media_requires_active_prompt_message_id(tmp_path: Path) -> None:
    screenshot = tmp_path / "shot.png"
    screenshot.write_bytes(b"\x89PNG\r\n\x1a\n")

    result = subprocess.run(
        [NODE_BINARY, str(UPLOAD_MEDIA_SCRIPT), str(screenshot)],
        capture_output=True,
        text=True,
        env=_tool_env(
            {
                "OPENINSPECT_CURRENT_MESSAGE_ID_FILE": str(tmp_path / "missing-message-id"),
            }
        ),
        check=False,
        timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
    )

    assert result.returncode == 1
    assert "No active prompt messageId found" in result.stderr


def test_upload_media_rejects_unsupported_extensions(tmp_path: Path) -> None:
    unsupported = tmp_path / "shot.gif"
    unsupported.write_bytes(b"GIF89a")
    message_id_file = tmp_path / "message-id"
    message_id_file.write_text("msg-1")

    result = subprocess.run(
        [NODE_BINARY, str(UPLOAD_MEDIA_SCRIPT), str(unsupported)],
        capture_output=True,
        text=True,
        env=_tool_env(
            {
                "OPENINSPECT_CURRENT_MESSAGE_ID_FILE": str(message_id_file),
            }
        ),
        check=False,
        timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
    )

    assert result.returncode == 1
    assert "only supports .png, .jpg, .jpeg, and .webp files" in result.stderr


def test_bridge_client_requires_sandbox_auth_token() -> None:
    result = subprocess.run(
        [
            NODE_BINARY,
            "--input-type=module",
            "-e",
            (
                "import(process.argv[1]).catch((error) => {"
                "console.error(error.message);"
                "process.exit(1);"
                "});"
            ),
            BRIDGE_CLIENT_MODULE.as_uri(),
        ],
        capture_output=True,
        text=True,
        env=_tool_env({"SANDBOX_AUTH_TOKEN": ""}),
        check=False,
        timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
    )

    assert result.returncode == 1
    assert "SANDBOX_AUTH_TOKEN not set" in result.stderr
