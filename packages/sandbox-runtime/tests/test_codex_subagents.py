from sandbox_runtime.harness.codex.events import CodexRateLimits, CodexTurnEvents
from sandbox_runtime.harness.codex.subagents import (
    MAX_DEFERRED_EVENTS,
    SUBAGENT_INTERRUPTED_MESSAGE,
    CodexSubagents,
)
from sandbox_runtime.model_prices import ModelPrice

PARENT, TURN, CHILD = "parent-thread", "parent-turn", "child-thread"
TASK = f"codex:{TURN}:agent:{CHILD}"
# USD per million tokens.
PRICE = ModelPrice.parse({"input": 2, "output": 10})


def build():
    parent = CodexTurnEvents("m", PARENT, TURN, "gpt-6.1-sol", {}, rate_limits=CodexRateLimits())
    return CodexSubagents(parent)


def activity(kind="started", *, thread=PARENT, turn=TURN, agent=CHILD, path="/root/review_auth"):
    return {
        "method": "item/started",
        "params": {
            "threadId": thread,
            "turnId": turn,
            "item": {
                "type": "subAgentActivity",
                "id": f"{kind}-{agent}",
                "kind": kind,
                "agentThreadId": agent,
                "agentPath": path,
                "model": None,
            },
        },
    }


def turn_started(turn="child-turn", *, thread=CHILD, root=TURN):
    return {
        "method": "turn/started",
        "params": {"threadId": thread, "turn": {"id": turn, "rootTurnId": root}},
    }


def turn_completed(turn="child-turn", status="completed", *, thread=CHILD, error=None):
    return {
        "method": "turn/completed",
        "params": {"threadId": thread, "turn": {"id": turn, "status": status, "error": error}},
    }


def item(method, value, *, turn="child-turn", thread=CHILD):
    return {"method": method, "params": {"threadId": thread, "turnId": turn, "item": value}}


def command(item_id="c1"):
    return item("item/completed", {"type": "commandExecution", "id": item_id, "command": "ls"})


def usage(input_tokens, output_tokens, *, turn="child-turn", thread=CHILD):
    return {
        "method": "thread/tokenUsage/updated",
        "params": {
            "threadId": thread,
            "turnId": turn,
            "tokenUsage": {
                "total": {
                    "inputTokens": input_tokens,
                    "cachedInputTokens": 0,
                    "outputTokens": output_tokens,
                    "reasoningOutputTokens": 0,
                    "totalTokens": input_tokens + output_tokens,
                }
            },
        },
    }


def feed(subagents, *frames):
    events = []
    for frame in frames:
        events.extend(subagents.accept(frame))
    return events


def tasks(events):
    return [e for e in events if e["type"] == "tool_call" and e["tool"] == "task"]


def test_spawned_subagent_is_a_task_whose_activity_nests_under_it():
    subagents = build()
    assert subagents.accept(activity()) == [
        {
            "type": "tool_call",
            "messageId": "m",
            "callId": TASK,
            "tool": "task",
            "args": {"description": "review_auth", "task_id": "/root/review_auth"},
            "status": "running",
            "output": "",
            "childSessionId": CHILD,
        }
    ]
    # The repeated item/completed for the same announcement is not a second task.
    assert subagents.accept({**activity(), "method": "item/completed"}) == []
    assert subagents.busy

    started = subagents.accept(turn_started())
    assert started[1] == {
        "type": "step_start",
        "messageId": "m",
        "stepId": f"codex:{CHILD}:child-turn",
        "model": "openai/gpt-6.1-sol",
        "isSubtask": True,
        "taskCallId": TASK,
        "childSessionId": CHILD,
    }
    [tool] = subagents.accept(command())
    assert (tool["tool"], tool["callId"]) == ("bash", "codex:child-turn:c1")
    assert (tool["isSubtask"], tool["taskCallId"], tool["childSessionId"]) == (True, TASK, CHILD)
    [step] = subagents.accept(usage(100, 10))
    assert step["tokens"]["total"] == 110
    # Unpriced: no step cost, and nothing priced for the prompt.
    assert "cost" not in step and step["messageCostUsd"] == 0

    # Sub-agent text is the task result, never streamed.
    message = {"type": "agentMessage", "id": "a1", "text": "Auth is fine."}
    assert (
        feed(subagents, item("item/completed", message), item("item/agentMessage/delta", {})) == []
    )
    finished = subagents.accept(turn_completed())
    assert (finished[0]["type"], finished[0]["reason"]) == ("step_finish", "completed")
    assert (tasks(finished)[0]["status"], tasks(finished)[0]["output"]) == (
        "completed",
        "Auth is fine.",
    )
    assert not subagents.busy


