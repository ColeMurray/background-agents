"""Pure projection of a prompt's native sub-agents onto the bridge's ``task`` contract.

Native sub-agents (the ``collaboration`` tools) run on their own threads and
turns, each turn naming the prompt's turn as ``rootTurnId``. Direct messages
are disabled at launch, so a sub-agent runs only the turn its spawn starts.

Native state is kept per thread from the first rooted turn: lifecycle and
token usage are reduced immediately, whatever order the threads' independent
notification streams arrive in. The parent thread's ``subAgentActivity``
announcement only adds presentation: the sub-agent becomes one ``task`` tool
call under the prompt's message, its tool calls nest under that task, and its
turn reports usage as a subtask step. Until then its presentation is deferred.

Only one level is supported, matching the timeline: a spawn announced by any
thread but the parent's is refused, and the refused turn reported for interruption.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .events import (
    MAX_ASSISTANT_TEXT_CHARS,
    TOKEN_FIELDS,
    failure_message,
    project_usage,
    tool_call_event,
)

SUBAGENT_INTERRUPTED_MESSAGE = "Sub-agent interrupted"
# Deferred tool calls of not-yet-announced sub-agents. Only presentation is
# bounded; lifecycle and usage are already reduced into native state.
MAX_DEFERRED_EVENTS = 2000


def _zero_usage() -> dict[str, int]:
    return dict.fromkeys(TOKEN_FIELDS, 0)


@dataclass
class _Agent:
    """Native state of one sub-agent thread whose work is rooted at this prompt."""

    thread_id: str
    task_call_id: str
    # Presentation, set by the parent's announcement.
    args: dict[str, Any] | None = None
    model: str | None = None
    refused: bool = False
    turn_id: str | None = None
    running: bool = False
    # Announced, but its turn has not been reported yet.
    pending: bool = False
    status: str = "running"
    output: str = ""
    text: str = ""
    error: Any = None
    # A spawned thread is new: its cumulative usage starts from zero.
    total: dict[str, int] = field(default_factory=_zero_usage)
    usage_valid: bool = True
    tokens: dict[str, Any] | None = None
    reason: str | None = None
    deferred: list[dict[str, Any]] = field(default_factory=list)


class CodexSubagents:
    def __init__(self, message_id: str, thread_id: str, turn_id: str, model: str) -> None:
        self.message_id, self.thread_id, self.turn_id = message_id, thread_id, turn_id
        self.model = model
        self._agents: dict[str, _Agent] = {}
        self._deferred_events = 0
        self._interrupts: list[tuple[str, str]] = []
        self._stopping = False

    @property
    def busy(self) -> bool:
        """Whether descendant work rooted at this prompt is announced or running."""
        return any(agent.running or agent.pending for agent in self._agents.values())

    def owns(self, thread_id: Any, turn_id: Any) -> bool:
        """Whether a host tool call comes from an announced sub-agent's running turn."""
        agent = self._agents.get(thread_id) if isinstance(thread_id, str) else None
        return (
            agent is not None
            and agent.args is not None
            and agent.running
            and isinstance(turn_id, str)
            and agent.turn_id == turn_id
        )

    def refuses(self, thread_id: Any) -> bool:
        """Whether a thread is a refused descendant, which never owns host tool calls."""
        agent = self._agents.get(thread_id) if isinstance(thread_id, str) else None
        return agent is not None and agent.refused

    def stop(self) -> list[tuple[str, str]]:
        """Running descendant turns to interrupt. Any turn that starts later is reported too."""
        self._stopping = True
        return [(a.thread_id, a.turn_id) for a in self._agents.values() if a.running and a.turn_id]

    def take_interrupts(self) -> list[tuple[str, str]]:
        """Refused (or post-stop) turns to interrupt, each reported once."""
        interrupts, self._interrupts = self._interrupts, []
        return interrupts

    def accept(self, frame: dict[str, Any]) -> list[dict[str, Any]]:
        method, params = frame.get("method"), frame.get("params")
        if not isinstance(params, dict) or not isinstance(params.get("threadId"), str):
            return []
        thread_id = params["threadId"]
        item = params.get("item") if isinstance(params.get("item"), dict) else {}
        if method in {"item/started", "item/completed"} and item.get("type") == "subAgentActivity":
            return self._activity(thread_id, params.get("turnId"), item)
        if thread_id == self.thread_id:
            return []
        turn = params.get("turn") if isinstance(params.get("turn"), dict) else {}
        if method == "turn/started":
            return self._turn_started(thread_id, turn)
        agent = self._agents.get(thread_id)
        turn_id = turn.get("id") if method == "turn/completed" else params.get("turnId")
        if agent is None or not agent.running or turn_id != agent.turn_id:
            return []
        if method == "turn/completed":
            return self._turn_completed(agent, turn)
        if method == "thread/tokenUsage/updated":
            return self._usage(agent, params.get("tokenUsage"))
        if method == "error":
            # The terminal ``turn/completed`` reports the failure.
            if params.get("willRetry") is not True and isinstance(params.get("error"), dict):
                agent.error = params["error"]
            return []
        if method not in {"item/started", "item/completed"}:
            return []
        if item.get("type") == "agentMessage":
            if method == "item/completed":
                agent.text = str(item.get("text", ""))[:MAX_ASSISTANT_TEXT_CHARS]
            return []
        event = tool_call_event(method, item, self.message_id, turn_id)
        return self._present(agent, self._nested(agent, event)) if event else []

    def _agent(self, thread_id: str) -> _Agent:
        if thread_id not in self._agents:
            self._agents[thread_id] = _Agent(
                thread_id, task_call_id=f"codex:{self.turn_id}:agent:{thread_id}"
            )
        return self._agents[thread_id]

    def _activity(self, thread_id: str, turn_id: Any, item: dict[str, Any]) -> list[dict[str, Any]]:
        agent_thread_id = item.get("agentThreadId")
        # Completion and interruption are read from the sub-agent's own turn.
        if (
            item.get("kind") != "started"
            or not isinstance(agent_thread_id, str)
            or not agent_thread_id
            or agent_thread_id == self.thread_id
        ):
            return []
        if thread_id != self.thread_id:
            spawner = self._agents.get(thread_id)
            if spawner is not None and spawner.running and turn_id == spawner.turn_id:
                self._refuse(self._agent(agent_thread_id))
            return []
        if turn_id != self.turn_id:
            return []
        agent = self._agent(agent_thread_id)
        if agent.args is not None or agent.refused:
            return []
        path = item.get("agentPath")
        path = path if isinstance(path, str) and path.strip("/") else agent_thread_id
        model = item.get("model")
        agent.args = {"description": path.rstrip("/").rsplit("/", 1)[-1], "task_id": path}
        agent.model = model if isinstance(model, str) and model else self.model
        # Spawning always starts the sub-agent's turn.
        agent.pending = agent.turn_id is None
        events = [self._task(agent)]
        if agent.turn_id is not None:
            events.append(self._step(agent, "step_start"))
        events.extend(agent.deferred)
        self._deferred_events -= len(agent.deferred)
        agent.deferred = []
        if agent.tokens is not None or (agent.turn_id is not None and not agent.running):
            events.append(self._step(agent, "step_finish"))
        return events

    def _refuse(self, agent: _Agent) -> None:
        if agent.refused:
            return
        agent.refused = True
        self._deferred_events -= len(agent.deferred)
        agent.deferred = []
        if agent.running and agent.turn_id:
            self._interrupts.append((agent.thread_id, agent.turn_id))

    def _turn_started(self, thread_id: str, turn: dict[str, Any]) -> list[dict[str, Any]]:
        turn_id = turn.get("id")
        # Only turns rooted at this prompt are its work, even on a known thread.
        if not isinstance(turn_id, str) or not turn_id or turn.get("rootTurnId") != self.turn_id:
            return []
        agent = self._agent(thread_id)
        if agent.turn_id is not None:
            # A sub-agent runs only the turn its spawn starts.
            return []
        agent.turn_id, agent.running, agent.pending = turn_id, True, False
        if self._stopping or agent.refused:
            self._interrupts.append((thread_id, turn_id))
        if agent.args is None:
            return []
        return [self._task(agent), self._step(agent, "step_start")]

    def _turn_completed(self, agent: _Agent, turn: dict[str, Any]) -> list[dict[str, Any]]:
        agent.running = False
        status = turn.get("status")
        agent.reason = status if isinstance(status, str) else None
        if status == "completed":
            agent.status, agent.output = "completed", agent.text
        else:
            agent.status = "error"
            if status == "interrupted":
                agent.output = agent.text or SUBAGENT_INTERRUPTED_MESSAGE
            else:
                error = turn.get("error")
                agent.output = failure_message(error if isinstance(error, dict) else agent.error)
        if agent.args is None:
            return []
        return [self._step(agent, "step_finish"), self._task(agent)]

    def _usage(self, agent: _Agent, usage: Any) -> list[dict[str, Any]]:
        if not agent.usage_valid:
            return []
        # A sub-agent's only turn starts with its thread, at zero usage.
        total, tokens = project_usage(usage, _zero_usage(), agent.total, baseline_known=True)
        if total is None:
            agent.usage_valid, agent.tokens = False, None
        else:
            agent.total, agent.tokens = total, tokens
        return [self._step(agent, "step_finish")] if agent.args is not None else []

    def _present(self, agent: _Agent, event: dict[str, Any]) -> list[dict[str, Any]]:
        """Emit an announced sub-agent's event, or defer it, within bounds, until then."""
        if agent.args is not None:
            return [event]
        if not agent.refused and self._deferred_events < MAX_DEFERRED_EVENTS:
            agent.deferred.append(event)
            self._deferred_events += 1
        return []

    def _task(self, agent: _Agent) -> dict[str, Any]:
        return {
            "type": "tool_call",
            "messageId": self.message_id,
            "callId": agent.task_call_id,
            "tool": "task",
            "args": agent.args,
            "status": agent.status,
            "output": agent.output,
            "childSessionId": agent.thread_id,
        }

    def _step(self, agent: _Agent, kind: str) -> dict[str, Any]:
        event: dict[str, Any] = {
            "type": kind,
            "messageId": self.message_id,
            "stepId": f"codex:{agent.thread_id}:{agent.turn_id}",
            "model": f"openai/{agent.model}",
        }
        if kind == "step_finish":
            if agent.tokens is not None:
                event["tokens"] = agent.tokens
            # Native turn events report tokens, not dollar costs.
            event.update(cost=0, messageCostUsd=0, reason=agent.reason or "unknown")
        return self._nested(agent, event)

    def _nested(self, agent: _Agent, event: dict[str, Any]) -> dict[str, Any]:
        event.update(isSubtask=True, taskCallId=agent.task_call_id, childSessionId=agent.thread_id)
        return event
