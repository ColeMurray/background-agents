"""Supervisor behaviour when the control plane opts into early bridge connect.

With ``bridge_early_connect`` in SESSION_CONFIG the bridge starts before the
repository boots and the supervisor watches its exit code from then on;
without it the boot order is unchanged. Boot phases the supervisor owns
(``skills``, ``harness``) are reported through the boot-events file, and a
fatal boot failure reports its phase and output tail to the control plane.
"""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from sandbox_runtime import boot_events
from sandbox_runtime.agent_bridge_process import AgentBridgeProcess
from sandbox_runtime.boot_events import BootEventLog, BootPhaseError
from sandbox_runtime.harness.base import DETERMINISTIC_FAILURE_EXIT_CODE
from sandbox_runtime.repo_config import RepoEntry
from sandbox_runtime.repository_boot import RepositoryBootResult
from sandbox_runtime.runtime_config import RuntimeConfig
from sandbox_runtime.supervisor import SandboxSupervisor

EARLY_SESSION_CONFIG = json.dumps({"session_id": "sess-1", "bridge_early_connect": True})
LEGACY_SESSION_CONFIG = json.dumps({"session_id": "sess-1"})


def _supervisor(tmp_path, events, *, session_config=EARLY_SESSION_CONFIG):
    config = RuntimeConfig.from_env(
        {
            "SANDBOX_ID": "sandbox-1",
            "REPO_OWNER": "acme",
            "REPO_NAME": "repo",
            "CONTROL_PLANE_URL": "https://cp.example.com",
            "SANDBOX_AUTH_TOKEN": "tok",
            "SESSION_CONFIG": session_config,
        },
        workspace_path=tmp_path,
    )
    result = RepositoryBootResult(True, [], True, True, (), Path(tmp_path))
    repository = MagicMock()
    repository.prepare_tunnel_environment.return_value = []
    repository.boot = AsyncMock(
        side_effect=lambda mode, _ports: events.append(f"repository:{mode.value}") or result
    )
    harness_process = MagicMock()
    harness_process.exit_code.return_value = None
    harness_process.start = AsyncMock(side_effect=lambda _repos, _workdir: events.append("harness"))
    harness_process.stop = AsyncMock()
    agent_bridge = MagicMock()
    agent_bridge.exit_code.return_value = None
    agent_bridge.started.return_value = False
    agent_bridge.wait = AsyncMock(side_effect=asyncio.Event().wait)

    async def start_bridge(early_connect=None):
        events.append(f"bridge:{'early' if early_connect else 'late'}")
        agent_bridge.started.return_value = True

    agent_bridge.start = AsyncMock(side_effect=start_bridge)
    agent_bridge.stop = AsyncMock()
    code_server = MagicMock()
    code_server.exit_code.return_value = None
    code_server.start = AsyncMock(side_effect=lambda _workdir: events.append("code_server"))
    code_server.stop = AsyncMock()
    terminal = MagicMock()
    terminal.crash.return_value = None
    terminal.start = AsyncMock(side_effect=lambda _workdir: events.append("terminal"))
    terminal.stop = AsyncMock()
    desktop = MagicMock()
    desktop.crash.return_value = None
    desktop.start = AsyncMock(side_effect=lambda: events.append("desktop"))
    desktop.stop = AsyncMock()
    managed_skills = MagicMock()
    managed_skills.materialize = AsyncMock(side_effect=lambda *_args: events.append("skills"))

    supervisor = SandboxSupervisor(
        config,
        repository,
        harness_process,
        agent_bridge,
        code_server,
        terminal,
        desktop,
        managed_skills,
        asyncio.Event(),
        MagicMock(),
        boot_events=BootEventLog(MagicMock()),
    )
    supervisor.monitor_processes = AsyncMock()
    supervisor._report_fatal_error = AsyncMock()
    return supervisor


def _lines() -> list[dict]:
    path = Path(boot_events.BOOT_EVENTS_FILE_PATH)
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines()]


@pytest.fixture(autouse=True)
def _fresh_boot(monkeypatch):
    for name in ("IMAGE_BUILD_MODE", "RESTORED_FROM_SNAPSHOT", "FROM_REPO_IMAGE"):
        monkeypatch.delenv(name, raising=False)


