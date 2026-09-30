"""Serialize recorded SDK arguments using the installed Modal protobuf contracts.

These cover argument serialization, not RPCs, object hydration, or runtime behavior.
The mappings follow Modal 1.4.3's sandbox.py; resource conversion stays in the SDK.
"""

from inspect import signature
from typing import Any

import modal
from modal._resources import convert_fn_config_to_resources_config
from modal_proto import api_pb2, task_command_router_pb2

# Capture the installed signatures before tests replace SDK methods with fakes.
_EXEC_SIGNATURE = signature(modal.Sandbox.exec)
_CREATE_SIGNATURE = signature(modal.Sandbox.create)


def sandbox_exec_request(*args: str, **kwargs: Any) -> task_command_router_pb2.TaskExecStartRequest:
    _EXEC_SIGNATURE.bind(None, *args, **kwargs)
    return task_command_router_pb2.TaskExecStartRequest(
        command_args=args, timeout_secs=kwargs.get("timeout")
    )


def sandbox_create_request(*args: str, **kwargs: Any) -> api_pb2.SandboxCreateRequest:
    _CREATE_SIGNATURE.bind(*args, **kwargs)
    definition = api_pb2.Sandbox(
        entrypoint_args=args,
        timeout_secs=kwargs["timeout"],
        idle_timeout_secs=kwargs.get("idle_timeout"),
        resources=convert_fn_config_to_resources_config(
            cpu=kwargs.get("cpu"), memory=kwargs.get("memory"), gpu=None
        ),
        workdir=kwargs.get("workdir"),
        open_ports=api_pb2.PortSpecs(
            ports=[
                api_pb2.PortSpec(port=port, unencrypted=False)
                for port in kwargs.get("encrypted_ports", [])
            ]
        ),
        name=kwargs.get("name"),
        experimental_options=kwargs.get("experimental_options"),
    )
    return api_pb2.SandboxCreateRequest(
        definition=definition,
        tags=[
            api_pb2.SandboxTag(tag_name=key, tag_value=value)
            for key, value in kwargs.get("tags", {}).items()
        ],
    )


def snapshot_filesystem_request(
    *, timeout: int | float, command_router: bool
) -> api_pb2.SandboxSnapshotFsRequest | task_command_router_pb2.TaskSnapshotFilesystemRequest:
    if command_router:
        # The router timeout is passed separately, not stored in an integer protobuf field.
        float(timeout)
        return task_command_router_pb2.TaskSnapshotFilesystemRequest()
    return api_pb2.SandboxSnapshotFsRequest(timeout=timeout)
