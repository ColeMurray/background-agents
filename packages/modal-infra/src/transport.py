"""Small, explicit transport identities for versioned sandbox launch APIs.

Business launch code consumes a parsed request and this endpoint identity; it
does not decide which wire contract a request happened to use.
"""

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel


@dataclass(frozen=True)
class ParsedLaunch[RequestT: BaseModel]:
    """Normalized versioned request consumed by common launch flows."""

    request: RequestT
    allocation_name: str | None
    response_fields: dict[str, object]
    sandbox_execution: dict[str, Any] | None


@dataclass(frozen=True)
class LaunchEndpoint[RequestT: BaseModel]:
    name: str
    contract: Literal["v1", "v2"]
    request_model: type[RequestT]

    def parse(
        self,
        raw: dict[str, object],
        parser: Callable[[type[RequestT], dict[str, object]], RequestT],
    ) -> ParsedLaunch[RequestT]:
        request = parser(self.request_model, raw)
        if self.contract == "v1":
            return ParsedLaunch(request, None, {}, None)
        execution = getattr(request, "sandbox_execution")  # noqa: B009
        return ParsedLaunch(
            request=request,
            allocation_name=getattr(request, "allocation_name", None),
            response_fields={"execution_profile": execution.profile},
            sandbox_execution=execution.model_dump(),
        )