def test_failed_and_interrupted_subagents_report_errors():
    subagents = build()
    feed(subagents, activity(), turn_started())
    failed = subagents.accept(
        turn_completed(status="failed", error={"codexErrorInfo": "usageLimitExceeded"})
    )
    assert tasks(failed)[0]["status"] == "error"
    assert "usage limit" in tasks(failed)[0]["output"]

    other = build()
    feed(other, activity(), turn_started())
    task = tasks(other.accept(turn_completed(status="interrupted")))[0]
    assert (task["status"], task["output"]) == ("error", SUBAGENT_INTERRUPTED_MESSAGE)


def test_regressing_usage_is_dropped_for_the_rest_of_the_turn():
    subagents = build()
    feed(subagents, activity(), turn_started(), usage(100, 10))
    warning, step = subagents.accept(usage(50, 5))
    assert warning["type"] == "warning" and "inconsistent" in warning["message"]
    assert "tokens" not in step
    # Reported once; later usage is not counted.
    [step] = subagents.accept(usage(200, 10))
    assert "tokens" not in step


def test_turn_finished_before_its_announcement_settles_and_is_projected():
    subagents = build()
    message = {"type": "agentMessage", "id": "a1", "text": "Done."}
    early = feed(
        subagents,
        turn_started(),
        command(),
        item("item/completed", message),
        usage(100, 10),
        turn_completed(),
    )
    assert early == []
    assert not subagents.busy
    events = subagents.accept(activity())
    assert not subagents.busy
    assert [e["type"] for e in events] == ["tool_call", "step_start", "tool_call", "step_finish"]
    assert (events[0]["status"], events[0]["output"]) == ("completed", "Done.")
    assert events[2]["tool"] == "bash" and events[2]["taskCallId"] == TASK
    assert events[3]["tokens"]["total"] == 110 and events[3]["reason"] == "completed"


def test_usage_is_kept_when_deferred_presentation_overflows():
    subagents = build()
    subagents.accept(turn_started())
    feed(subagents, *(command(f"c{i}") for i in range(MAX_DEFERRED_EVENTS + 10)))
    feed(subagents, usage(130, 15), turn_completed())
    events = subagents.accept(activity())
    assert len([e for e in events if e.get("tool") == "bash"]) == MAX_DEFERRED_EVENTS
    assert events[-1]["type"] == "step_finish"
    assert events[-1]["tokens"]["total"] == 145


def test_turn_rooted_at_another_prompt_is_not_owned_or_projected():
    subagents = build()
    assert subagents.accept(turn_started("foreign", root="other-root")) == []
    assert not subagents.busy
    feed(subagents, activity(), turn_started(), turn_completed())
    assert subagents.accept(turn_started("foreign", root="other-root")) == []
    assert not subagents.owns(CHILD, "foreign")
    assert not subagents.busy
    assert subagents.accept(command()) == []


def test_tool_ownership_requires_an_announced_running_turn():
    subagents = build()
    subagents.accept(turn_started())
    # Rooted here, but not yet known to be a sub-agent rather than a refused descendant.
    assert not subagents.owns(CHILD, "child-turn")
    subagents.accept(activity())
    assert subagents.owns(CHILD, "child-turn")
    assert not subagents.owns(CHILD, "other-turn")
    assert not subagents.owns({"unhashable": True}, "child-turn")
    subagents.accept(turn_completed())
    assert not subagents.owns(CHILD, "child-turn")


def test_grandchildren_are_refused_and_their_turns_reported_for_interruption():
    subagents = build()
    feed(subagents, activity(), turn_started())
    spawn = activity(thread=CHILD, turn="child-turn", agent="grandchild")
    assert feed(subagents, spawn, turn_started("grand-turn", thread="grandchild")) == []
    assert subagents.take_interrupts() == [("grandchild", "grand-turn")]
    assert subagents.take_interrupts() == []
    assert subagents.refuses("grandchild")
    # Its activity is never projected, but it is running work until it ends.
    grand_command = {"type": "commandExecution", "id": "g"}
    assert (
        subagents.accept(
            item("item/completed", grand_command, turn="grand-turn", thread="grandchild")
        )
        == []
    )
    subagents.accept(turn_completed())
    assert subagents.busy
    subagents.accept(turn_completed("grand-turn", "interrupted", thread="grandchild"))
    assert not subagents.busy


