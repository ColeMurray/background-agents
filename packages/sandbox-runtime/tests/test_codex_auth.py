import asyncio
import tomllib
from unittest.mock import AsyncMock, MagicMock

import pytest

from sandbox_runtime.credentials.openai_access_token_client import OpenAIAccessToken
from sandbox_runtime.harness.base import HarnessStartError, PromptLimits
from sandbox_runtime.harness.codex import CodexHarness, CodexHarnessConfig
from sandbox_runtime.harness.codex.env import clean_codex_env, launch_arguments, mcp_configuration


def token(version=1, account="workspace"):
    return OpenAIAccessToken(f"access-{version}", account, version, 9_999_999_999_999)


def harness(tmp_path, managed=True):
    broker = MagicMock()
    broker.fetch = AsyncMock(return_value=token())
    h = CodexHarness(
        config=CodexHarnessConfig(tmp_path, tmp_path / "state", "gpt-6.1-sol", managed),
        log=MagicMock(),
        limits=PromptLimits(1, 30, 5),
        credential_client=broker,
        environ={"OPENAI_API_KEY": "api-secret", "CODEX_API_KEY": "competing-key"},
    )
    h._client = MagicMock()
    h._client.request = AsyncMock(
        return_value={
            "account": {"type": "chatgpt" if managed else "apiKey"},
            "workspaceRouting": {"chatgptAccountId": "workspace"},
        }
    )
    return h, broker


@pytest.mark.asyncio
async def test_authenticate_does_not_hold_callback_lock_during_native_rpc(tmp_path):
    h, broker = harness(tmp_path)
    broker.fetch.side_effect = [token(), token(2)]

    async def request(method, params):
        if method == "account/login/start":
            reply = await h._server_request(
                "account/chatgptAuthTokens/refresh",
                {"reason": "unauthorized", "previousAccountId": "workspace"},
            )
            assert reply == {"accessToken": "access-2", "chatgptAccountId": "workspace"}
            return {}
        return {
            "account": {"type": "chatgpt"},
            "workspaceRouting": {"chatgptAccountId": "workspace"},
        }

    h._client.request = request
    await asyncio.wait_for(h._authenticate(), 0.2)


@pytest.mark.parametrize(
    "response",
    [
        {},
        {"account": None},
        {"account": {"type": "apiKey"}},
        {"account": {"type": "chatgpt"}, "workspaceRouting": None},
        {"account": {"type": "chatgpt"}, "workspaceRouting": "invalid"},
        {"account": {"type": "chatgpt"}, "workspaceRouting": {"chatgptAccountId": "other"}},
    ],
)
@pytest.mark.asyncio
async def test_authenticate_requires_native_mode_and_exact_workspace(tmp_path, response):
    h, _ = harness(tmp_path)
    h._client.request.return_value = response
    with pytest.raises(HarnessStartError):
        await h._authenticate()


@pytest.mark.asyncio
async def test_api_mode_uses_only_canonical_selected_api_key(tmp_path):
    h, broker = harness(tmp_path, managed=False)
    await h._authenticate()
    assert h._client.request.call_args_list[0].args == (
        "account/login/start",
        {"type": "apiKey", "apiKey": "api-secret"},
    )
    broker.fetch.assert_not_called()


@pytest.mark.parametrize(
    "params",
    [
        {"reason": "unauthorized", "previousAccountId": "other"},
        {"reason": "unauthorized"},
        {"reason": "unknown", "previousAccountId": "workspace"},
        {"previousAccountId": "workspace"},
    ],
)
@pytest.mark.asyncio
async def test_callback_rejects_unowned_identity_or_reason_without_broker_call(tmp_path, params):
    h, broker = harness(tmp_path)
    h._token = token()
    with pytest.raises(RuntimeError):
        await h._server_request("account/chatgptAuthTokens/refresh", params)
    broker.fetch.assert_not_called()


@pytest.mark.asyncio
async def test_overlapping_callbacks_report_the_same_rejected_version(tmp_path):
    h, broker = harness(tmp_path)
    h._token = token()
    entered, release = asyncio.Event(), asyncio.Event()

    async def fetch(**kwargs):
        entered.set()
        await release.wait()
        return token(2)

    broker.fetch.side_effect = fetch
    params = {"reason": "unauthorized", "previousAccountId": "workspace"}
    first = asyncio.create_task(h._server_request("account/chatgptAuthTokens/refresh", params))
    await entered.wait()
    second = asyncio.create_task(h._server_request("account/chatgptAuthTokens/refresh", params))
    await asyncio.sleep(0)
    release.set()
    assert await first == await second
    assert [call.kwargs["rejected_credential_version"] for call in broker.fetch.call_args_list] == [
        1,
        1,
    ]
    assert all(0 < call.kwargs["timeout_seconds"] < 8 for call in broker.fetch.call_args_list)