class TestBootOrder:
    async def test_early_connect_starts_the_bridge_before_the_repository_boot(self, tmp_path):
        events = []
        supervisor = _supervisor(tmp_path, events)

        assert await supervisor.run() is True

        assert events == [
            "bridge:early",
            "desktop",
            "repository:fresh",
            "skills",
            "code_server",
            "terminal",
            "harness",
        ]

    async def test_without_the_flag_the_bridge_starts_last(self, tmp_path):
        events = []
        supervisor = _supervisor(tmp_path, events, session_config=LEGACY_SESSION_CONFIG)

        assert await supervisor.run() is True

        assert events[-2:] == ["harness", "bridge:late"]
        assert "bridge:early" not in events

    async def test_image_build_never_starts_a_bridge(self, tmp_path, monkeypatch):
        events = []
        supervisor = _supervisor(tmp_path, events)
        monkeypatch.setenv("IMAGE_BUILD_MODE", "true")
        callback = MagicMock()

        async def report_success(**_kwargs):
            supervisor.shutdown_event.set()
            return True

        callback.report_success = AsyncMock(side_effect=report_success)

        assert await supervisor.run(callback) is True

        supervisor.agent_bridge.start.assert_not_awaited()
        assert _lines() == []

    async def test_supervisor_phases_bracket_skills_and_harness(self, tmp_path):
        supervisor = _supervisor(tmp_path, [])

        await supervisor.run()

        phases = [(line["phase"], line["status"]) for line in _lines()]
        assert phases == [
            ("skills", "started"),
            ("skills", "completed"),
            ("harness", "started"),
            ("harness", "completed"),
        ]

    async def test_a_new_boot_truncates_the_previous_boots_events(self, tmp_path):
        supervisor = _supervisor(tmp_path, [])
        Path(boot_events.BOOT_EVENTS_FILE_PATH).write_text('{"seq": 40, "kind": "phase"}\n')

        await supervisor.run()

        assert _lines()[0]["seq"] == 1


