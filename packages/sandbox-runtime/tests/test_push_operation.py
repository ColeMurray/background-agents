"""Local push execution coverage without WebSocket or bridge dependencies."""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.push_operation import PushOperation, PushRequest


@pytest.fixture
def operation(tmp_path: Path) -> PushOperation:
    (tmp_path / "repo" / ".git").mkdir(parents=True)
    return PushOperation(
        repo_path=tmp_path, manifest_path=tmp_path / "manifest.json", logger=MagicMock()
    )


def _write_manifest(operation: PushOperation, members: list[tuple[str, str]]) -> None:
    operation.manifest_path.write_text(
        json.dumps(
            {
                "repositories": [
                    {
                        "owner": owner,
                        "name": name,
                        "branch": "main",
                        "path": str(operation.repo_path / name),
                    }
                    for owner, name in members
                ]
            }
        )
    )


def _push_spec(**fields) -> dict:
    return {
        "targetBranch": "feature/test",
        "refspec": "HEAD:refs/heads/feature/test",
        "remoteUrl": "https://token@github.com/open-inspect/repo.git",
        "redactedRemoteUrl": "https://***@github.com/open-inspect/repo.git",
        "force": False,
        **fields,
    }


def _fake_process(returncode=0, stderr=b""):
    process = MagicMock()
    process.returncode = returncode
    process.communicate = AsyncMock(return_value=(b"", stderr))
    process.wait = AsyncMock()
    return process


