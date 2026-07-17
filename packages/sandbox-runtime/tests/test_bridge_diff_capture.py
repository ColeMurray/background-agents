import json
import subprocess
from pathlib import Path

import httpx
import pytest

import sandbox_runtime.diff_capture as diff_capture_module
from sandbox_runtime.bridge import AgentBridge
from sandbox_runtime.diff_collector import CapturedFile, RepositoryCapture
from sandbox_runtime.repo_config import RepoEntry, dump_repo_manifest


def _bridge() -> AgentBridge:
    return AgentBridge(
        sandbox_id="sandbox-1",
        session_id="session-1",
        control_plane_url="https://control.example.com",
        auth_token="sandbox-token",
    )


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=repo, check=True, capture_output=True, text=True
    ).stdout.strip()


def test_ready_event_advertises_diff_capability_and_fixed_baselines(tmp_path: Path) -> None:
    manifest = tmp_path / "repositories.json"
    manifest.write_text(
        dump_repo_manifest(
            [
                RepoEntry(
                    owner="open-inspect",
                    name="viewer",
                    branch="main",
                    path=tmp_path / "viewer",
                    base_sha="a" * 40,
                )
            ]
        )
    )
    bridge = _bridge()
    bridge.repo_manifest_path = manifest

    assert bridge._build_ready_event() == {
        "type": "ready",
        "sandboxId": "sandbox-1",
        "opencodeSessionId": None,
        "capabilities": ["session_diff_v1"],
        "repositories": [
            {
                "position": 0,
                "repoOwner": "open-inspect",
                "repoName": "viewer",
                "baseSha": "a" * 40,
            }
        ],
    }


@pytest.mark.asyncio
async def test_capture_command_uploads_patches_then_finalizes_the_manifest(tmp_path: Path) -> None:
    repo = tmp_path / "viewer"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    _git(repo, "config", "user.name", "Bridge Test")
    _git(repo, "config", "user.email", "bridge@example.com")
    (repo / "app.ts").write_text("const value = 1;\n")
    _git(repo, "add", "app.ts")
    _git(repo, "commit", "-m", "baseline")
    baseline = _git(repo, "rev-parse", "HEAD")
    (repo / "app.ts").write_text("const value = 2;\n")

    manifest = tmp_path / "repositories.json"
    manifest.write_text(
        dump_repo_manifest([RepoEntry("open-inspect", "viewer", "main", repo, base_sha=baseline)])
    )
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(201 if request.method == "PUT" else 200)

    bridge = _bridge()
    bridge.repo_manifest_path = manifest
    bridge.http_client = httpx.AsyncClient(transport=httpx.MockTransport(respond))

    await bridge._handle_command(
        {
            "type": "capture_diff",
            "captureId": "capture-1",
            "baselines": [
                {
                    "position": 0,
                    "repoOwner": "open-inspect",
                    "repoName": "viewer",
                    "baseSha": baseline,
                }
            ],
            "limits": {
                "maxFiles": 1000,
                "maxPatchBytes": 1_000_000,
                "maxCaptureBytes": 20_000_000,
                "timeoutMs": 60_000,
            },
        }
    )
    await bridge.http_client.aclose()

    assert [request.method for request in requests] == ["PUT", "POST"]
    assert requests[0].url.path.startswith("/sessions/session-1/diff-captures/capture-1/files/")
    assert requests[0].headers["authorization"] == "Bearer sandbox-token"
    assert requests[0].headers["content-type"].startswith("text/x-diff")
    assert requests[1].url.path == "/sessions/session-1/diff-captures/capture-1/complete"
    completed = json.loads(requests[1].content)
    assert completed["repositories"][0]["files"][0]["path"] == "app.ts"
    assert completed["repositories"][0]["files"][0]["renderState"] == "renderable"


@pytest.mark.asyncio
async def test_capture_manifest_size_matches_a_normalized_non_utf8_upload(tmp_path: Path) -> None:
    repo = tmp_path / "viewer"
    repo.mkdir()
    _git(repo, "init", "-b", "main")
    _git(repo, "config", "user.name", "Bridge Test")
    _git(repo, "config", "user.email", "bridge@example.com")
    (repo / "base.txt").write_text("base\n")
    _git(repo, "add", "base.txt")
    _git(repo, "commit", "-m", "baseline")
    baseline = _git(repo, "rev-parse", "HEAD")
    (repo / "legacy.txt").write_bytes(b"caf\xe9\n")
    manifest = tmp_path / "repositories.json"
    manifest.write_text(
        dump_repo_manifest([RepoEntry("open-inspect", "viewer", "main", repo, base_sha=baseline)])
    )
    requests: list[httpx.Request] = []

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(201 if request.method == "PUT" else 200)

    bridge = _bridge()
    bridge.repo_manifest_path = manifest
    bridge.http_client = httpx.AsyncClient(transport=httpx.MockTransport(respond))

    await bridge._handle_command(
        {
            "type": "capture_diff",
            "captureId": "capture-non-utf8",
            "baselines": [
                {
                    "position": 0,
                    "repoOwner": "open-inspect",
                    "repoName": "viewer",
                    "baseSha": baseline,
                }
            ],
            "limits": {
                "maxFiles": 1000,
                "maxPatchBytes": 1_000_000,
                "maxCaptureBytes": 20_000_000,
                "timeoutMs": 60_000,
            },
        }
    )
    await bridge.http_client.aclose()

    assert [request.method for request in requests] == ["PUT", "POST"]
    completed = json.loads(requests[1].content)
    changed = completed["repositories"][0]["files"][0]
    assert changed["path"] == "legacy.txt"
    assert changed["patchBytes"] == len(requests[0].content)


@pytest.mark.asyncio
async def test_capture_limits_are_shared_across_multi_repository_sessions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repositories = [
        RepoEntry("acme", "web", "main", tmp_path / "web", base_sha="a" * 40),
        RepoEntry("acme", "api", "main", tmp_path / "api", base_sha="b" * 40),
    ]
    for repository in repositories:
        repository.path.mkdir()
    manifest = tmp_path / "repositories.json"
    manifest.write_text(dump_repo_manifest(repositories))
    observed_limits: list[tuple[int, int]] = []

    async def collect(repository: RepoEntry, base_sha: str, limits):
        observed_limits.append((limits.max_files, limits.max_capture_bytes))
        files = (
            (
                CapturedFile(
                    id="file-1",
                    path="app.ts",
                    old_path=None,
                    status="modified",
                    additions=1,
                    deletions=1,
                    render_state="renderable",
                    patch="diff --git a/app.ts b/app.ts\n",
                    patch_bytes=32,
                ),
            )
            if repository.name == "web"
            else ()
        )
        return RepositoryCapture(repository, base_sha, "c" * 40, files, False, 0)

    monkeypatch.setattr(diff_capture_module, "collect_repository_diff", collect)
    bridge = _bridge()
    bridge.repo_manifest_path = manifest
    bridge.http_client = httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda request: httpx.Response(201 if request.method == "PUT" else 200)
        )
    )

    await bridge._handle_command(
        {
            "type": "capture_diff",
            "captureId": "capture-global-limits",
            "baselines": [
                {
                    "position": index,
                    "repoOwner": repo.owner,
                    "repoName": repo.name,
                    "baseSha": repo.base_sha,
                }
                for index, repo in enumerate(repositories)
            ],
            "limits": {
                "maxFiles": 1,
                "maxPatchBytes": 100,
                "maxCaptureBytes": 40,
                "timeoutMs": 60_000,
            },
        }
    )
    await bridge.http_client.aclose()

    assert observed_limits == [(1, 40), (0, 8)]