class TestBridgeWatcherDuringBoot:
    def _blocked_boot(self, supervisor):
        boot_started = asyncio.Event()
        boot_cancelled = asyncio.Event()

        async def blocked_boot(_mode, _ports):
            boot_started.set()
            try:
                await asyncio.Event().wait()
            finally:
                boot_cancelled.set()

        supervisor.repository_boot.boot.side_effect = blocked_boot
        return boot_started, boot_cancelled

    async def test_graceful_bridge_exit_cancels_the_boot(self, tmp_path):
        supervisor = _supervisor(tmp_path, [])
        boot_started, boot_cancelled = self._blocked_boot(supervisor)
        bridge_exited = asyncio.Event()
        supervisor.agent_bridge.wait = AsyncMock(side_effect=bridge_exited.wait)

        run_task = asyncio.create_task(supervisor.run())
        await asyncio.wait_for(boot_started.wait(), timeout=1)
        supervisor.agent_bridge.exit_code.return_value = 0
        bridge_exited.set()

        assert await asyncio.wait_for(run_task, timeout=1) is True
        assert boot_cancelled.is_set()
        supervisor.harness_process.start.assert_not_awaited()
        supervisor.log.info.assert_any_call(
            "supervisor.boot_cancelled", reason="shutdown_requested"
        )

    async def test_bridge_crash_during_boot_is_restarted_while_the_boot_continues(
        self, tmp_path, monkeypatch
    ):
        events = []
        supervisor = _supervisor(tmp_path, events)
        boot_started, _boot_cancelled = self._blocked_boot(supervisor)
        first_exit = asyncio.Event()
        restarted = asyncio.Event()
        exits = [first_exit.wait, asyncio.Event().wait]

        async def next_exit():
            await exits.pop(0)()

        supervisor.agent_bridge.wait = AsyncMock(side_effect=next_exit)
        original_start = supervisor.agent_bridge.start.side_effect

        async def restart(early_connect=None):
            await original_start(early_connect)
            if len(events) > 1:
                supervisor.agent_bridge.exit_code.return_value = None
                restarted.set()

        supervisor.agent_bridge.start = AsyncMock(side_effect=restart)
        monkeypatch.setattr(supervisor, "_wait_for_shutdown", AsyncMock(return_value=False))

        run_task = asyncio.create_task(supervisor.run())
        await asyncio.wait_for(boot_started.wait(), timeout=1)
        supervisor.agent_bridge.exit_code.return_value = 1
        first_exit.set()
        await asyncio.wait_for(restarted.wait(), timeout=1)
        for _ in range(5):  # let the shielded exit policy hand its count back
            await asyncio.sleep(0)

        assert supervisor.agent_bridge.start.await_count == 2
        assert not supervisor.shutdown_event.is_set()
        assert supervisor._bridge_restarts == 1
        supervisor.shutdown_event.set()
        await asyncio.wait_for(run_task, timeout=1)

    async def test_deterministic_bridge_failure_during_boot_is_fatal(self, tmp_path):
        supervisor = _supervisor(tmp_path, [])
        boot_started, boot_cancelled = self._blocked_boot(supervisor)
        bridge_exited = asyncio.Event()
        supervisor.agent_bridge.wait = AsyncMock(side_effect=bridge_exited.wait)
        supervisor._read_bridge_fatal_error = MagicMock(return_value="credential denied")

        run_task = asyncio.create_task(supervisor.run())
        await asyncio.wait_for(boot_started.wait(), timeout=1)
        supervisor.agent_bridge.exit_code.return_value = DETERMINISTIC_FAILURE_EXIT_CODE
        bridge_exited.set()

        await asyncio.wait_for(run_task, timeout=1)
        assert boot_cancelled.is_set()
        supervisor._report_fatal_error.assert_awaited_once()
        message, failure = supervisor._report_fatal_error.await_args.args
        assert message == "credential denied"
        assert failure.report_fields() == {"phase": "harness"}
        supervisor.agent_bridge.start.assert_awaited_once()

    async def test_watcher_ends_before_process_monitoring_takes_over(self, tmp_path):
        supervisor = _supervisor(tmp_path, [])
        watcher_done_at_monitor = []

        async def monitor():
            watcher_done_at_monitor.append(supervisor._bridge_watch_task is None)

        supervisor.monitor_processes = AsyncMock(side_effect=monitor)

        await supervisor.run()

        assert watcher_done_at_monitor == [True]

    async def test_watcher_failure_fails_the_boot_rather_than_ending_it_gracefully(self, tmp_path):
        supervisor = _supervisor(tmp_path, [])
        boot_started, boot_cancelled = self._blocked_boot(supervisor)
        bridge_exited = asyncio.Event()
        supervisor.agent_bridge.wait = AsyncMock(side_effect=bridge_exited.wait)
        supervisor._handle_bridge_exit = AsyncMock(side_effect=OSError("cannot spawn bridge"))

        run_task = asyncio.create_task(supervisor.run())
        await asyncio.wait_for(boot_started.wait(), timeout=1)
        supervisor.agent_bridge.exit_code.return_value = 1
        bridge_exited.set()

        assert await asyncio.wait_for(run_task, timeout=1) is False
        assert boot_cancelled.is_set()
        supervisor.log.error.assert_any_call(
            "bridge.watch_failed", exc=supervisor.log.error.call_args.kwargs["exc"]
        )
        supervisor._report_fatal_error.assert_awaited_once()
        assert "cannot spawn bridge" in supervisor._report_fatal_error.await_args.args[0]

    async def test_a_completed_exit_policy_is_consumed_even_when_the_watcher_misses_it(
        self, tmp_path
    ):
        supervisor = _supervisor(tmp_path, [])
        bridge_exited = asyncio.Event()
        policy_started = asyncio.Event()
        policy_may_finish = asyncio.Event()
        supervisor.agent_bridge.wait = AsyncMock(side_effect=bridge_exited.wait)

        async def slow_policy(restarts):
            policy_started.set()
            await policy_may_finish.wait()
            return restarts + 1

        supervisor._handle_bridge_exit = AsyncMock(side_effect=slow_policy)
        supervisor._bridge_watch_task = asyncio.create_task(supervisor._watch_bridge_during_boot())
        supervisor.agent_bridge.started.return_value = True
        supervisor.agent_bridge.exit_code.return_value = 1
        bridge_exited.set()
        await asyncio.wait_for(policy_started.wait(), timeout=1)

        # The policy finishes while the watcher is still suspended, so the
        # handover has to read the count off the future rather than off the
        # watcher's assignment.
        policy_may_finish.set()
        for _ in range(5):
            if supervisor._bridge_exit_policy.done():
                break
            await asyncio.sleep(0)
        assert supervisor._bridge_exit_policy.done()

        await asyncio.wait_for(supervisor._stop_bridge_watch(), timeout=1)

        assert supervisor._bridge_restarts == 1

    async def test_stopping_the_watcher_waits_for_an_in_flight_exit_policy(self, tmp_path):
        supervisor = _supervisor(tmp_path, [])
        bridge_exited = asyncio.Event()
        policy_started = asyncio.Event()
        policy_may_finish = asyncio.Event()
        supervisor.agent_bridge.wait = AsyncMock(side_effect=bridge_exited.wait)

        async def slow_policy(restarts):
            policy_started.set()
            await policy_may_finish.wait()
            return restarts + 1

        supervisor._handle_bridge_exit = AsyncMock(side_effect=slow_policy)
        supervisor._bridge_watch_task = asyncio.create_task(supervisor._watch_bridge_during_boot())
        supervisor.agent_bridge.started.return_value = True
        supervisor.agent_bridge.exit_code.return_value = 1
        bridge_exited.set()
        await asyncio.wait_for(policy_started.wait(), timeout=1)

        stop = asyncio.create_task(supervisor._stop_bridge_watch())
        await asyncio.sleep(0.05)
        assert not stop.done()
        policy_may_finish.set()
        await asyncio.wait_for(stop, timeout=1)

        assert supervisor._bridge_restarts == 1

    async def test_graceful_exit_during_skills_ends_the_boot_before_the_harness(self, tmp_path):
        events = []
        supervisor = _supervisor(tmp_path, events)
        bridge_exited = asyncio.Event()
        skills_started = asyncio.Event()
        supervisor.agent_bridge.wait = AsyncMock(side_effect=bridge_exited.wait)

        async def blocked_skills(*_args):
            events.append("skills")
            skills_started.set()
            await asyncio.Event().wait()

        supervisor.managed_skills.materialize = AsyncMock(side_effect=blocked_skills)

        run_task = asyncio.create_task(supervisor.run())
        await asyncio.wait_for(skills_started.wait(), timeout=1)
        supervisor.agent_bridge.exit_code.return_value = 0
        bridge_exited.set()

        assert await asyncio.wait_for(run_task, timeout=1) is True
        supervisor.harness_process.start.assert_not_awaited()
        assert "harness" not in events
        assert [(line["phase"], line["status"]) for line in _lines()] == [("skills", "started")]

    async def test_watcher_is_idle_when_the_bridge_was_not_started(self, tmp_path):
        supervisor = _supervisor(tmp_path, [])
        supervisor.agent_bridge.start = AsyncMock()
        supervisor.agent_bridge.started.return_value = False

        await supervisor.run()

        supervisor.agent_bridge.wait.assert_not_awaited()