@pytest.mark.asyncio
async def test_callback_rejects_workspace_switch_and_keeps_old_binding(tmp_path):
    h, broker = harness(tmp_path)
    h._token = token()
    broker.fetch.return_value = token(2, "other")
    with pytest.raises(RuntimeError):
        await h._server_request(
            "account/chatgptAuthTokens/refresh",
            {"reason": "unauthorized", "previousAccountId": "workspace"},
        )
    assert h._token.account_id == "workspace"


def test_native_env_strips_all_competing_keys_and_telemetry_authority(tmp_path):
    env = clean_codex_env(
        {
            "OPENAI_API_KEY": "secret",
            "OPENAI_ORG_ID": "other",
            "CODEX_API_KEY": "secret",
            "CODEX_HOME": "/attacker",
            "CODEX_ACCESS_TOKEN": "secret",
            "OTEL_EXPORTER_OTLP_ENDPOINT": "https://attacker",
            "USER_BUILD_VAR": "retained",
        },
        tmp_path,
    )
    assert env["CODEX_HOME"] == str(tmp_path)
    assert env["USER_BUILD_VAR"] == "retained"
    assert not any(
        key in env
        for key in (
            "OPENAI_API_KEY",
            "OPENAI_ORG_ID",
            "CODEX_API_KEY",
            "CODEX_ACCESS_TOKEN",
            "OTEL_EXPORTER_OTLP_ENDPOINT",
        )
    )


def test_native_launch_preserves_auth_dependent_first_party_routing(tmp_path):
    arguments = launch_arguments(tmp_path)
    config = tomllib.loads("\n".join(arguments[1::2]))
    assert config["model_provider"] == "openai"
    assert config["model_providers"] == {}
    # An explicit API base overrides Codex's auth-sensitive default and also
    # disables ChatGPT workspace routing. The native integration fixture must
    # separately prove both auth modes using this built-in provider.
    assert not config.get("openai_base_url")
    assert config["chatgpt_base_url"] == "https://chatgpt.com/backend-api"
    assert config["features"]["api_key_model_discovery"] is False
    assert config["features"]["shell_snapshot"] is False
    assert config["features"]["shell_snapshot_v2"] is False


def test_mcp_environment_is_scoped_to_server_not_native_auth(tmp_path):
    config = mcp_configuration(
        ({"name": "fixture", "command": ["fixture"], "env": {"CODEX_API_KEY": "secret"}},)
    )
    assert config["fixture"]["env"] == {"CODEX_API_KEY": "secret"}
    assert "CODEX_API_KEY" not in clean_codex_env({}, tmp_path)


@pytest.mark.asyncio
async def test_late_refresh_cannot_update_a_replacement_process(tmp_path):
    h, broker = harness(tmp_path)
    h._token = token()

    async def fetch(**_kwargs):
        h._epoch = "replacement"
        return token(2)

    broker.fetch.side_effect = fetch
    with pytest.raises(RuntimeError):
        await h._server_request(
            "account/chatgptAuthTokens/refresh",
            {
                "reason": "unauthorized",
                "previousAccountId": "workspace",
            },
        )
    assert h._token.credential_version == 1


@pytest.mark.asyncio
async def test_late_login_fetch_never_targets_a_replacement_process(tmp_path):
    h, broker = harness(tmp_path)
    native = h._client

    async def fetch(**_kwargs):
        h._epoch = "replacement"
        return token(2)

    broker.fetch.side_effect = fetch
    with pytest.raises(HarnessStartError):
        await h._authenticate()
    native.request.assert_not_called()


@pytest.mark.asyncio
async def test_managed_denial_never_uses_ambient_api_key(tmp_path):
    from sandbox_runtime.credentials.openai_access_token_client import OpenAIAccessTokenDenied

    h, broker = harness(tmp_path)
    broker.fetch.side_effect = OpenAIAccessTokenDenied("denied")
    with pytest.raises(OpenAIAccessTokenDenied):
        await h._authenticate()
    h._client.request.assert_not_called()
