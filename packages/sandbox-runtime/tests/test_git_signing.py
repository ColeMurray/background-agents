import subprocess
import textwrap
from unittest.mock import AsyncMock, MagicMock

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
    "committerName": "Open Inspect",
    "committerEmail": "open-inspect@example.com",
    "publicKey": PUBLIC_KEY,
    "fingerprint": "SHA256:fingerprint",
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


def create_remote_signer(tmp_path):
    private_key = tmp_path / "remote-signing-key"
    private_key.write_text(f"{PRIVATE_KEY}\n")
    private_key.chmod(0o600)
    signer = tmp_path / "oi-git-sign"
    signer.write_text(
        textwrap.dedent(
            f"""\
            #!/usr/bin/env python3
            import os
            import subprocess
            import sys

            arguments = sys.argv[1:]
            if arguments[:2] != ["-Y", "sign"]:
                os.execv("/usr/bin/ssh-keygen", ["/usr/bin/ssh-keygen", *arguments])
            subprocess.run(
                [
                    "/usr/bin/ssh-keygen",
                    "-Y",
                    "sign",
                    "-n",
                    "git",
                    "-f",
                    {str(private_key)!r},
                    arguments[-1],
                ],
                check=True,
            )
            """
        )
    )
    signer.chmod(0o755)
    return signer


def create_runtime(
    tmp_path,
    manifest,
    *,
    signer_path=None,
    log=None,
    control_plane_url="https://control.example.com",
):
    return GitSigningRuntime(
        control_plane_url=control_plane_url,
        session_id="session-1",
        auth_token="sandbox-token",
        repo_manifest_path=manifest,
        signer_path=signer_path or tmp_path / "oi-git-sign",
        log=log,
    )


@pytest.mark.asyncio
async def test_disabled_configuration_removes_signing_state_and_sets_unsigned_identity(tmp_path):
    repo = create_repository(tmp_path / "repo")
    git(repo, "config", "user.signingkey", "/old/key")
    git(repo, "config", "gpg.ssh.program", "/old/signer")
    git(repo, "config", "commit.gpgsign", "true")
    manifest = create_manifest(tmp_path, [repo])
    runtime = create_runtime(tmp_path, manifest)

    await runtime.apply_configuration(
        {"enabled": False}, GitUser(name="OpenInspect", email="open-inspect@noreply.github.com")
    )

    assert git(repo, "config", "--get", "user.signingkey", check=False).returncode == 1
    assert git(repo, "config", "--get", "gpg.ssh.program", check=False).returncode == 1
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
    signer_path = create_remote_signer(tmp_path)
    runtime = create_runtime(tmp_path, manifest, signer_path=signer_path)

    await runtime.apply_configuration(
        {
            **ENABLED_CONFIGURATION,
            "fingerprint": "SHA256:Cu64KulDfH7B8Mu37+JWepAJ1m59o159Y8RPj5Ta1XM",
        },
        GitUser(name="Jane Dev", email="123+jane@users.noreply.github.com"),
    )

    assert git(repo, "config", "gpg.ssh.program").stdout.strip() == str(signer_path)
    assert git(repo, "config", "user.signingkey").stdout.strip() == f"key::{PUBLIC_KEY}"
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
    runtime = create_runtime(
        tmp_path,
        manifest,
        signer_path=create_remote_signer(tmp_path),
        log=log,
    )

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
async def test_recreated_and_synthesized_commits_remain_signed(tmp_path):
    repo = create_repository(tmp_path / "repo")
    main_branch = git(repo, "branch", "--show-current").stdout.strip()
    allowed_signers = tmp_path / "allowed_signers"
    allowed_signers.write_text(f"open-inspect@example.com {PUBLIC_KEY}\n")
    git(repo, "config", "gpg.ssh.allowedSignersFile", str(allowed_signers))
    manifest = create_manifest(tmp_path, [repo])
    runtime = create_runtime(
        tmp_path,
        manifest,
        signer_path=create_remote_signer(tmp_path),
    )
    await runtime.apply_configuration(
        ENABLED_CONFIGURATION,
        GitUser(name="Jane Dev", email="123+jane@users.noreply.github.com"),
    )

    def commit_file(filename: str, message: str) -> str:
        (repo / filename).write_text(f"{message}\n")
        git(repo, "add", filename)
        git(repo, "commit", "-m", message)
        return git(repo, "rev-parse", "HEAD").stdout.strip()

    commits: list[str] = [commit_file("normal.txt", "normal")]
    (repo / "normal.txt").write_text("amended\n")
    git(repo, "add", "normal.txt")
    git(repo, "commit", "--amend", "--no-edit")
    commits.append(git(repo, "rev-parse", "HEAD").stdout.strip())

    git(repo, "switch", "-c", "feature")
    commits.append(commit_file("feature.txt", "feature"))
    git(repo, "switch", main_branch)
    commits.append(commit_file("main.txt", "main update"))
    git(repo, "merge", "--no-ff", "feature", "-m", "merge feature")
    commits.append(git(repo, "rev-parse", "HEAD").stdout.strip())

    git(repo, "switch", "-c", "cherry-source")
    cherry_source = commit_file("cherry.txt", "cherry source")
    git(repo, "switch", main_branch)
    git(repo, "cherry-pick", cherry_source)
    commits.append(git(repo, "rev-parse", "HEAD").stdout.strip())

    git(repo, "switch", "-c", "rebase-source")
    commit_file("rebase.txt", "rebase source")
    git(repo, "switch", main_branch)
    commits.append(commit_file("base.txt", "rebase base"))
    git(repo, "switch", "rebase-source")
    git(repo, "rebase", main_branch)
    commits.append(git(repo, "rev-parse", "HEAD").stdout.strip())

    for commit in commits:
        git(repo, "verify-commit", commit)
        assert git(repo, "show", "-s", "--format=%an|%cn", commit).stdout.strip() == (
            "Jane Dev|Open Inspect"
        )


