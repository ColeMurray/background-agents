"""Shared HTTP request validation with redacted, stable error messages."""

from typing import Annotated

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, ValidationError


class ModalRequestModel(BaseModel):
    # Ignore new top-level keys so old Modal deployments remain compatible
    # while control-plane instances roll forward.
    model_config = ConfigDict(extra="ignore", strict=True)


NonEmptyString = Annotated[str, Field(min_length=1)]


def parse_request[RequestModelT: BaseModel](
    model: type[RequestModelT], request: dict[str, object]
) -> RequestModelT:
    try:
        return model.model_validate(request)
    except ValidationError as e:
        error = e.errors(include_input=False)[0]
        location = error["loc"]
        field = str(location[0]) if location else "request"
        error_type = error["type"]
        if field == "repositories":
            detail = {
                "list_type": "repositories must be a list",
                "model_type": "repositories entries must be objects",
                "missing": "repositories entries require repo_owner, repo_name, and branch",
                "string_too_short": (
                    "repositories entries require repo_owner, repo_name, and branch"
                ),
                "string_type": "repositories entry fields must be strings",
            }.get(error_type, "repositories has an invalid value")
        elif field == "user_env_vars":
            detail = {
                "dict_type": "user_env_vars must be an object",
                "string_type": "user_env_vars values must be strings",
            }.get(error_type, "user_env_vars has an invalid value")
        elif field == "timeout_seconds":
            detail = "timeout_seconds must be a positive integer"
        elif len(location) > 1:
            detail = f"{field} has an invalid value"
        else:
            detail = {
                "missing": f"{field} is required",
                "string_too_short": f"{field} is required",
                "string_type": f"{field} must be a string",
                "int_type": f"{field} must be an integer",
                "bool_type": f"{field} must be a boolean",
            }.get(error_type, f"{field} has an invalid value")
        raise HTTPException(status_code=400, detail=detail) from None
