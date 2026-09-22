"""Actual TS sender -> API decoder -> native-call-mocked manager -> runtime readers.

Run with `npm run test:launch-contract`. Standalone Python runs still exercise
v1 validation below; only producer cases require the runner's temporary artifact.
"""

import copy
import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException
from pydantic import TypeAdapter

from sandbox_runtime.code_server import CodeServer
from sandbox_runtime.repo_config import parse_repositories
from sandbox_runtime.runtime_config import BootMode, RuntimeConfig
from sandbox_runtime.web_terminal import WebTerminal
from src import web_api
from src.sandbox.manager import SandboxManager

from .test_web_api_create_sandbox import _call_create_sandbox, _call_restore_sandbox, _patch_auth


def test_published_schema_matches_receiver():
    schema = TypeAdapter(
        web_api.CreateSandboxV1Request | web_api.RestoreSandboxV1Request
    ).json_schema()
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    published = Path(__file__).parents[1] / "contracts" / "launch-v1.schema.json"
    assert json.loads(published.read_text()) == schema


def test_health_advertises_contract_support_without_provider_work(native_calls):
    assert web_api.api_health.get_raw_f()()["data"]["launch_contract_versions"] == ["legacy", 1]
    assert native_calls == []


def _producer_cases():
    artifact = os.environ.get("LAUNCH_CONTRACT_OUTPUT")
    if artifact:
        return json.loads(Path(artifact).read_text())
    return [pytest.param(None, marks=pytest.mark.skip(reason="Run npm run test:launch-contract"))]


@pytest.fixture
def native_calls(monkeypatch):
    captured = []

    async def create(*_args, **kwargs):
        captured.append(kwargs)
        return SimpleNamespace(object_id="provider-contract", stdout=None)

    create.aio = create
    _patch_auth(monkeypatch)
    monkeypatch.setattr("src.sandbox.manager.modal.Sandbox.create", create)
    monkeypatch.setattr("src.sandbox.manager.modal.Image.from_id", lambda image_id: image_id)
    monkeypatch.setattr(
        SandboxManager, "_resolve_and_setup_tunnels", AsyncMock(return_value=(None, None, None, {}))
    )
    monkeypatch.setattr(
        SandboxManager, "_generate_code_server_password", lambda self: "synthetic-code"
    )
    monkeypatch.setattr(SandboxManager, "_generate_vnc_password", lambda self: "syn-vnc1")
    monkeypatch.setattr(web_api, "resolve_clone_token", lambda: "synthetic-legacy-token")
    monkeypatch.delenv("SCM_PROVIDER", raising=False)
    return captured


async def _invoke(case):
    call = _call_create_sandbox if case["operation"] == "create" else _call_restore_sandbox
    return await call(case["body"])


def _assert_semantics(case, native):
    env = native["env"]
    config = RuntimeConfig.from_env(env)
    session = config.session_config
    expected = case["expected"]
    assert config.session_id == "session-contract"
    assert config.sandbox_id == "sandbox-contract"
    assert config.sandbox_token == "synthetic-auth"
    assert config.control_plane_url == "https://control.example.test"
    assert config.harness == expected["harness"]
    assert config.bridge_early_connect is True
    assert session["provider"] == "anthropic"
    assert session["model"] == "contract-model"
    assert config.repo_owner == (expected["repoOwner"] or "")
    assert config.repo_name == (expected["repoName"] or "")
    assert config.base_branch == ("main" if case["shape"] == "none" else "feature/契約")
    assert env["CUSTOM_VALUE"] == 'quotes" and unicode 契約'
    assert native["timeout"] == expected["timeout"]
    assert env["SANDBOX_TIMEOUT_SECONDS"] == str(expected["timeout"])
    mode = (
        BootMode.SNAPSHOT_RESTORE
        if case["operation"] == "restore"
        else (BootMode.REPO_IMAGE if case["shape"] == "scalar" else BootMode.FRESH)
    )
    assert BootMode.from_env(env) == mode
    if case["shape"] in ("multi", "pinned"):
        assert session["repositories"][0]["base_sha"] == "a" * 40
        assert len(session["repositories"]) == (2 if case["shape"] == "multi" else 1)
    else:
        assert not session.get("repositories")
    repositories = parse_repositories(
        session,
        workspace_path=Path("/workspace"),
        scalar_owner=config.repo_owner,
        scalar_name=config.repo_name,
        scalar_branch=config.base_branch,
    )
    assert len(repositories) == {"none": 0, "scalar": 1, "multi": 2, "pinned": 1}[case["shape"]]
    if expected["services"]:
        assert tuple(session["mcp_servers"][0]["command"]) == ("node", "server.js")
        assert env["VNC_PASSWORD"] == "syn-vnc1"
        assert env["CODE_SERVER_PASSWORD"] == "synthetic-code"
        assert env["AGENT_SLACK_NOTIFY_ENABLED"] == "true"
        assert native["encrypted_ports"] == [9000, 9001, 9002, 3000]
    else:
        assert not session.get("mcp_servers")
        assert "VNC_PASSWORD" not in env
        assert "CODE_SERVER_PASSWORD" not in env
        assert "encrypted_ports" not in native
    if case["operation"] == "restore" and case["shape"] != "none":
        assert env["VCS_CLONE_TOKEN"] == "synthetic-legacy-token"
    else:
        assert "VCS_CLONE_TOKEN" not in env