async def test_success_uses_legacy_checkout(operation):
    process = _fake_process()
    spec = _push_spec()
    with patch(
        "sandbox_runtime.push_operation.asyncio.create_subprocess_exec", return_value=process
    ) as launch:
        result = await operation.execute(spec)
    assert result.error is None
    assert result.request == PushRequest.from_push_spec(spec)
    assert result.request.repo_fields() == {}
    launch.assert_awaited_once_with(
        "git",
        "push",
        spec["remoteUrl"],
        spec["refspec"],
        cwd=operation.repo_path / "repo",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    process.terminate.assert_not_called()
    process.kill.assert_not_called()


@pytest.mark.parametrize(
    "stderr,expected",
    [
        (
            b"fatal: Authentication failed for 'https://token@github.com/open-inspect/repo.git'",
            "Push failed: fatal: Authentication failed for 'https://***@github.com/open-inspect/repo.git'",
        ),
        (b"", "Push failed - unknown error"),
        (b" \n ", "Push failed - unknown error"),
        (
            b"\xff https://user:secret@other.example/repo http://secret@host/repo\n",
            "Push failed: \ufffd https://***@other.example/repo http://***@host/repo",
        ),
    ],
)
async def test_nonzero_exit_redacts_stderr(operation, stderr, expected):
    process = _fake_process(1, stderr)
    with patch(
        "sandbox_runtime.push_operation.asyncio.create_subprocess_exec", return_value=process
    ):
        result = await operation.execute(_push_spec())
    assert result.error == expected
    assert result.request.branch_name == "feature/test"
    operation.log.warn.assert_called_once_with(
        "git.push_failed",
        branch_name="feature/test",
        stderr=expected.removeprefix("Push failed: ")
        if expected != "Push failed - unknown error"
        else "",
    )
    process.terminate.assert_not_called()
    process.kill.assert_not_called()


@pytest.mark.parametrize("escalate", [False, True])
@pytest.mark.parametrize("already_exited", [False, True])
async def test_timeout_terminates_then_kills_if_needed(operation, escalate, already_exited):
    process = _fake_process(None)
    if already_exited:
        process.terminate.side_effect = ProcessLookupError
        process.kill.side_effect = ProcessLookupError
    timeouts = []

    async def wait_for(coro, timeout):
        timeouts.append(timeout)
        if len(timeouts) == 1 or escalate:
            coro.close()
            raise TimeoutError
        return await coro

    with (
        patch(
            "sandbox_runtime.push_operation.asyncio.create_subprocess_exec", return_value=process
        ),
        patch("sandbox_runtime.push_operation.asyncio.wait_for", side_effect=wait_for),
        patch("sandbox_runtime.push_operation.GIT_PUSH_TIMEOUT_SECONDS", 42.0),
        patch("sandbox_runtime.push_operation.GIT_PUSH_TERMINATE_GRACE_SECONDS", 3.0),
    ):
        result = await operation.execute(_push_spec())
    assert timeouts == [42.0, 3.0]
    assert result.error == "Push failed - git push timed out after 42s"
    assert result.request.branch_name == "feature/test"
    process.terminate.assert_called_once_with()
    if escalate:
        process.kill.assert_called_once_with()
        assert process.wait.call_count == 2
    else:
        process.kill.assert_not_called()
    process.wait.assert_awaited_once()


@pytest.mark.parametrize("owner,name", [("open-inspect", "backend"), ("Open-Inspect", "Backend")])
async def test_targets_manifest_member_case_insensitively(operation, owner, name):
    _write_manifest(operation, [("open-inspect", "frontend"), ("open-inspect", "backend")])
    (operation.repo_path / "backend" / ".git").mkdir(parents=True)
    with patch(
        "sandbox_runtime.push_operation.asyncio.create_subprocess_exec",
        return_value=_fake_process(),
    ) as launch:
        result = await operation.execute(_push_spec(repoOwner=owner, repoName=name))
    assert result.error is None
    assert launch.call_args.kwargs["cwd"] == operation.repo_path / "backend"
    assert result.request.repo_fields() == {"repoOwner": owner, "repoName": name}


@pytest.mark.parametrize("name", ["missing", "../outside"])
async def test_non_member_rejected_without_pushing(operation, name):
    _write_manifest(operation, [("open-inspect", "backend")])
    (operation.repo_path / "outside" / ".git").mkdir(parents=True)
    with patch("sandbox_runtime.push_operation.asyncio.create_subprocess_exec") as launch:
        result = await operation.execute(_push_spec(repoOwner="open-inspect", repoName=name))
    launch.assert_not_called()
    assert result.error == f"Repository open-inspect/{name} is not part of this session"
    assert result.request.repo_name == name


async def test_member_without_checkout(operation):
    _write_manifest(operation, [("open-inspect", "backend")])
    with patch("sandbox_runtime.push_operation.asyncio.create_subprocess_exec") as launch:
        result = await operation.execute(_push_spec(repoOwner="open-inspect", repoName="backend"))
    launch.assert_not_called()
    assert result.error == "Repository open-inspect/backend not found in workspace"
    assert result.request.repo_name == "backend"


async def test_no_repository(tmp_path):
    operation = PushOperation(
        repo_path=tmp_path, manifest_path=tmp_path / "absent", logger=MagicMock()
    )
    with patch("sandbox_runtime.push_operation.asyncio.create_subprocess_exec") as launch:
        result = await operation.execute(_push_spec())
    launch.assert_not_called()
    assert result.error == "No repository found"
    assert result.request.branch_name == "feature/test"


async def test_identity_free_fallback_ignores_manifest_and_sorts_clones(operation):
    _write_manifest(operation, [("open-inspect", "repo")])
    (operation.repo_path / "aaa" / ".git").mkdir(parents=True)
    with patch(
        "sandbox_runtime.push_operation.asyncio.create_subprocess_exec",
        return_value=_fake_process(),
    ) as launch:
        result = await operation.execute(_push_spec())
    assert result.error is None
    assert launch.call_args.kwargs["cwd"] == operation.repo_path / "aaa"


@pytest.mark.parametrize("force", [False, True])
async def test_provider_url_refspec_and_force_pass_through(operation, force):
    _write_manifest(operation, [("group/subgroup", "repo")])
    spec = _push_spec(
        repoOwner="group/subgroup",
        repoName="repo",
        force=force,
        remoteUrl="https://oauth2:token@gitlab.example/group/subgroup/repo.git",
        redactedRemoteUrl="https://***@gitlab.example/group/subgroup/repo.git",
        refspec="local-branch:refs/heads/provider-target",
    )
    with patch(
        "sandbox_runtime.push_operation.asyncio.create_subprocess_exec",
        return_value=_fake_process(),
    ) as launch:
        result = await operation.execute(spec)
    assert result.error is None
    launch.assert_awaited_once_with(
        "git",
        "push",
        spec["remoteUrl"],
        spec["refspec"],
        *(["-f"] if force else []),
        cwd=operation.repo_path / "repo",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )


@pytest.mark.parametrize("spec", [None, False, 42, "invalid", [], ["invalid"]])
async def test_invalid_spec(operation, spec):
    with patch("sandbox_runtime.push_operation.asyncio.create_subprocess_exec") as launch:
        result = await operation.execute(spec)
    launch.assert_not_called()
    assert result.error == "Push failed - missing push specification"
    assert result.request.branch_name == ""


@pytest.mark.parametrize(
    "spec,error",
    [
        ({}, "missing target branch"),
        (_push_spec(targetBranch="  "), "missing target branch"),
        (_push_spec(refspec=""), "invalid push specification"),
        (_push_spec(remoteUrl="  "), "invalid push specification"),
        (_push_spec(repoOwner="owner"), "pushSpec must carry both repoOwner and repoName"),
        (_push_spec(repoName="repo"), "pushSpec must carry both repoOwner and repoName"),
    ],
)
async def test_invalid_fields(operation, spec, error):
    with patch("sandbox_runtime.push_operation.asyncio.create_subprocess_exec") as launch:
        result = await operation.execute(spec)
    launch.assert_not_called()
    assert result.error == f"Push failed - {error}"
    assert result.request == PushRequest.from_push_spec(spec)


def test_normalization_preserves_existing_string_and_bool_coercion():
    request = PushRequest.from_push_spec(
        _push_spec(targetBranch=123, refspec=None, force="false", repoOwner=" owner ")
    )
    assert request.branch_name == "123"
    assert request.refspec == "None"
    assert request.force is True
    assert request.repo_owner == "owner"


@pytest.mark.parametrize(
    "error", [OSError("git unavailable"), RuntimeError("launch failed"), RuntimeError("")]
)
async def test_launch_exception_becomes_result(operation, error):
    with patch("sandbox_runtime.push_operation.asyncio.create_subprocess_exec", side_effect=error):
        result = await operation.execute(_push_spec())
    assert result.error == str(error)
    assert result.request.branch_name == "feature/test"
    operation.log.error.assert_called_once_with(
        "git.push_error", exc=error, branch_name="feature/test"
    )
