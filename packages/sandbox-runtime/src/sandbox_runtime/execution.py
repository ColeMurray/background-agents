"""Versioned sandbox execution identity, shared by launch and runtime decoding."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter


class DefaultSandboxExecution(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    profile: Literal["default"] = "default"


class DockerSandboxExecution(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    profile: Literal["docker-v1"]
    provider: Literal["modal"]
    cpuCores: float = Field(gt=0, allow_inf_nan=False)
    memoryMib: int = Field(gt=0)


SandboxExecution = Annotated[
    DefaultSandboxExecution | DockerSandboxExecution, Field(discriminator="profile")
]
_execution_adapter: TypeAdapter[SandboxExecution] = TypeAdapter(SandboxExecution)


def parse_sandbox_execution(value: object) -> DefaultSandboxExecution | DockerSandboxExecution:
    return _execution_adapter.validate_python(value)