@pytest.mark.parametrize("case", _producer_cases())
async def test_sender_to_runtime(case, native_calls, monkeypatch):
    response = await _invoke(case)
    assert response["success"] is True
    assert len(native_calls) == 1
    native = native_calls[0]
    _assert_semantics(case, native)
    # Exercise direct environment readers too. Stop at the process boundary.
    monkeypatch.setattr(os, "environ", native["env"].copy())
    process = AsyncMock(side_effect=RuntimeError("synthetic-process-boundary"))
    monkeypatch.setattr("asyncio.create_subprocess_exec", process)
    for service in (CodeServer(Mock()), WebTerminal(Mock())):
        process.reset_mock()
        if case["expected"]["services"]:
            with pytest.raises(RuntimeError, match="synthetic-process-boundary"):
                await service.start(Path("/workspace"))
            process.assert_awaited_once()
        else:
            await service.start(Path("/workspace"))
            process.assert_not_awaited()


@pytest.mark.parametrize("case", _producer_cases())
async def test_contract_detects_a_dropped_early_connect_field(case, native_calls):
    broken = copy.deepcopy(case)
    config = broken["body"].get("session_config", broken["body"])
    config.pop("bridge_early_connect")
    if broken["version"] == "1":
        with pytest.raises(HTTPException) as error:
            await _invoke(broken)
        assert error.value.status_code == 400
        assert native_calls == []
    else:
        await _invoke(broken)
        with pytest.raises(AssertionError):
            _assert_semantics(case, native_calls[0])


def _v1(operation="create"):
    common = {
        "contract_version": 1,
        "sandbox_id": "sandbox-contract",
        "control_plane_url": "https://control.example.test",
        "sandbox_auth_token": "synthetic-auth",
        "user_env_vars": {},
        "timeout_seconds": 4321,
        "code_server_enabled": False,
        "vnc_enabled": False,
        "agent_slack_notify_enabled": False,
        "sandbox_settings": {
            "codeServerPort": 8080,
            "vncPort": 6080,
            "terminalPort": 7681,
            "terminalEnabled": False,
            "tunnelPorts": [],
        },
        "session_config": {
            "session_id": "session-contract",
            "repo_owner": None,
            "repo_name": None,
            "harness": "opencode",
            "provider": "anthropic",
            "model": "contract-model",
            "branch": None,
            "mcp_servers": [],
            "repositories": None,
            "bridge_early_connect": True,
        },
    }
    if operation == "create":
        common.update(repo_image_id=None, repo_image_sha=None, agent_session_id=None)
    else:
        common["snapshot_image_id"] = "snapshot-contract"
    return {"operation": operation, "body": common}


@pytest.mark.parametrize("operation", ["create", "restore"])
@pytest.mark.parametrize(
    "invalid",
    ["owner", "name", "sha", "duplicate", "scalar-owner", "scalar-sha", "mismatch", "empty"],
)
async def test_v1_rejects_invalid_repositories_before_launch(operation, invalid, native_calls):
    case = _v1(operation)
    config = case["body"]["session_config"]
    member = {
        "repo_owner": "group/subgroup",
        "repo_name": "repo",
        "branch": "main",
        "base_sha": "a" * 40,
    }
    config.update(
        repo_owner="group/subgroup", repo_name="repo", branch="main", repositories=[member]
    )
    if invalid == "owner":
        member["repo_owner"] = "group/../escape"
    elif invalid == "name":
        member["repo_name"] = "../escape"
    elif invalid == "sha":
        member["base_sha"] = "abc123"
    elif invalid == "duplicate":
        config["repositories"].append({**member, "repo_name": "REPO"})
    elif invalid == "scalar-owner":
        config["repo_owner"] = "../escape"
    elif invalid == "scalar-sha":
        config["base_sha"] = "abc123"
    elif invalid == "mismatch":
        config["repo_name"] = "another"
    else:
        member["repo_name"] = "   "
    with pytest.raises(HTTPException) as error:
        await _invoke(case)
    assert error.value.status_code == 400
    assert native_calls == []


@pytest.mark.parametrize("operation", ["create", "restore"])
async def test_v1_repository_extensions_and_nested_owner_reach_runtime(operation, native_calls):
    case = _v1(operation)
    member = {
        "repo_owner": "group/subgroup",
        "repo_name": "repo",
        "branch": "feature/契約",
        "base_sha": "a" * 40,
        "future": {"enabled": True},
    }
    case["body"]["session_config"].update(
        repo_owner="group/subgroup", repo_name="repo", branch="feature/契約", repositories=[member]
    )
    await _invoke(case)
    env = native_calls[0]["env"]
    assert env["REPO_OWNER"] == "group/subgroup"
    assert json.loads(env["SESSION_CONFIG"])["repositories"] == [member]