class TestBootEventsFileFailures:
    async def test_a_boot_that_cannot_own_the_events_file_fails(self, tmp_path, monkeypatch):
        supervisor = _supervisor(tmp_path, [])
        monkeypatch.setattr(
            "sandbox_runtime.boot_events.BOOT_EVENTS_FILE_PATH",
            str(tmp_path / "missing" / "oi-boot-events.jsonl"),
        )

        assert await supervisor.run() is False

        supervisor._report_fatal_error.assert_awaited_once()
        supervisor.agent_bridge.start.assert_not_awaited()

    async def test_an_unwritable_harness_completion_fails_the_boot(self, tmp_path, monkeypatch):
        supervisor = _supervisor(tmp_path, [])

        async def start_then_break_the_file(_repos, _workdir):
            monkeypatch.setattr(
                "sandbox_runtime.boot_events.BOOT_EVENTS_FILE_PATH",
                str(tmp_path / "missing" / "oi-boot-events.jsonl"),
            )

        supervisor.harness_process.start = AsyncMock(side_effect=start_then_break_the_file)

        assert await supervisor.run() is False

        supervisor._report_fatal_error.assert_awaited_once()
        message, _failure = supervisor._report_fatal_error.await_args.args
        assert "boot-events append failed" in message


class TestFatalBootReport:
    async def test_boot_phase_failure_reports_phase_and_tail(self, tmp_path):
        supervisor = _supervisor(tmp_path, [])
        supervisor.repository_boot.boot = AsyncMock(
            side_effect=BootPhaseError(
                "start hook failed for acme/repo",
                phase="start",
                repo=RepoEntry(
                    owner="acme", name="repo", branch="main", path=Path("/workspace/repo")
                ),
                output_tail=("npm ERR!", "exit 1"),
                boot_seq=7,
            )
        )

        assert await supervisor.run() is False

        supervisor._report_fatal_error.assert_awaited_once()
        message, failure = supervisor._report_fatal_error.await_args.args
        assert message == "start hook failed for acme/repo"
        assert failure.report_fields() == {
            "phase": "start",
            "bootSeq": 7,
            "repoOwner": "acme",
            "repoName": "repo",
            "outputTail": ["npm ERR!", "exit 1"],
        }

    async def test_harness_start_failure_is_reported_as_the_harness_phase(self, tmp_path):
        supervisor = _supervisor(tmp_path, [])
        supervisor.harness_process.start = AsyncMock(
            side_effect=RuntimeError("OpenCode server failed to become healthy")
        )

        assert await supervisor.run() is False

        message, failure = supervisor._report_fatal_error.await_args.args
        assert message == "OpenCode server failed to become healthy"
        assert failure.phase == "harness"
        failed = _lines()[-1]
        assert (failed["phase"], failed["status"]) == ("harness", "failed")
        assert failure.boot_seq == failed["seq"]

    async def test_a_maximal_report_fits_the_control_planes_body_cap(self, tmp_path):
        # Control characters cost six bytes each once serialized; a tail that
        # satisfies the character bounds alone would be rejected by the route
        # before it ever reached the schema.
        hostile = "\n".join("\x00" * 1024 for _ in range(boot_events.OUTPUT_TAIL_MAX_LINES))
        failure = BootPhaseError(
            "x" * 1000,
            phase="start",
            repo=RepoEntry(owner="acme", name="repo", branch="main", path=Path("/workspace/repo")),
            output_tail=boot_events.bounded_output_tail(hostile),
            boot_seq=12,
        )

        body = {"error": str(failure), "fatal": True, **failure.report_fields()}

        assert failure.output_tail
        # httpx serializes a json= body with ensure_ascii=False.
        serialized = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        assert len(serialized) <= boot_events.FATAL_REPORT_MAX_BYTES

    async def test_report_body_carries_the_structured_failure(self):
        supervisor = SandboxSupervisor.__new__(SandboxSupervisor)
        supervisor.config = RuntimeConfig.from_env(
            {
                "SANDBOX_ID": "sandbox-1",
                "CONTROL_PLANE_URL": "https://cp.example.com",
                "SANDBOX_AUTH_TOKEN": "tok",
                "SESSION_CONFIG": EARLY_SESSION_CONFIG,
            }
        )
        supervisor.log = MagicMock()
        client = AsyncMock()
        client.post.return_value = MagicMock(spec=httpx.Response)
        client_context = AsyncMock()
        client_context.__aenter__.return_value = client
        failure = BootPhaseError(
            "start hook failed for acme/repo",
            phase="start",
            repo=RepoEntry(owner="acme", name="repo", branch="main", path=Path("/workspace/repo")),
            output_tail=("npm ERR!",),
            boot_seq=3,
        )

        with patch("sandbox_runtime.supervisor.httpx.AsyncClient", return_value=client_context):
            await supervisor._report_fatal_error(str(failure), failure)

        assert client.post.await_args.kwargs["json"] == {
            "error": "start hook failed for acme/repo",
            "fatal": True,
            "phase": "start",
            "bootSeq": 3,
            "repoOwner": "acme",
            "repoName": "repo",
            "outputTail": ["npm ERR!"],
        }


