"""Tests for sandbox media tool scripts."""

import json
import os
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, ClassVar

import pytest

NODE_BINARY = shutil.which("node")
RUNTIME_DIR = Path(__file__).resolve().parents[1] / "src" / "sandbox_runtime"
UPLOAD_MEDIA_SCRIPT = RUNTIME_DIR / "bin" / "upload-media.js"
BRIDGE_CLIENT_MODULE = RUNTIME_DIR / "tools" / "_bridge-client.js"
TOOL_SUBPROCESS_TIMEOUT_SECONDS = 10
MP4_BYTES = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom"


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


class _CaptureHandler(BaseHTTPRequestHandler):
    requests: ClassVar[list[dict[str, Any]]] = []
    status_code: ClassVar[int] = 201
    response_body: ClassVar[bytes] = b'{"artifactId":"artifact-1"}'

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        type(self).requests.append(
            {
                "path": self.path,
                "authorization": self.headers.get("authorization"),
                "content_type": self.headers.get("content-type"),
                "body": body,
            }
        )
        self.send_response(type(self).status_code)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(type(self).response_body)

    def log_message(self, format: str, *args: Any) -> None:
        return


class _CaptureServer:
    def __init__(
        self, status_code: int = 201, response_body: bytes = b'{"artifactId":"artifact-1"}'
    ):
        self.status_code = status_code
        self.response_body = response_body

    def __enter__(self) -> "_CaptureServer":
        _CaptureHandler.requests = []
        _CaptureHandler.status_code = self.status_code
        _CaptureHandler.response_body = self.response_body
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _CaptureHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        self.requests = _CaptureHandler.requests
        return self

    def __exit__(self, *args: object) -> None:
        self.server.shutdown()
        self.thread.join(timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS)
        self.server.server_close()


def _multipart_text(body: bytes) -> str:
    return body.decode("utf-8", errors="ignore")


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


def test_upload_media_rejects_unsupported_extensions(tmp_path: Path) -> None:
    unsupported = tmp_path / "shot.gif"
    unsupported.write_bytes(b"GIF89a")

    result = subprocess.run(
        [NODE_BINARY, str(UPLOAD_MEDIA_SCRIPT), str(unsupported)],
        capture_output=True,
        text=True,
        env=_tool_env(),
        check=False,
        timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
    )

    assert result.returncode == 1
    assert "only supports .png, .jpg, .jpeg, .webp, and .mp4 files" in result.stderr


def test_upload_media_requires_explicit_video_artifact_type(tmp_path: Path) -> None:
    video = tmp_path / "recording.mp4"
    video.write_bytes(MP4_BYTES)

    result = subprocess.run(
        [NODE_BINARY, str(UPLOAD_MEDIA_SCRIPT), str(video)],
        capture_output=True,
        text=True,
        env=_tool_env(),
        check=False,
        timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
    )

    assert result.returncode == 1
    assert "MP4 files must be uploaded with --artifact-type video" in result.stderr


def test_upload_media_posts_video_metadata(tmp_path: Path) -> None:
    video = tmp_path / "recording.mp4"
    video.write_bytes(MP4_BYTES)

    with _CaptureServer() as server:
        result = subprocess.run(
            [
                NODE_BINARY,
                str(UPLOAD_MEDIA_SCRIPT),
                str(video),
                "--artifact-type",
                "video",
                "--caption",
                "Menu opens",
                "--source-url",
                "https://app.example.com/start",
                "--end-url",
                "https://app.example.com/end",
                "--duration-ms",
                "1200",
                "--recording-started-at",
                "1000",
                "--recording-ended-at",
                "2200",
                "--dimensions",
                '{"width":1280,"height":720}',
                "--truncated",
                "false",
            ],
            capture_output=True,
            text=True,
            env=_tool_env({"CONTROL_PLANE_URL": server.url}),
            check=False,
            timeout=TOOL_SUBPROCESS_TIMEOUT_SECONDS,
        )

    assert result.returncode == 0
    assert json.loads(result.stdout)["artifactId"] == "artifact-1"
    assert len(server.requests) == 1
    request = server.requests[0]
    assert request["path"] == "/sessions/session-1/media"
    assert request["authorization"] == "Bearer sandbox-token"
    body = _multipart_text(request["body"])
    assert 'name="artifactType"\r\n\r\nvideo' in body
    assert 'name="caption"\r\n\r\nMenu opens' in body
    assert 'name="durationMs"\r\n\r\n1200' in body
    assert 'name="dimensions"\r\n\r\n{"width":1280,"height":720}' in body


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