@pytest.mark.parametrize("operation", ["create", "restore"])
@pytest.mark.parametrize("version", [0, 2, "1", None, True])
async def test_unknown_version_rejected_before_side_effects(operation, version, native_calls):
    case = _v1(operation)
    case["body"]["contract_version"] = version
    with pytest.raises(HTTPException) as error:
        await _invoke(case)
    assert error.value.status_code == 400
    assert native_calls == []


@pytest.mark.parametrize("operation", ["create", "restore"])
async def test_v1_preserves_extensions_without_overriding_execution(operation, native_calls):
    case = _v1(operation)
    case["body"]["session_config"].update(
        future_option={"value": True}, sandbox_auth_token="untrusted"
    )
    await _invoke(case)
    env = native_calls[0]["env"]
    assert env["SANDBOX_AUTH_TOKEN"] == "synthetic-auth"
    assert json.loads(env["SESSION_CONFIG"])["future_option"] == {"value": True}


@pytest.mark.parametrize("operation", ["create", "restore"])
@pytest.mark.parametrize(
    "field,value",
    [("command", "node server.js"), ("env", {"TOKEN": 123}), ("headers", []), ("enabled", "false")],
)
async def test_v1_rejects_malformed_mcp_before_native_creation(
    operation, field, value, native_calls
):
    case = _v1(operation)
    server = {"name": "contract", "type": "local", "command": ["node", "server.js"]}
    server[field] = value
    case["body"]["session_config"]["mcp_servers"] = [server]
    with pytest.raises(HTTPException) as error:
        await _invoke(case)
    assert error.value.status_code == 400
    assert native_calls == []


@pytest.mark.parametrize("operation", ["create", "restore"])
async def test_v1_preserves_mcp_extensions(operation, native_calls):
    case = _v1(operation)
    server = {
        "name": "contract",
        "type": "local",
        "command": ["node", "server.js"],
        "env": {"TOKEN": "synthetic"},
        "enabled": True,
        "future_option": {"value": True},
    }
    case["body"]["session_config"]["mcp_servers"] = [server]
    await _invoke(case)
    assert json.loads(native_calls[0]["env"]["SESSION_CONFIG"])["mcp_servers"] == [server]


@pytest.mark.parametrize("operation", ["create", "restore"])
@pytest.mark.parametrize("invalid", [False, True])
async def test_v1_logs_version_with_correlated_outcome(
    operation, invalid, native_calls, monkeypatch
):
    case = _v1(operation)
    info = Mock()
    monkeypatch.setattr(web_api.log, "info", info)
    if invalid:
        case["body"]["timeout_seconds"] = "invalid"
    call = _call_create_sandbox if operation == "create" else _call_restore_sandbox
    headers = {
        "x_trace_id": "trace-contract",
        "x_request_id": "request-contract",
        "x_session_id": "session-contract",
        "x_sandbox_id": "sandbox-contract",
    }
    if invalid:
        with pytest.raises(HTTPException):
            await call(case["body"], **headers)
        assert native_calls == []
    else:
        await call(case["body"], **headers)
    info.assert_called_once()
    assert info.call_args.args == ("modal.http_request",)
    fields = info.call_args.kwargs
    assert fields["launch_contract_version"] == 1
    assert fields["outcome"] == ("error" if invalid else "success")
    assert fields["http_status"] == (400 if invalid else 200)
    for key, value in headers.items():
        assert fields[key.removeprefix("x_")] == value


@pytest.mark.parametrize("operation", ["create", "restore"])
@pytest.mark.parametrize("field", ["timeout_seconds", "sandbox_settings", "user_env_vars"])
async def test_v1_requires_resolved_fields(operation, field, native_calls):
    case = _v1(operation)
    del case["body"][field]
    with pytest.raises(HTTPException) as error:
        await _invoke(case)
    assert error.value.status_code == 400
    assert native_calls == []


@pytest.mark.parametrize("operation", ["create", "restore"])
@pytest.mark.parametrize(
    "field,value",
    [("timeout_seconds", "4321"), ("vnc_enabled", "false"), ("sandbox_auth_token", None)],
)
async def test_v1_rejects_invalid_known_values_without_echoing_secrets(
    operation, field, value, native_calls
):
    case = _v1(operation)
    case["body"][field] = value
    case["body"]["user_env_vars"] = {"SYNTHETIC_SECRET": "must-not-appear"}
    with pytest.raises(HTTPException) as error:
        await _invoke(case)
    assert error.value.status_code == 400
    assert "must-not-appear" not in str(error.value.detail)
    assert native_calls == []