class TestAgentBridgeProcessEarlyConnect:
    def _process(self, config_env) -> AgentBridgeProcess:
        config = RuntimeConfig.from_env(config_env)
        return AgentBridgeProcess(config.bridge_process_config(), MagicMock())

    async def test_early_connect_flag_is_passed_and_sticks_across_restarts(self, monkeypatch):
        process = self._process(
            {
                "SANDBOX_ID": "sandbox-1",
                "CONTROL_PLANE_URL": "https://cp.example.com",
                "SANDBOX_AUTH_TOKEN": "tok",
                "SESSION_CONFIG": EARLY_SESSION_CONFIG,
            }
        )
        spawned = []

        async def fake_exec(*args, **_kwargs):
            spawned.append(args)
            child = MagicMock()
            child.returncode = None
            child.stdout = None
            return child

        monkeypatch.setattr(
            "sandbox_runtime.agent_bridge_process.asyncio.create_subprocess_exec", fake_exec
        )
        monkeypatch.setattr("sandbox_runtime.agent_bridge_process.asyncio.sleep", AsyncMock())

        await process.start(early_connect=True)
        await process.start()

        assert all("--early-connect" in args for args in spawned)
        assert len(spawned) == 2

    async def test_without_the_flag_the_argument_is_absent(self, monkeypatch):
        process = self._process(
            {
                "SANDBOX_ID": "sandbox-1",
                "CONTROL_PLANE_URL": "https://cp.example.com",
                "SANDBOX_AUTH_TOKEN": "tok",
                "SESSION_CONFIG": LEGACY_SESSION_CONFIG,
            }
        )
        spawned = []

        async def fake_exec(*args, **_kwargs):
            spawned.append(args)
            child = MagicMock()
            child.returncode = None
            child.stdout = None
            return child

        monkeypatch.setattr(
            "sandbox_runtime.agent_bridge_process.asyncio.create_subprocess_exec", fake_exec
        )
        monkeypatch.setattr("sandbox_runtime.agent_bridge_process.asyncio.sleep", AsyncMock())

        await process.start()

        assert "--early-connect" not in spawned[0]

    async def test_wait_returns_the_exit_code(self):
        process = self._process(
            {
                "SANDBOX_ID": "sandbox-1",
                "CONTROL_PLANE_URL": "https://cp.example.com",
                "SANDBOX_AUTH_TOKEN": "tok",
                "SESSION_CONFIG": EARLY_SESSION_CONFIG,
            }
        )
        assert await process.wait() is None
        child = MagicMock()
        child.wait = AsyncMock(return_value=3)
        process._process = child

        assert await process.wait() == 3


