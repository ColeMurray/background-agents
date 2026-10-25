"""Native Codex harness. The bridge alone owns platform turn settlement."""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import os
import sys
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from ...credentials.openai_access_token_client import (
    OPENAI_ACCESS_TOKEN_TIMEOUT_SECONDS,
    OpenAIAccessTokenClient,
    OpenAIAccessTokenDenied,
    OpenAIAccessTokenUnavailable,
)
from ...memories import memory_text
from ..base import (
    EventSink,
    HarnessId,
    HarnessPrompt,
    HarnessStartError,
    PromptLimits,
    TurnOutcome,
)
from ..tools import ControlPlaneToolClient, ToolServerConfig
from .client import CodexClient, CodexRpcError, CodexTransportError
from .env import (
    CODEX_BINARY,
    CODEX_VERSION,
    clean_codex_env,
    launch_arguments,
    mcp_configuration,
    validate_native_configuration,
    validate_native_state,
)
from .events import TURN_FAILED_MESSAGE, CodexRateLimits, CodexTurnEvents
from .tools import CodexTools

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping

    from ...model_prices import ModelPriceCatalog

STATE_VERSION = 1
STOP_TIMEOUT_SECONDS = 5.0


def _observed_cost(state: CodexTurnEvents | None) -> float:
    """Cost of the requests a turn reported before it ended, however it ended."""
    return state.message_cost_usd if state is not None else 0


class _InactivityTimeout(Exception):
    """The app-server sent nothing within the inactivity budget."""


@dataclass(frozen=True)
class CodexHarnessConfig:
    workdir: Path
    state_dir: Path
    default_model: str
    oauth_managed: bool
    mcp_servers: tuple[Mapping[str, Any], ...] = ()
    tools: ToolServerConfig | None = None
    restored: bool = False


