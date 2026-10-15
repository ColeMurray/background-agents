"""Exercise the documented PR-media workflow with real gh and a local API fixture.

No requests reach GitHub and all credentials are synthetic. Older CI images without
the CLI's attachment feature skip this contract test; wrapper tests remain mandatory.
"""

import json
import os
import shlex
import socketserver
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from sandbox_runtime.repository_sync import GH_WRAPPER_BODY

PR_URL = "https://github.com/octo/repo/pull/23"
ORIGINAL_BODY = "Existing PR description\n\nCreated with OpenInspect"


@pytest.mark.parametrize("token_prefix", ["gho", "ghs"])
def test_github_pr_media_upload_preserves_body_and_checks_auth(tmp_path, monkeypatch, token_prefix):
    real_gh = Path("/usr/bin/gh")
    if not real_gh.is_file():
        pytest.skip("GitHub CLI is not installed")
    help_result = subprocess.run(
        [str(real_gh), "pr", "edit", "--help"], capture_output=True, text=True, check=True
    )
    if "--attach" not in help_result.stdout:
        pytest.skip("GitHub CLI does not support media attachments")

    uploads = []
    updates = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if self.path.startswith("/user-attachments/assets?"):
                params = parse_qs(urlsplit(self.path).query)
                uploads.append((params, raw))
                data = {"url": f"https://github.com/user-attachments/assets/{len(uploads)}"}
            else:
                assert self.path == "/graphql"
                body = json.loads(raw)
                query = body["query"]
                if "mutation PullRequestUpdate" in query:
                    updates.append(body["variables"]["input"])
                    data = {
                        "data": {"updatePullRequest": {"__typename": "UpdatePullRequestPayload"}}
                    }
                elif "PullRequestProjectItems" in query:
                    data = {
                        "data": {
                            "repository": {
                                "pullRequest": {
                                    "projectItems": {
                                        "nodes": [],
                                        "totalCount": 0,
                                        "pageInfo": {"hasNextPage": False, "endCursor": ""},
                                    }
                                }
                            }
                        }
                    }
                else:
                    assert "PullRequestByNumber" in query
                    data = {
                        "data": {
                            "repository": {
                                "pullRequest": {
                                    "id": "PR_23",
                                    "number": 23,
                                    "url": PR_URL,
                                    "body": ORIGINAL_BODY,
                                    "title": "PR",
                                    "baseRefName": "main",
                                    "repository": {"databaseId": 123, "viewerPermission": "WRITE"},
                                    "assignedActors": {"nodes": []},
                                    "reviewRequests": {"nodes": []},
                                    "labels": {"nodes": []},
                                }
                            }
                        }
                    }
            encoded = json.dumps(data).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    # gh's config transport routes HTTPS hosts to this local socket,
    # including uploads and GraphQL. No host or credential is real.
    socket_path = tmp_path / "api.sock"
    monkeypatch.setenv("GH_CONFIG_DIR", str(tmp_path))
    monkeypatch.setenv("GH_TOKEN", f"{token_prefix}_synthetic_test_token")
    monkeypatch.setenv("GH_TELEMETRY", "false")
    monkeypatch.setenv("GH_PROMPT_DISABLED", "1")
    monkeypatch.setenv("GH_NO_UPDATE_NOTIFIER", "1")
    monkeypatch.setenv("PYTHONPATH", str(Path(__file__).parents[1] / "src"))
    (tmp_path / "config.yml").write_text(f"http_unix_socket: {socket_path}\n")
    wrapper = tmp_path / "gh"
    wrapper.write_text(GH_WRAPPER_BODY.replace("python3 -m", f"{shlex.quote(sys.executable)} -m"))
    image = tmp_path / "after state.png"
    image.write_bytes(b"\x89PNG\r\n\x1a\nimage fixture")
    video = tmp_path / "demo.mp4"
    video.write_bytes(b"\x00\x00\x00\x18ftypmp42video fixture")

    with socketserver.UnixStreamServer(str(socket_path), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            result = subprocess.run(
                [
                    "sh",
                    str(wrapper),
                    "pr",
                    "edit",
                    PR_URL,
                    "--attach",
                    f"{image}#After the fix",
                    "--attach",
                    str(video),
                ],
                env=os.environ.copy(),
                text=True,
                capture_output=True,
                timeout=15,
                check=False,
            )
        finally:
            server.shutdown()
            thread.join()

    if token_prefix == "ghs":
        assert result.returncode != 0
        assert "unsupported authentication type" in result.stderr
        assert uploads == []
        assert updates == []
        return

    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == PR_URL
    assert len(uploads) == 2
    for (params, raw), path, mime in zip(
        uploads, [image, video], ["image/png", "video/mp4"], strict=True
    ):
        assert params == {"name": [path.name], "content_type": [mime], "repository_id": ["123"]}
        assert raw == path.read_bytes()
    assert updates == [
        {
            "pullRequestId": "PR_23",
            "body": ORIGINAL_BODY
            + "\n\n![After the fix](https://github.com/user-attachments/assets/1)"
            + "\n\nhttps://github.com/user-attachments/assets/2",
        }
    ]