@pytest.mark.asyncio
async def test_signer_failure_leaves_work_staged_and_uncommitted(tmp_path):
    repo = create_repository(tmp_path / "repo")
    manifest = create_manifest(tmp_path, [repo])
    unavailable_signer = tmp_path / "oi-git-sign"
    unavailable_signer.write_text("#!/bin/sh\nexit 1\n")
    unavailable_signer.chmod(0o755)
    runtime = create_runtime(tmp_path, manifest, signer_path=unavailable_signer)
    await runtime.apply_configuration(ENABLED_CONFIGURATION, None)
    (repo / "change.txt").write_text("uncommitted\n")
    git(repo, "add", "change.txt")

    result = git(repo, "commit", "-m", "must fail", check=False)

    assert result.returncode != 0
    assert git(repo, "rev-parse", "--verify", "HEAD", check=False).returncode != 0
    assert git(repo, "diff", "--cached", "--name-only").stdout.strip() == "change.txt"


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
async def test_participant_change_updates_only_author_identity(tmp_path, monkeypatch):
    repo = create_repository(tmp_path / "repo")
    manifest = create_manifest(tmp_path, [repo])
    runtime = create_runtime(tmp_path, manifest)
    await runtime.apply_configuration(
        ENABLED_CONFIGURATION, GitUser(name="Jane Dev", email="123+jane@users.noreply.github.com")
    )
    set_git_config = AsyncMock(side_effect=runtime._set_git_config)
    monkeypatch.setattr(runtime, "_set_git_config", set_git_config)

    await runtime.apply_configuration(
        ENABLED_CONFIGURATION, GitUser(name="Ada Dev", email="456+ada@users.noreply.github.com")
    )

    assert [call.args[1] for call in set_git_config.await_args_list] == [
        "author.name",
        "author.email",
        "user.name",
        "user.email",
    ]
    assert git(repo, "config", "author.name").stdout.strip() == "Ada Dev"
    assert git(repo, "config", "author.email").stdout.strip() == (
        "456+ada@users.noreply.github.com"
    )
    assert git(repo, "config", "committer.name").stdout.strip() == "Open Inspect"
    assert git(repo, "config", "committer.email").stdout.strip() == ("open-inspect@example.com")


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
                "committerName": "Open Inspect",
                "committerEmail": "open-inspect@example.com",
                "publicKey": PUBLIC_KEY,
                "fingerprint": "SHA256:fingerprint",
                "privateKey": PRIVATE_KEY,
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
async def test_initialize_fetches_public_configuration_without_creating_key_files(
    tmp_path, monkeypatch: pytest.MonkeyPatch
):
    manifest = create_manifest(tmp_path)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=ENABLED_CONFIGURATION)

    real_client = httpx.AsyncClient
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        "sandbox_runtime.git_signing.httpx.AsyncClient",
        lambda **kwargs: real_client(transport=transport, **kwargs),
    )
    runtime = create_runtime(tmp_path, manifest)

    await runtime.initialize(GitUser(name="OpenInspect", email="open-inspect@example.com"))

    assert not (tmp_path / "runtime").exists()
