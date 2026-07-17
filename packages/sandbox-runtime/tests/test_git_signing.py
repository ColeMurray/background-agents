import subprocess
from unittest.mock import MagicMock

import httpx
import pytest

from sandbox_runtime.git_signing import GitSigningRuntime
from sandbox_runtime.repo_config import RepoEntry, dump_repo_manifest
from sandbox_runtime.types import GitUser

PRIVATE_KEY = """-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACAWjNIIM/EVjs9Jat8bPrzT757lrNEkt9LcaUiU29+e6QAAAKAVa6SnFWuk
pwAAAAtzc2gtZWQyNTUxOQAAACAWjNIIM/EVjs9Jat8bPrzT757lrNEkt9LcaUiU29+e6Q
AAAEDu3j73XlXgmmJ6DeqA0/0I1EGPhOmMnk/be7rZrpUxDBaM0ggz8RWOz0lq3xs+vNPv
nuWs0SS30txpSJTb357pAAAAGXRlc3Qtc2lnbmluZ0BvcGVuLWluc3BlY3QBAgME
-----END OPENSSH PRIVATE KEY-----"""
PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBaM0ggz8RWOz0lq3xs+vNPvnuWs0SS30txpSJTb357p"
ENABLED_CONFIGURATION = {
    "enabled": True,
    "keyFormat": "ssh-ed25519",
    "githubLogin": "open-inspect-bot",
    "committerName": "Open Inspect",
    "committerEmail": "open-inspect@example.com",
    "publicKey": PUBLIC_KEY,
    "fingerprint": "SHA256:fingerprint",
    "privateKey": PRIVATE_KEY,
}


def git(repo, *args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        check=check,
        capture_output=True,
        text=True,
    )


def create_repository(path):
    path.mkdir()
    git(path, "init")
    return path


def create_manifest(tmp_path, repositories=()):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(
        dump_repo_manifest(
            [
                RepoEntry(owner="acme", name=repository.name, branch="main", path=repository)
                for repository in repositories
            ]
        )
    )
    return manifest


def create_runtime(
    tmp_path,
    manifest,
    *,
    key_path=None,
    log=None,
    control_plane_url="https://control.example.com",
):
    return GitSigningRuntime(
        control_plane_url=control_plane_url,
        session_id="session-1",
        auth_token="sandbox-token",
        repo_manifest_path=manifest,
        key_path=key_path or tmp_path / "runtime" / "id_ed25519",
        log=log,
    )


@pytest.mark.asyncio
async def test_disabled_configuration_removes_signing_state_and_sets_unsigned_identity(tmp_path):
    repo = create_repository(tmp_path / "repo")
    git(repo, "config", "user.signingkey", "/old/key")
    git(repo, "config", "commit.gpgsign", "true")
    manifest = create_manifest(tmp_path, [repo])
    key_path = tmp_path / "runtime" / "id_ed25519"
    key_path.parent.mkdir()
    key_path.write_text("stale-key")
    runtime = create_runtime(tmp_path, manifest, key_path=key_path)

    await runtime.apply_configuration(
        {"enabled": False}, GitUser(name="OpenInspect", email="open-inspect@noreply.github.com")
    )

    assert not key_path.exists()
    assert git(repo, "config", "--get", "user.signingkey", check=False).returncode == 1
    assert git(repo, "config", "--get", "commit.gpgsign", check=False).returncode == 1
    assert git(repo, "config", "user.name").stdout.strip() == "OpenInspect"
    assert git(repo, "config", "user.email").stdout.strip() == "open-inspect@noreply.github.com"


@pytest.mark.asyncio
async def test_enabled_configuration_creates_a_valid_signed_commit_with_split_identity(tmp_path):
    repo = create_repository(tmp_path / "repo")
    allowed_signers = tmp_path / "allowed_signers"
    allowed_signers.write_text(f"open-inspect@example.com {PUBLIC_KEY}\n")
    git(repo, "config", "gpg.ssh.allowedSignersFile", str(allowed_signers))
    manifest = create_manifest(tmp_path, [repo])
    key_path = tmp_path / "runtime" / "id_ed25519"
    runtime = create_runtime(tmp_path, manifest, key_path=key_path)

    await runtime.apply_configuration(
        {
            **ENABLED_CONFIGURATION,
            "fingerprint": "SHA256:Cu64KulDfH7B8Mu37+JWepAJ1m59o159Y8RPj5Ta1XM",
        },
        GitUser(name="Jane Dev", email="123+jane@users.noreply.github.com"),
    )

    assert key_path.stat().st_mode & 0o777 == 0o600
    (repo / "change.txt").write_text("signed\n")
    git(repo, "add", "change.txt")
    git(repo, "commit", "-m", "signed change")
    assert git(repo, "show", "-s", "--format=%an|%ae|%cn|%ce").stdout.strip() == (
        "Jane Dev|123+jane@users.noreply.github.com|Open Inspect|open-inspect@example.com"
    )
    git(repo, "verify-commit", "HEAD")


