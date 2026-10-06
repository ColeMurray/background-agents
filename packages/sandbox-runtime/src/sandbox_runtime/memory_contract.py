"""The memory contract shared with the control plane, generated from TypeScript.

``memory_contract.json`` is written by ``npm run generate:memory-contract -w
@open-inspect/shared`` from ``packages/shared/src/memory-tools.ts``; the OpenCode tools read
its JavaScript twin. Nothing here is hand-copied from the control plane.
"""

import json
from pathlib import Path
from typing import Any, Final, TypedDict, cast


class MemoryToolSpec(TypedDict):
    name: str
    description: str
    method: str
    # Below ``/sessions/:id``; ``{name}`` segments are filled from (and consume) input fields.
    path: str
    inputSchema: dict[str, Any]


class MemoryLimits(TypedDict):
    renderedChars: int


class MemorySandboxContract(TypedDict):
    tools: list[MemoryToolSpec]
    sandboxSchemaVersion: int
    limits: MemoryLimits


MEMORY_CONTRACT: Final = cast(
    "MemorySandboxContract",
    json.loads(Path(__file__).with_name("memory_contract.json").read_text(encoding="utf-8")),
)
MEMORY_TOOL_SPECS: Final = MEMORY_CONTRACT["tools"]
SANDBOX_MEMORY_SCHEMA_VERSION: Final = MEMORY_CONTRACT["sandboxSchemaVersion"]
RENDERED_MEMORY_MAX_CHARS: Final = MEMORY_CONTRACT["limits"]["renderedChars"]
