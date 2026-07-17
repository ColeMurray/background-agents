"""Session diff capture command handling and control-plane upload client."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from .diff_collector import CaptureLimits, DiffCaptureError, collect_repository_diff
from .repo_config import load_repo_manifest

if TYPE_CHECKING:
    from pathlib import Path

    import httpx

    from .log_config import StructuredLogger


class SessionDiffCaptureClient:
    """Executes one bounded capture command without coupling it to the bridge loop."""

    def __init__(
        self,
        *,
        session_id: str,
        control_plane_url: str,
        auth_token: str,
        repo_manifest_path: Path,
        http_client: httpx.AsyncClient | None,
        log: StructuredLogger,
    ) -> None:
        self.session_id = session_id
        self.control_plane_url = control_plane_url
        self.auth_token = auth_token
        self.repo_manifest_path = repo_manifest_path
        self.http_client = http_client
        self.log = log

    async def handle(self, command: dict[str, Any]) -> None:
        """Capture and upload one bounded checkout revision.

        Failure is reported to the diff endpoint and never escapes to terminate
        the bridge or change the completed agent execution's outcome.
        """
        capture_id = str(command.get("captureId") or "")
        timeout_ms = int((command.get("limits") or {}).get("timeoutMs") or 0)
        try:
            if not capture_id or timeout_ms <= 0:
                raise DiffCaptureError("Invalid capture command")
            await asyncio.wait_for(self._capture_and_finalize(command), timeout=timeout_ms / 1_000)
        except Exception as error:
            self.log.warn(
                "session_diff.capture_failed",
                capture_id=capture_id,
                error=str(error),
            )
            if capture_id:
                try:
                    await self._request(
                        "POST",
                        f"/sessions/{quote(self.session_id, safe='')}/diff-captures/"
                        f"{quote(capture_id, safe='')}/failed",
                        json_body={"error": str(error)[:2_000]},
                    )
                except Exception as report_error:
                    self.log.warn(
                        "session_diff.failure_report_failed",
                        capture_id=capture_id,
                        error=str(report_error),
                    )

    async def _request(
        self, method: str, path: str, *, content: bytes | None = None, json_body: Any = None
    ) -> httpx.Response:
        if self.http_client is None:
            raise DiffCaptureError("Bridge HTTP client is unavailable")
        response = await self.http_client.request(
            method,
            f"{self.control_plane_url.rstrip('/')}{path}",
            headers={
                "Authorization": f"Bearer {self.auth_token}",
                **(
                    {"Content-Type": "text/x-diff; charset=utf-8"}
                    if content is not None
                    else {"Content-Type": "application/json"}
                ),
            },
            content=content,
            json=json_body,
        )
        response.raise_for_status()
        return response

    async def _capture_and_finalize(self, command: dict[str, Any]) -> None:
        capture_id = str(command["captureId"])
        raw_limits = command["limits"]
        remaining_files = int(raw_limits["maxFiles"])
        remaining_capture_bytes = int(raw_limits["maxCaptureBytes"])
        max_patch_bytes = int(raw_limits["maxPatchBytes"])
        command_timeout_seconds = max(1.0, int(raw_limits["timeoutMs"]) / 1_000)
        repositories = load_repo_manifest(self.repo_manifest_path)
        baselines = command.get("baselines")
        if not isinstance(baselines, list) or len(baselines) != len(repositories):
            raise DiffCaptureError("Capture baselines do not match repository membership")

        outcomes: list[dict[str, Any]] = []
        for position, repository in enumerate(repositories):
            baseline = baselines[position]
            if not isinstance(baseline, dict):
                raise DiffCaptureError("Malformed capture baseline")
            expected = (
                position,
                repository.owner.lower(),
                repository.name.lower(),
                repository.base_sha,
            )
            received = (
                baseline.get("position"),
                str(baseline.get("repoOwner") or "").lower(),
                str(baseline.get("repoName") or "").lower(),
                baseline.get("baseSha"),
            )
            if received != expected or not repository.base_sha:
                raise DiffCaptureError("Capture baseline conflicts with the runtime manifest")

            try:
                capture = await collect_repository_diff(
                    repository,
                    repository.base_sha,
                    CaptureLimits(
                        max_files=remaining_files,
                        max_patch_bytes=max_patch_bytes,
                        max_capture_bytes=remaining_capture_bytes,
                        command_timeout_seconds=command_timeout_seconds,
                    ),
                )
                remaining_files = max(0, remaining_files - len(capture.files))
                remaining_capture_bytes = max(
                    0,
                    remaining_capture_bytes
                    - sum(
                        changed.patch_bytes or 0
                        for changed in capture.files
                        if changed.render_state == "renderable"
                    ),
                )
                files: list[dict[str, Any]] = []
                for changed in capture.files:
                    if changed.render_state == "renderable" and changed.patch is not None:
                        await self._request(
                            "PUT",
                            f"/sessions/{quote(self.session_id, safe='')}/diff-captures/"
                            f"{quote(capture_id, safe='')}/files/{quote(changed.id, safe='')}",
                            content=changed.patch.encode("utf-8"),
                        )
                    file_manifest: dict[str, Any] = {
                        "id": changed.id,
                        "path": changed.path,
                        "status": changed.status,
                        "additions": changed.additions,
                        "deletions": changed.deletions,
                        "renderState": changed.render_state,
                    }
                    optional_fields = {
                        "oldPath": changed.old_path,
                        "patchBytes": changed.patch_bytes,
                        "oldMode": changed.old_mode,
                        "newMode": changed.new_mode,
                        "oldSubmoduleSha": changed.old_submodule_sha,
                        "newSubmoduleSha": changed.new_submodule_sha,
                    }
                    file_manifest.update(
                        {key: value for key, value in optional_fields.items() if value is not None}
                    )
                    files.append(file_manifest)
                outcomes.append(
                    {
                        "position": position,
                        "repoOwner": repository.owner,
                        "repoName": repository.name,
                        "baseSha": repository.base_sha,
                        "headSha": capture.head_sha,
                        "truncated": capture.truncated,
                        "omittedFileCount": capture.omitted_file_count,
                        "files": files,
                    }
                )
            except Exception as error:
                outcomes.append(
                    {
                        "position": position,
                        "repoOwner": repository.owner,
                        "repoName": repository.name,
                        "baseSha": repository.base_sha,
                        "error": str(error)[:2_000],
                    }
                )

        await self._request(
            "POST",
            f"/sessions/{quote(self.session_id, safe='')}/diff-captures/"
            f"{quote(capture_id, safe='')}/complete",
            json_body={"repositories": outcomes},
        )
        self.log.info(
            "session_diff.capture_published",
            capture_id=capture_id,
            repository_count=len(outcomes),
        )