@pytest.mark.asyncio
async def test_enabled_agent_only_mode_uses_committer_as_author(tmp_path):
    repo = create_repository(tmp_path / "repo")
    manifest = create_manifest(tmp_path, [repo])
    log = MagicMock()
    runtime = create_runtime(tmp_path, manifest, log=log)

    await runtime.apply_configuration(ENABLED_CONFIGURATION, None)

    (repo / "change.txt").write_text("agent-only\n")
    git(repo, "add", "change.txt")
    git(repo, "commit", "-m", "agent-only change")
    assert git(repo, "show", "-s", "--format=%an|%ae|%cn|%ce").stdout.strip() == (
        "Open Inspect|open-inspect@example.com|Open Inspect|open-inspect@example.com"
    )
    log.info.assert_called_once_with(
        "git.signing_apply",
        enabled=True,
        mode="agent-only",
        fingerprint="SHA256:fingerprint",
    )


@pytest.mark.asyncio
async def test_refresh_fetches_the_session_broker_with_sandbox_auth(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    repo = create_repository(tmp_path / "repo")
    manifest = create_manifest(tmp_path, [repo])
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"enabled": False})

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)

    def client_factory(**kwargs):
        return real_client(transport=transport, **kwargs)

    monkeypatch.setattr("sandbox_runtime.git_signing.httpx.AsyncClient", client_factory)
    runtime = create_runtime(tmp_path, manifest, control_plane_url="https://control.example.com/")

    await runtime.refresh(GitUser(name="Jane Dev", email="jane@example.com"))

    assert len(requests) == 1
    assert str(requests[0].url) == "https://control.example.com/sessions/session-1/commit-signing"
    assert requests[0].headers["Authorization"] == "Bearer sandbox-token"
    assert git(repo, "config", "user.name").stdout.strip() == "Jane Dev"


@pytest.mark.asyncio
async def test_enabled_configuration_applies_to_every_manifest_repository(tmp_path):
    repositories = [
        create_repository(tmp_path / "first"),
        create_repository(tmp_path / "second"),
    ]
    manifest = create_manifest(tmp_path, repositories)
    runtime = create_runtime(tmp_path, manifest)

    await runtime.apply_configuration(
        ENABLED_CONFIGURATION, GitUser(name="Jane Dev", email="123+jane@users.noreply.github.com")
    )

    for repository in repositories:
        assert git(repository, "config", "author.name").stdout.strip() == "Jane Dev"
        assert git(repository, "config", "committer.name").stdout.strip() == "Open Inspect"
        assert git(repository, "config", "commit.gpgsign").stdout.strip() == "true"


@pytest.mark.asyncio
async def test_participant_change_updates_only_author_identity(tmp_path):
    repo = create_repository(tmp_path / "repo")
    manifest = create_manifest(tmp_path, [repo])
    key_path = tmp_path / "runtime" / "id_ed25519"
    runtime = create_runtime(tmp_path, manifest, key_path=key_path)
    await runtime.apply_configuration(
        ENABLED_CONFIGURATION, GitUser(name="Jane Dev", email="123+jane@users.noreply.github.com")
    )
    installed_key = key_path.read_text()

    await runtime.apply_configuration(
        ENABLED_CONFIGURATION, GitUser(name="Ada Dev", email="456+ada@users.noreply.github.com")
    )

    assert git(repo, "config", "author.name").stdout.strip() == "Ada Dev"
    assert git(repo, "config", "author.email").stdout.strip() == (
        "456+ada@users.noreply.github.com"
    )
    assert git(repo, "config", "committer.name").stdout.strip() == "Open Inspect"
    assert git(repo, "config", "committer.email").stdout.strip() == ("open-inspect@example.com")
    assert key_path.read_text() == installed_key


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("status", "payload"),
    [
        (503, {"error": "unavailable"}),
        (200, {"enabled": True}),
        (200, ["not", "an", "object"]),
        (
            200,
            {
                "enabled": True,
                "keyFormat": "ssh-ed25519",
                "githubLogin": "",
                "committerName": "",
                "committerEmail": "",
                "publicKey": "",
                "fingerprint": "",
                "privateKey": "",
            },
        ),
    ],
)
async def test_refresh_blocks_on_non_success_or_malformed_broker_results(
    tmp_path, monkeypatch: pytest.MonkeyPatch, status: int, payload
):
    manifest = create_manifest(tmp_path)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=payload)

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        "sandbox_runtime.git_signing.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    runtime = create_runtime(tmp_path, manifest)

    with pytest.raises(RuntimeError, match=r"commit signing configuration|Commit signing"):
        await runtime.refresh(GitUser(name="OpenInspect", email="open-inspect@example.com"))


@pytest.mark.asyncio
async def test_refresh_blocks_when_the_repository_manifest_is_unavailable(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"enabled": False})

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        "sandbox_runtime.git_signing.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    runtime = create_runtime(tmp_path, tmp_path / "missing-manifest.json")

    with pytest.raises(RuntimeError, match="repository manifest"):
        await runtime.refresh(None)


@pytest.mark.asyncio
async def test_initialize_removes_snapshot_restored_key_before_broker_fetch(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    key_path = tmp_path / "runtime" / "id_ed25519"
    key_path.parent.mkdir()
    key_path.write_text("stale-snapshot-key")
    manifest = create_manifest(tmp_path)

    def handler(_request: httpx.Request) -> httpx.Response:
        assert not key_path.exists()
        return httpx.Response(200, json={"enabled": False})

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        "sandbox_runtime.git_signing.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    runtime = create_runtime(tmp_path, manifest, key_path=key_path)

    await runtime.initialize(GitUser(name="OpenInspect", email="open-inspect@example.com"))

    assert not key_path.exists()