class CodexHarness:
    id = HarnessId.CODEX

    def __init__(
        self,
        *,
        config: CodexHarnessConfig,
        log: Any,
        limits: PromptLimits,
        credential_client: OpenAIAccessTokenClient | None = None,
        client_factory: Callable[..., CodexClient] = CodexClient,
        environ: Mapping[str, str] | None = None,
        prices: ModelPriceCatalog | None = None,
    ) -> None:
        self.config, self.log, self.limits = config, log, limits
        self._prices = prices
        self._credentials = credential_client
        self._factory = client_factory
        self._environ = dict(os.environ if environ is None else environ)
        self._client: CodexClient | None = None
        self._token: Any = None
        self._lock = asyncio.Lock()
        self._auth_lock = asyncio.Lock()
        # One native turn at a time: turn identity, the submission flag and the
        # notification stream are per-harness, and failure cleanup stops the process.
        self._turn_lock = asyncio.Lock()
        self._stopping = False
        self._revocation_stop: asyncio.Task[bool] | None = None
        self.session_id: str | None = None
        # Set when open() rejected an existing manifest. A rejected compatibility
        # record must not read as an absent one that permits unchecked adoption.
        self._turn_id: str | None = None
        self._submitting = False
        self._turn_known = asyncio.Event()
        self._epoch = ""
        self._total: dict[str, int] = {}
        self._usage_baseline_known = True
        # Account quota state outlives a turn; each turn projects into it.
        self._rate_limits = CodexRateLimits()
        self._manifest_path = config.state_dir / "openinspect-state.json"
        # A rejected manifest is kept here, not deleted, until a fresh thread
        # replaces it: a rejected record must never read as an absent one, even
        # after a restart.
        self._rejected_manifest_path = config.state_dir / "openinspect-state.rejected.json"
        self._tool_client = ControlPlaneToolClient(config.tools, log) if config.tools else None
        self._tools = CodexTools(self._tool_client) if self._tool_client else None
        self._mcp: dict[str, Any] = {}

    @property
    def _tool_hash(self) -> str:
        return self._tools.catalog_hash if self._tools else "none"

    async def open(self) -> None:
        async with self._lock:
            await self._open_locked()

    async def _open_locked(self) -> None:
        if self._stopping:
            raise HarnessStartError("Codex is still stopping")
        validate_native_configuration(self.config.workdir, self._environ)
        self.config.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.config.state_dir.chmod(0o700)
        validate_native_state(self.config.state_dir)
        if self._client and self._client.running and self._epoch:
            return
        if self._client is not None:
            if not await self._client.close(timeout_seconds=STOP_TIMEOUT_SECONDS):
                raise HarnessStartError("Codex process containment could not be confirmed")
            self._client = None
        env = clean_codex_env(self._environ, self.config.state_dir)
        self._mcp = mcp_configuration(self.config.mcp_servers)
        self._epoch = uuid.uuid4().hex
        epoch = self._epoch

        async def callback(method: str, params: dict[str, Any]) -> dict[str, Any]:
            if epoch != self._epoch:
                raise RuntimeError("Stale Codex process")
            try:
                return await self._server_request(method, params)
            except Exception:
                if method == "account/chatgptAuthTokens/refresh" and epoch == self._epoch:
                    # Stop outside the callback task: close cancels callbacks.
                    # A denied/invalid refresh may not leave cached authority running.
                    self._revocation_stop = asyncio.create_task(
                        self.stop_execution(STOP_TIMEOUT_SECONDS), name="codex-auth-stop"
                    )
                raise

        # The subreaper script is executed directly, without importing the
        # harness registry into the small process owner.
        command = (
            sys.executable,
            str(Path(__file__).with_name("process.py")),
            CODEX_BINARY,
            *launch_arguments(self.config.state_dir),
            "app-server",
            "--listen",
            "stdio://",
        )
        client = self._factory(
            command=command,
            cwd=self.config.workdir,
            env=env,
            on_request=callback,
            containment_owner=True,
        )
        self._client = client
        try:
            await client.open()
            await client.request(
                "initialize",
                {
                    "clientInfo": {
                        "name": "open_inspect",
                        "title": "OpenInspect",
                        "version": "1.0.0",
                    },
                    "capabilities": {"experimentalApi": True},
                },
            )
            await client.notify("initialized", {})
            await self._authenticate()
            if self._manifest_path.exists():
                await self._restore_manifest()
            elif self.config.restored or any(
                (self.config.state_dir / name).exists()
                for name in ("sessions", "archived_sessions")
            ):
                self.log.warn("codex.session.history_unavailable")
            if epoch != self._epoch:
                raise HarnessStartError("Codex process changed while starting")
        except BaseException:
            stopped = await asyncio.shield(client.close(timeout_seconds=STOP_TIMEOUT_SECONDS))
            if stopped and self._client is client:
                self._client = None
            raise

    async def _authenticate(self) -> None:
        async with self._auth_lock:
            assert self._client is not None
            client, epoch = self._client, self._epoch
            if self.config.oauth_managed:
                if self._credentials is None:
                    raise HarnessStartError("Codex subscription token broker is not configured")
                token = await self._credentials.fetch()
                if client is not self._client or epoch != self._epoch:
                    raise HarnessStartError("Codex process changed during authentication")
                if self._token and self._token.account_id != token.account_id:
                    raise HarnessStartError(
                        "The bound ChatGPT workspace changed; start a new session"
                    )
                self._token = token
                params = {
                    "type": "chatgptAuthTokens",
                    "accessToken": token.access_token,
                    "chatgptAccountId": token.account_id,
                }
                expected = "chatgpt"
            else:
                key = self._environ.get("OPENAI_API_KEY")
                if not key:
                    raise HarnessStartError("Codex API-key mode requires OPENAI_API_KEY")
                params, expected = {"type": "apiKey", "apiKey": key}, "apiKey"
        # account/read can itself request a host token refresh. Never hold the
        # refresh lock over native RPC, and never target a replacement process.
        await client.request("account/login/start", params)
        account = await client.request("account/read", {"refreshToken": False})
        if client is not self._client or epoch != self._epoch:
            raise HarnessStartError("Codex process changed during authentication")
        native_account = account.get("account") if isinstance(account, dict) else None
        if not isinstance(native_account, dict) or native_account.get("type") != expected:
            raise HarnessStartError("Codex authentication mode did not match the session binding")

        if self.config.oauth_managed:
            routing = account.get("workspaceRouting")
            if (
                not isinstance(routing, dict)
                or routing.get("chatgptAccountId") != self._token.account_id
            ):
                raise HarnessStartError("Codex workspace did not match the session binding")

    async def _restore_manifest(self) -> None:
        try:
            state = json.loads(self._manifest_path.read_text())
            if (
                state["schemaVersion"] != STATE_VERSION
                or state["harness"] != "codex"
                or state["codexVersion"] != CODEX_VERSION
                or state["toolCatalog"] != self._tool_hash
            ):
                raise ValueError("incompatible state")
            thread_id = state["threadId"]
            total = state["tokenTotal"]
            if (
                not isinstance(thread_id, str)
                or not thread_id
                or not isinstance(total, dict)
                or any(type(value) is not int or value < 0 for value in total.values())
            ):
                raise ValueError("invalid state")
            # CodexTransportError propagates: the thread may still exist, so the
            # manifest is kept and only this attempt fails.
            if not await self._resume_native(thread_id):
                raise ValueError("native thread unavailable")
            self.session_id = thread_id
            self._total = total
            self._usage_baseline_known = state.get("usageBaselineKnown") is True
        except (KeyError, TypeError, ValueError, OSError, CodexRpcError):
            self.log.warn("codex.session.history_unavailable")
            self.session_id = None
            self._total = {}
            self._usage_baseline_known = False
            self._manifest_path.replace(self._rejected_manifest_path)

    async def _resume_native(self, thread_id: str) -> bool:
        assert self._client is not None
        result = await self._client.request(
            "thread/resume",
            {
                "threadId": thread_id,
                "developerInstructions": memory_text(self.config.state_dir) or "",
                "cwd": str(self.config.workdir),
                "approvalPolicy": "never",
                "sandbox": "danger-full-access",
                "config": {"mcp_servers": self._mcp},
                # Only the thread id is read; hydrating history can exceed the frame cap.
                "excludeTurns": True,
            },
        )
        return result.get("thread", {}).get("id") == thread_id

    async def resume_session(self, persisted_id: str) -> bool:
        if persisted_id == self.session_id:
            return True
        if self._rejected_manifest_path.exists():
            # The bridge's persisted id names the thread whose manifest was just
            # rejected (catalog/version change); adopting it would certify an
            # incompatible native tool set. The next prompt starts a new thread.
            self.log.warn("codex.session.adoption_refused")
            return False
        # A transport error leaves the outcome unknown: it propagates with the
        # current state and manifest intact, so a later open() can retry.
        try:
            resumed = await self._resume_native(persisted_id)
        except CodexRpcError:
            resumed = False
        self.session_id = None
        self._total = {}
        self._usage_baseline_known = False
        self._manifest_path.unlink(missing_ok=True)
        if not resumed:
            self.log.warn("codex.session.history_unavailable")
            return False
        self.session_id = persisted_id
        self._usage_baseline_known = False
        self._persist()
        return True

    async def create_session(self) -> None:
        async with self._lock:
            await self._open_locked()
            if self.session_id:
                return
            assert self._client is not None
            result = await self._client.request(
                "thread/start",
                {
                    "model": self._model(None),
                    "developerInstructions": memory_text(self.config.state_dir) or "",
                    "cwd": str(self.config.workdir),
                    "approvalPolicy": "never",
                    "sandbox": "danger-full-access",
                    "ephemeral": False,
                    "dynamicTools": self._tools.specs() if self._tools else [],
                    "config": {"mcp_servers": self._mcp},
                },
            )
            self.session_id = result["thread"]["id"]
            # A newly started thread has an authoritative zero usage baseline.
            self._total = {}
            self._usage_baseline_known = True
            self._persist()
            self._rejected_manifest_path.unlink(missing_ok=True)

    def _model(self, selected: str | None) -> str:
        # Model/effort compatibility is owned by control-plane admission.
        # Strip the product provider prefix without keeping a native catalog.
        return (selected or self.config.default_model).removeprefix("openai/")

    async def run_prompt(self, prompt: HarnessPrompt, emit: EventSink) -> TurnOutcome:
        # Held through cleanup, so a waiting prompt never touches native state
        # (or stops the process) while another turn is running.
        async with self._turn_lock:
            return await self._run_turn(prompt, emit)

    async def _run_turn(self, prompt: HarnessPrompt, emit: EventSink) -> TurnOutcome:
        model = self._model(prompt.model)
        paths: list[Path] = []
        state: CodexTurnEvents | None = None
        duration = (
            prompt.max_duration_seconds
            if prompt.max_duration_seconds is not None
            else self.limits.prompt_max_duration_seconds
        )
        deadline = asyncio.get_running_loop().time() + max(0, duration)
        try:
            async with asyncio.timeout_at(deadline):
                await self.open()
                # Connected accounts can rotate or be revoked between turns.
                # API-key login is already established for this process in open().
                if self.config.oauth_managed:
                    await self._authenticate()
                if not self.session_id:
                    await self.create_session()
                assert self._client is not None and self.session_id is not None
                inputs: list[dict[str, Any]] = [{"type": "text", "text": prompt.text}]
                for attachment in prompt.attachments:
                    directory = self.config.state_dir / "openinspect-input"
                    directory.mkdir(exist_ok=True, mode=0o700)
                    path = directory / uuid.uuid4().hex
                    data = base64.b64decode(attachment["content"], validate=True)
                    # Registered first so cleanup also removes a partial write.
                    paths.append(path)
                    path.write_bytes(data)
                    path.chmod(0o600)
                    inputs.append({"type": "localImage", "path": str(path)})
                if asyncio.get_running_loop().time() >= deadline:
                    raise TimeoutError
                # Resolved before submission: pricing never runs while native work does.
                price = self._prices.price(model) if self._prices else None
                unpriced = None if price is not None else self._unpriced_warning(model)
                # Durably distrust the baseline while native work may run: a crash
                # mid-turn must not bill unobserved usage to the next message.
                baseline_known = self._usage_baseline_known
                self._usage_baseline_known = False
                self._persist()
                self._submitting = True
                self._turn_known.clear()
                response = await self._client.request(
                    "turn/start",
                    {
                        "threadId": self.session_id,
                        "input": inputs,
                        "model": model,
                        "effort": prompt.reasoning_effort,
                        "approvalPolicy": "never",
                        "sandboxPolicy": {
                            "type": "externalSandbox",
                            "networkAccess": "enabled",
                        },
                    },
                )
                self._turn_id = response["turn"]["id"]
                self._turn_known.set()
                state = CodexTurnEvents(
                    prompt.message_id,
                    self.session_id,
                    self._turn_id,
                    model,
                    self._total,
                    rate_limits=self._rate_limits,
                    baseline_known=baseline_known,
                    price=price,
                    unpriced_warning=unpriced,
                )
                await emit(state.start())
                # The transport queue retains notifications delivered before the
                # start response. Only this epoch/thread/turn is projected.
                while state.status is None:
                    frame = await self._next_notification()
                    for event in state.accept(frame):
                        await emit(event)
                    if self._total != state.total:
                        self._total = state.total
                        self._persist()
                self._usage_baseline_known = state.status == "completed" and state.has_usage
                self._persist()
                await emit(state.finish())
                if state.status == "completed":
                    return TurnOutcome.ok(message_cost_usd=state.message_cost_usd)
                return TurnOutcome(
                    False,
                    "Codex turn interrupted"
                    if state.status == "interrupted"
                    else state.error or TURN_FAILED_MESSAGE,
                    cancelled=state.status == "interrupted",
                    message_cost_usd=state.message_cost_usd,
                )
        except asyncio.CancelledError:
            stopped = await asyncio.shield(self.stop_execution(STOP_TIMEOUT_SECONDS))
            self._usage_baseline_known = False
            if self.session_id:
                self._persist()
            if not stopped:
                self.log.error("codex.turn.cancel_containment_unconfirmed")
            raise
        except (CodexTransportError, TimeoutError, OSError, KeyError, TypeError, ValueError):
            stopped = await self.stop_execution(STOP_TIMEOUT_SECONDS)
            self._usage_baseline_known = False
            if self.session_id:
                self._persist()
            if stopped and not self._submitting:
                return TurnOutcome.failed(
                    "Codex could not prepare the turn within its runtime budget",
                    message_cost_usd=_observed_cost(state),
                )
            if stopped and (pending := await self._pending_failure(state, emit)):
                return pending
            return TurnOutcome.failed(
                "Codex transport failed; retry to resume the conversation"
                if stopped
                else "Codex process containment could not be confirmed",
                message_cost_usd=_observed_cost(state),
            )
        except OpenAIAccessTokenUnavailable:
            # Transient (timeout, 5xx, 429): a plain retry can succeed, so do not
            # send the user to Settings.
            if not await self.stop_execution(STOP_TIMEOUT_SECONDS):
                return TurnOutcome.failed(
                    "Codex process containment could not be confirmed",
                    message_cost_usd=_observed_cost(state),
                )
            return TurnOutcome.failed(
                "Codex could not obtain a credential right now; retry shortly",
                message_cost_usd=_observed_cost(state),
            )
        except (
            CodexRpcError,
            OpenAIAccessTokenDenied,
            HarnessStartError,
        ):
            if not await self.stop_execution(STOP_TIMEOUT_SECONDS):
                return TurnOutcome.failed(
                    "Codex process containment could not be confirmed",
                    message_cost_usd=_observed_cost(state),
                )
            return TurnOutcome.failed(
                "Codex rejected this session's configuration or credential; check Settings before retrying",
                message_cost_usd=_observed_cost(state),
            )
        except _InactivityTimeout:
            timeout_seconds = self.limits.inactivity_timeout_seconds
            self.log.error("codex.turn.inactivity_timeout", timeout_s=timeout_seconds)
            stopped = await self.stop_execution(STOP_TIMEOUT_SECONDS)
            self._usage_baseline_known = False
            if self.session_id:
                self._persist()
            if stopped and (pending := await self._pending_failure(state, emit)):
                return pending
            return TurnOutcome.failed(
                f"Codex produced no output for {timeout_seconds:.0f}s."
                if stopped
                else "Codex process containment could not be confirmed",
                message_cost_usd=_observed_cost(state),
            )
        except Exception:
            # Any other abnormal exit (e.g. the event sink) may leave native work
            # running: contain it before releasing the turn's ownership state.
            if not await self.stop_execution(STOP_TIMEOUT_SECONDS):
                self.log.error("codex.turn.containment_unconfirmed")
            self._usage_baseline_known = False
            raise
        finally:
            self._submitting = False
            self._turn_known.set()
            self._turn_id = None
            for path in paths:
                path.unlink(missing_ok=True)

    def _unpriced_warning(self, model: str) -> str:
        """Why a model's usage cannot be priced in this sandbox."""
        if self._prices is None or not self._prices.available:
            return "Model prices are unavailable in this sandbox, so this turn's cost is recorded as $0."
        return f"No price is listed for {model} in this sandbox, so this turn's cost is recorded as $0."

    async def _pending_failure(
        self, state: CodexTurnEvents | None, emit: EventSink
    ) -> TurnOutcome | None:
        """The fatal native error a turn recorded before ending without ``turn/completed``."""
        if state is None:
            return None
        for event in state.fail_pending():
            await emit(event)
        return (
            TurnOutcome.failed(state.error, message_cost_usd=state.message_cost_usd)
            if state.error
            else None
        )

    async def _next_notification(self) -> dict[str, Any]:
        """Next frame, bounded by the inactivity budget while no host tool call is running."""
        assert self._client is not None
        while True:
            try:
                async with asyncio.timeout(self.limits.inactivity_timeout_seconds):
                    return await self._client.next_notification()
            except TimeoutError:
                # A host callback (tool call, token refresh) is legitimate activity.
                if not self._client.handling_requests:
                    raise _InactivityTimeout from None

    async def _server_request(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        if method == "account/chatgptAuthTokens/refresh":
            # Capture the version the native process could have rejected BEFORE
            # waiting. Concurrent callbacks must not reject each other's winner.
            rejected = self._token
            client, epoch = self._client, self._epoch
            deadline = asyncio.get_running_loop().time() + OPENAI_ACCESS_TOKEN_TIMEOUT_SECONDS
            async with asyncio.timeout(OPENAI_ACCESS_TOKEN_TIMEOUT_SECONDS), self._auth_lock:
                if (
                    not self.config.oauth_managed
                    or self._credentials is None
                    or rejected is None
                    or self._token is None
                    or params.get("reason") != "unauthorized"
                    or params.get("previousAccountId") != rejected.account_id
                    or self._token.account_id != rejected.account_id
                    or client is not self._client
                    or epoch != self._epoch
                ):
                    raise RuntimeError("Invalid refresh identity")
                token = await self._credentials.fetch(
                    rejected_credential_version=rejected.credential_version,
                    timeout_seconds=deadline - asyncio.get_running_loop().time(),
                )
                if (
                    token.account_id != rejected.account_id
                    or token.credential_version <= rejected.credential_version
                    or token.credential_version < self._token.credential_version
                    or client is not self._client
                    or epoch != self._epoch
                ):
                    raise RuntimeError("Refresh changed account identity or process generation")
                self._token = token
                return {"accessToken": token.access_token, "chatgptAccountId": token.account_id}
        if method == "item/tool/call":
            if self._submitting and self._turn_id is None:
                await asyncio.wait_for(self._turn_known.wait(), 30)
            if (
                self._tools is None
                or params.get("threadId") != self.session_id
                or not self._turn_id
                or params.get("turnId") != self._turn_id
            ):
                raise RuntimeError("Tool request is not owned by the active turn")
            return await self._tools.call(params)
        if method in {"item/commandExecution/requestApproval", "item/fileChange/requestApproval"}:
            return {"decision": "decline"}
        raise RuntimeError("Interactive or unknown host requests are not supported")

    async def abort(self) -> bool:
        if self._client and self._turn_id:
            with contextlib.suppress(CodexTransportError, CodexRpcError):
                await self._client.request(
                    "turn/interrupt",
                    {"threadId": self.session_id, "turnId": self._turn_id},
                    timeout_seconds=1,
                )
                return True
        return False

    async def stop_execution(self, timeout_seconds: float) -> bool:
        # Never wait for the open/authentication lock before containing a process.
        # Invalidating the epoch also fences late login and refresh callbacks.
        self._epoch = ""
        client = self._client
        if client is None:
            return True
        self._stopping = True
        try:
            stopped = await client.close(timeout_seconds=timeout_seconds)
            if stopped and self._client is client:
                self._client = None
            return stopped
        finally:
            self._stopping = False

    async def close(self) -> None:
        if not await self.stop_execution(STOP_TIMEOUT_SECONDS):
            raise RuntimeError("Codex process containment could not be confirmed")
        if self._tool_client:
            await self._tool_client.aclose()

    async def reauthenticate_generation(self, generation: dict[str, Any]) -> None:
        if not await self.stop_execution(STOP_TIMEOUT_SECONDS):
            raise RuntimeError("Codex process containment could not be confirmed")
        # The stopped turn unwinds (and runs its own cleanup) before the turn lock
        # is free; reopening under it means that cleanup cannot stop the new
        # client, and queued prompts start only on the reauthenticated process.
        async with self._turn_lock:
            if not await self.stop_execution(STOP_TIMEOUT_SECONDS):
                raise RuntimeError("Codex process containment could not be confirmed")
            await self.open()

    def _persist(self) -> None:
        payload = {
            "schemaVersion": STATE_VERSION,
            "harness": "codex",
            "codexVersion": CODEX_VERSION,
            "threadId": self.session_id,
            "toolCatalog": self._tool_hash,
            "tokenTotal": self._total,
            "usageBaselineKnown": self._usage_baseline_known,
        }
        staging = self._manifest_path.with_suffix(".tmp")
        fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as output:
            json.dump(payload, output)
            output.flush()
            os.fsync(output.fileno())
        staging.replace(self._manifest_path)
        directory = os.open(self.config.state_dir, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