def test_a_child_that_spawns_before_its_own_announcement_is_still_limited():
    subagents = build()
    feed(
        subagents,
        turn_started(),
        activity(thread=CHILD, turn="child-turn", agent="grandchild"),
        turn_started("grand-turn", thread="grandchild"),
        item("item/completed", {"type": "commandExecution", "id": "g"}, thread="grandchild"),
    )
    assert subagents.take_interrupts() == [("grandchild", "grand-turn")]
    events = subagents.accept(activity())
    assert all(e.get("childSessionId") == CHILD for e in events)


def test_refusal_after_the_grandchild_turn_started_still_interrupts_it():
    subagents = build()
    feed(subagents, activity(), turn_started(), turn_started("grand-turn", thread="grandchild"))
    subagents.accept(activity(thread=CHILD, turn="child-turn", agent="grandchild"))
    assert subagents.take_interrupts() == [("grandchild", "grand-turn")]


def test_spawns_from_unrelated_threads_are_ignored():
    subagents = build()
    subagents.accept(activity(thread="stranger", turn="t", agent="other"))
    assert not subagents.refuses("other")
    assert subagents.accept(activity(turn="older-turn")) == []
    assert not subagents.busy


def test_stop_reports_running_turns_and_any_that_start_later():
    subagents = build()
    feed(subagents, activity(), turn_started())
    assert subagents.stop() == [(CHILD, "child-turn")]
    feed(
        subagents,
        activity(agent="late", path="/root/late"),
        turn_started("late-turn", thread="late"),
    )
    assert subagents.take_interrupts() == [("late", "late-turn")]


def test_subagent_requests_are_charged_to_the_prompts_cost():
    parent = CodexTurnEvents(
        "m", PARENT, TURN, "gpt-6.1-sol", {}, rate_limits=CodexRateLimits(), price=PRICE
    )
    subagents = CodexSubagents(parent)
    feed(subagents, activity(), turn_started())
    [step] = subagents.accept(usage(1000, 100))
    # 1000 input at $2/M and 100 output at $10/M.
    assert step["cost"] == step["messageCostUsd"] == 0.003
    assert parent.finish()["messageCostUsd"] == parent.message_cost_usd == 0.003
    # The parent's own step made no requests.
    assert parent.finish()["cost"] == 0


def test_subagent_on_another_model_is_an_estimate_at_the_prompts_prices():
    parent = CodexTurnEvents(
        "m", PARENT, TURN, "gpt-6.1-sol", {}, rate_limits=CodexRateLimits(), price=PRICE
    )
    subagents = CodexSubagents(parent)
    subagents.accept(turn_started())
    subagents.accept(usage(1000, 100))
    other = activity()
    other["params"]["item"]["model"] = "gpt-6-luna"
    warning, task, *rest = subagents.accept(other)
    assert warning["type"] == "warning" and "switched models" in warning["message"]
    assert task["tool"] == "task"
    [step] = [e for e in rest if e["type"] == "step_finish"]
    assert "cost" not in step and step["messageCostUsd"] == 0.003
    assert step["model"] == "openai/gpt-6-luna"


def test_a_parent_turn_that_does_not_complete_stops_its_subagents():
    subagents = build()
    feed(subagents, activity(), turn_started())
    subagents.accept(turn_completed(TURN, "completed", thread=PARENT))
    assert subagents.take_interrupts() == []

    stopped = build()
    feed(stopped, activity(), turn_started())
    stopped.accept(turn_completed(TURN, "interrupted", thread=PARENT))
    assert stopped.take_interrupts() == [(CHILD, "child-turn")]
    # Reported once; a turn that starts later is reported too.
    stopped.accept(turn_completed(TURN, "interrupted", thread=PARENT))
    stopped.accept(turn_started("late-turn", thread="late"))
    assert stopped.take_interrupts() == [("late", "late-turn")]