class TestRuntimeConfigFlag:
    def test_flag_is_read_from_session_config(self):
        early = RuntimeConfig.from_env({"SESSION_CONFIG": EARLY_SESSION_CONFIG})
        legacy = RuntimeConfig.from_env({"SESSION_CONFIG": LEGACY_SESSION_CONFIG})
        truthy_string = RuntimeConfig.from_env(
            {"SESSION_CONFIG": json.dumps({"bridge_early_connect": "true"})}
        )

        assert early.bridge_early_connect is True
        assert legacy.bridge_early_connect is False
        assert truthy_string.bridge_early_connect is False


class TestWatcherHandoffFailure:
    async def test_a_respawn_failure_during_handoff_fails_the_boot(self, tmp_path):
        """The policy raises after the watcher was cancelled; steady state must not start."""
        events = []
        supervisor = _supervisor(tmp_path, events)
        bridge_exited = asyncio.Event()
        policy_started = asyncio.Event()
        policy_may_finish = asyncio.Event()
        supervisor.agent_bridge.wait = AsyncMock(side_effect=bridge_exited.wait)

        async def failing_respawn(_restarts):
            policy_started.set()
            await policy_may_finish.wait()
            raise RuntimeError("cannot spawn bridge")

        supervisor._handle_bridge_exit = AsyncMock(side_effect=failing_respawn)

        async def crash_bridge_during_harness_start(_repos, _workdir):
            events.append("harness")
            supervisor.agent_bridge.exit_code.return_value = 1
            bridge_exited.set()
            await policy_started.wait()

        supervisor.harness_process.start = AsyncMock(side_effect=crash_bridge_during_harness_start)

        run_task = asyncio.create_task(supervisor.run())
        await asyncio.wait_for(policy_started.wait(), timeout=1)
        # The handoff begins (the watcher is cancelled) while the policy is in flight.
        while supervisor._bridge_watch_task is not None:
            await asyncio.sleep(0)
        policy_may_finish.set()

        assert await asyncio.wait_for(run_task, timeout=1) is False
        supervisor.monitor_processes.assert_not_awaited()
        supervisor._report_fatal_error.assert_awaited_once()
        assert "cannot spawn bridge" in supervisor._report_fatal_error.await_args.args[0]
