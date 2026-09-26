"""Tool-call frame budgeting before events enter the forwarder."""

import json

import pytest

from sandbox_runtime.event_size import MAX_EVENT_BYTES, truncate_tool_call


def tool_call(**overrides):
    return {
        "type": "tool_call",
        "sandboxId": "sb-1",
        "timestamp": 1,
        "messageId": "msg-1",
        "callId": "call-1",
        "tool": "Write",
        "status": "completed",
        "args": {"filePath": "/workspace/report.txt"},
        **overrides,
    }


def encoded_size(event):
    return len(json.dumps(event).encode("utf-8"))


def test_under_budget_returns_the_same_event():
    event = tool_call(output="ok")

    assert truncate_tool_call(event) is event
    assert "truncated" not in event


def test_events_below_storage_budget_are_not_truncated_just_for_size():
    event = tool_call(output="x" * 750_000)

    assert MAX_EVENT_BYTES == 1_000_000
    assert truncate_tool_call(event) is event
    assert "truncated" not in event


def test_truncates_output_before_args_and_marks_original_size():
    event = tool_call(output="x" * MAX_EVENT_BYTES, args={"path": "/tmp/a", "content": "keep"})

    result = truncate_tool_call(event)

    assert result["truncated"] == {"fields": ["output"], "originalBytes": encoded_size(event)}
    assert result["output"].startswith("x")
    assert result["args"] == event["args"]
    assert encoded_size(result) <= MAX_EVENT_BYTES
    assert event["output"] == "x" * MAX_EVENT_BYTES


def test_truncates_largest_nested_args_after_output_without_touching_paths():
    event = tool_call(
        output="o" * (MAX_EVENT_BYTES // 2),
        args={
            "path": "/tmp/a",
            "options": {"filePath": "/tmp/b", "content": "c" * MAX_EVENT_BYTES},
            "blocks": [{"text": "b" * (MAX_EVENT_BYTES // 2)}],
        },
    )

    result = truncate_tool_call(event)

    assert result["truncated"] == {
        "fields": ["output", "args.options.content"],
        "originalBytes": encoded_size(event),
    }
    assert result["output"] == ""
    assert result["args"]["path"] == "/tmp/a"
    assert result["args"]["options"]["filePath"] == "/tmp/b"
    assert result["args"]["blocks"] == event["args"]["blocks"]
    assert encoded_size(result) <= MAX_EVENT_BYTES


def test_truncates_multiple_args_in_descending_size_order():
    event = tool_call(args={"small": "s" * (MAX_EVENT_BYTES // 3), "large": "l" * MAX_EVENT_BYTES})

    result = truncate_tool_call(event)

    assert result["truncated"]["fields"] == ["args.large"]
    assert result["args"]["small"] == event["args"]["small"]
    assert encoded_size(result) <= MAX_EVENT_BYTES


def test_truncates_each_eligible_arg_when_one_is_not_enough():
    event = tool_call(
        args={
            "filePath": "/tmp/a",
            "first": "f" * MAX_EVENT_BYTES,
            "second": "s" * MAX_EVENT_BYTES,
        }
    )

    result = truncate_tool_call(event)

    assert result["truncated"]["fields"] == ["args.first", "args.second"]
    assert result["args"]["filePath"] == "/tmp/a"
    assert result["tool"] == event["tool"]
    assert result["callId"] == event["callId"]
    assert result["status"] == event["status"]
    assert result["messageId"] == event["messageId"]
    assert encoded_size(result) <= MAX_EVENT_BYTES


def test_multibyte_text_and_json_escapes_remain_valid():
    event = tool_call(output='\U0001f600\n"\u6f22' * (MAX_EVENT_BYTES // 8))

    result = truncate_tool_call(event)
    encoded = json.dumps(result).encode("utf-8")

    assert len(encoded) <= MAX_EVENT_BYTES
    assert json.loads(encoded.decode("utf-8")) == result
    assert result["output"] == event["output"][: len(result["output"])]
    assert result["truncated"]["fields"] == ["output"]


def test_protected_path_too_large_to_fit_raises_instead_of_corrupting_it():
    event = tool_call(args={"filePath": "p" * MAX_EVENT_BYTES})

    with pytest.raises(ValueError, match="protected"):
        truncate_tool_call(event)
