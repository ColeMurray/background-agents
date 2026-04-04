"""FastAPI app exposing Daytona lifecycle endpoints for the control plane."""

from __future__ import annotations

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from .auth import AuthConfigurationError, verify_internal_token
from .service import (
    CreateSandboxRequest,
    DaytonaSandboxService,
    ResumeSandboxRequest,
    StopSandboxRequest,
)

app = FastAPI(title="open-inspect-daytona")


class ResponseEnvelope(BaseModel):
    """Generic JSON envelope used by the control plane clients."""

    success: bool
    data: dict | None = None
    error: str | None = None


def require_auth(authorization: str | None) -> None:
    """Reject unauthenticated requests."""
    try:
        if not verify_internal_token(authorization):
            raise HTTPException(status_code=401, detail="Unauthorized")
    except AuthConfigurationError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/health")
def health() -> ResponseEnvelope:
    """Health check endpoint."""
    return ResponseEnvelope(success=True, data={"status": "healthy", "service": "open-inspect-daytona"})


@app.post("/api/create-sandbox")
def create_sandbox(
    request: CreateSandboxRequest,
    authorization: str | None = Header(None),
) -> ResponseEnvelope:
    """Create a Daytona sandbox."""
    require_auth(authorization)
    result = DaytonaSandboxService().create_sandbox(request)
    return ResponseEnvelope(success=True, data=result)


@app.post("/api/resume-sandbox")
def resume_sandbox(
    request: ResumeSandboxRequest,
    authorization: str | None = Header(None),
) -> ResponseEnvelope:
    """Resume a Daytona sandbox."""
    require_auth(authorization)
    result = DaytonaSandboxService().resume_sandbox(request)
    return ResponseEnvelope(success=True, data=result)


@app.post("/api/stop-sandbox")
def stop_sandbox(
    request: StopSandboxRequest,
    authorization: str | None = Header(None),
) -> ResponseEnvelope:
    """Stop a Daytona sandbox."""
    require_auth(authorization)
    result = DaytonaSandboxService().stop_sandbox(request)
    return ResponseEnvelope(success=True, data=result)
