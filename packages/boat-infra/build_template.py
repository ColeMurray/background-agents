#!/usr/bin/env python3
"""Build, verify, and retain Boat named snapshots for Open-Inspect."""

from __future__ import annotations

import argparse
import base64
import os
import re
import shutil
import sys
import tarfile
import tempfile
import time
import urllib.request
import uuid
from dataclasses import dataclass
from http.cookiejar import CookieJar
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol
from urllib.parse import urlsplit, urlunsplit

if TYPE_CHECKING:
    from collections.abc import Callable

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/sandbox-images/src"))

from sandbox_images.bundle import PackedBundle, pack_bundle  # noqa: E402
from sandbox_images.native import write_build_result  # noqa: E402

DEFAULT_API_URL = "https://boat.dev/api/v1"
DEFAULT_TEMPLATE_PREFIX = "openinspect-boat"
DEFAULT_SANDBOX_TYPE = "default"
BUILD_TTL_SECONDS = 3600
STATE_POLL_SECONDS = 2
START_TIMEOUT_SECONDS = 300
COMMAND_TIMEOUT_SECONDS = 1800
SNAPSHOT_TIMEOUT_SECONDS = 600
MAX_NAMED_SNAPSHOTS = 10
VERIFY_PORT = 43123

INSTALL_COMMAND = " && ".join(
    (
        "sudo rm -rf /tmp/openinspect-image",
        "sudo mkdir -p /tmp/openinspect-image",
        "sudo tar -xzf /tmp/openinspect-image.tar.gz -C /tmp/openinspect-image",
        "cd /tmp/openinspect-image",
        "sudo bash packages/sandbox-images/install/install.sh",
        "sudo jq '.args = \"--no-sandbox\"' /home/user/.agent-browser/config.json > /tmp/agent-browser.json",
        "sudo install -o user -g user -m 0644 /tmp/agent-browser.json /home/user/.agent-browser/config.json",
        "sudo chmod -R a+rX /app",
        "sudo install -d -o user -g user /home/user/openinspect/workspace",
        "sudo rm -rf /home/user/openinspect/app",
        "sudo cp -aL /app /home/user/openinspect/app",
        "sudo chown -R user:user /home/user/openinspect/app",
        "sudo rm -rf /workspace",
        "sudo ln -s /home/user/openinspect/workspace /workspace",
        "sudo install -o user -g user -m 0755 packages/boat-infra/runtime-launcher.sh /home/user/openinspect/start-runtime",
        "sudo chown -R user:user /home/user/.ascii",
    )
)

VERIFY_COMMAND = " && ".join(
    (
        "/home/user/openinspect/start-runtime --prepare-only",
        "/opt/openinspect/python/bin/python /app/verify/smoke_test.py verify",
        'test "$(readlink /workspace)" = /home/user/openinspect/workspace',
        "test -w /home/user/openinspect/workspace",
    )
)

WEBSOCKET_SERVER_COMMAND = (
    'bun -e \'Bun.serve({port:43123,hostname:"0.0.0.0",'
    'fetch(req,server){if(server.upgrade(req))return;return new Response("boat-http-ok")},'
    "websocket:{message(ws,msg){ws.send(msg)}}});await new Promise(()=>{})'"
)


@dataclass(frozen=True)
class SandboxInfo:
    id: str
    state: str
    snapshot_available: bool = False


@dataclass(frozen=True)
class SnapshotInfo:
    name: str
    status: str
    created_at: str
    error: str | None = None


@dataclass(frozen=True)
class CommandStatus:
    status: str
    running: bool
    exit_code: int | None
    stdout: str
    stderr: str


def command_failure_detail(status: CommandStatus) -> str:
    output = status.stderr or status.stdout
    if len(output) <= 6000:
        return output
    return f"{output[:2000]}\n... provider output truncated ...\n{output[-4000:]}"


class BoatBuildClient(Protocol):
    def create_sandbox(
        self,
        *,
        sandbox_type: str,
        ttl_seconds: int,
        environment: dict[str, str] | None = None,
        snapshot: str | None = None,
    ) -> SandboxInfo: ...

    def get_sandbox(self, sandbox_id: str) -> SandboxInfo: ...

    def write_base64(self, sandbox_id: str, path: str, content: str) -> None: ...

    def start_command(self, sandbox_id: str, command: str) -> int: ...

    def command_status(self, sandbox_id: str, process_id: int) -> CommandStatus: ...

    def run_command(self, sandbox_id: str, command: str, timeout_seconds: int) -> CommandStatus: ...

    def save_named_snapshot(self, sandbox_id: str, name: str) -> None: ...

    def list_named_snapshots(self) -> list[SnapshotInfo]: ...

    def get_named_snapshot(self, name: str) -> SnapshotInfo: ...

    def delete_named_snapshot(self, name: str) -> None: ...

    def host_port(self, sandbox_id: str, port: int) -> str: ...

    def stop_sandbox(self, sandbox_id: str) -> None: ...

    def delete_sandbox(self, sandbox_id: str) -> None: ...

    def close(self) -> None: ...


class SdkBoatBuildClient:
    """Narrow adapter over the generated SDK; the build workflow tests a fake."""

    def __init__(self, api_key: str, api_url: str, org: str | None) -> None:
        from boat_sdk import ApiClient, Configuration
        from boat_sdk.api.boat_api import BoatApi

        configuration = Configuration(host=api_url, access_token=api_key)
        self._api_client = ApiClient(configuration).__enter__()
        self._api = BoatApi(self._api_client)
        self._org = org

    def create_sandbox(
        self,
        *,
        sandbox_type: str,
        ttl_seconds: int,
        environment: dict[str, str] | None = None,
        snapshot: str | None = None,
    ) -> SandboxInfo:
        from boat_sdk.models.create_sandbox_request import CreateSandboxRequest

        request = CreateSandboxRequest(
            type=sandbox_type,
            ttlSeconds=ttl_seconds,
            env=environment or {},
            noEnv=True,
            var_from=snapshot,
        )
        response = self._api.create(
            idempotency_key=str(uuid.uuid4()),
            org=self._org,
            create_sandbox_request=request,
            _request_timeout=90,
        )
        return SandboxInfo(
            id=response.sandbox.id,
            state=response.sandbox.state,
            snapshot_available=response.sandbox.snapshot_available,
        )

    def get_sandbox(self, sandbox_id: str) -> SandboxInfo:
        response = self._api.get(sandbox_id, _request_timeout=30)
        return SandboxInfo(
            id=response.sandbox.id,
            state=response.sandbox.state,
            snapshot_available=response.sandbox.snapshot_available,
        )

    def write_base64(self, sandbox_id: str, path: str, content: str) -> None:
        from boat_sdk.models.file_write_request import FileWriteRequest

        self._api.write_file(
            sandbox_id,
            FileWriteRequest(path=path, content=content, encoding="base64"),
            _request_timeout=120,
        )

    def start_command(self, sandbox_id: str, command: str) -> int:
        from boat_sdk.models.command_request import CommandRequest

        response = self._api.command(
            sandbox_id,
            CommandRequest(command=command, detached=True),
            _request_timeout=30,
        )
        started = response.actual_instance
        process_id = getattr(started, "process_id", None)
        if not isinstance(process_id, int):
            raise RuntimeError("Boat detached command did not return a process id")
        return process_id

    def command_status(self, sandbox_id: str, process_id: int) -> CommandStatus:
        response = self._api.command_status(
            sandbox_id, process_id, tail_bytes=524288, _request_timeout=30
        )
        return CommandStatus(
            status=response.status,
            running=response.running,
            exit_code=response.exit_code,
            stdout=response.stdout,
            stderr=response.stderr,
        )

    def run_command(self, sandbox_id: str, command: str, timeout_seconds: int) -> CommandStatus:
        from boat_sdk.models.command_request import CommandRequest

        response = self._api.command(
            sandbox_id,
            CommandRequest(command=command, timeoutSeconds=timeout_seconds),
            _request_timeout=timeout_seconds + 30,
        ).actual_instance
        return CommandStatus(
            status="exited",
            running=False,
            exit_code=response.exit_code,
            stdout=response.stdout,
            stderr=response.stderr,
        )

    def save_named_snapshot(self, sandbox_id: str, name: str) -> None:
        from boat_sdk.models.named_snapshot_save_request import NamedSnapshotSaveRequest

        self._api.save_named_snapshot(
            NamedSnapshotSaveRequest(sandboxId=sandbox_id, name=name), _request_timeout=60
        )

    def list_named_snapshots(self) -> list[SnapshotInfo]:
        response = self._api.list_named_snapshots(_request_timeout=30)
        return [self._snapshot_info(snapshot) for snapshot in response.snapshots]

    def get_named_snapshot(self, name: str) -> SnapshotInfo:
        response = self._api.get_named_snapshot(name, _request_timeout=30)
        return self._snapshot_info(response.snapshot)

    def delete_named_snapshot(self, name: str) -> None:
        self._retry_provider_mutation(
            lambda: self._api.delete_named_snapshot(name, _request_timeout=30)
        )

    def host_port(self, sandbox_id: str, port: int) -> str:
        from boat_sdk.models.host_port_request import HostPortRequest

        response = self._api.host_port(
            sandbox_id,
            HostPortRequest(port=port, public=False),
            _request_timeout=30,
        )
        if not response.is_protected or response.access != "private":
            raise RuntimeError("Boat verification route was not private")
        return response.url

    def stop_sandbox(self, sandbox_id: str) -> None:
        from boat_sdk.models.stop_request import StopRequest

        self._api.stop(sandbox_id, StopRequest(force=False), _request_timeout=60)

    def delete_sandbox(self, sandbox_id: str) -> None:
        try:
            response = self._retry_provider_mutation(
                lambda: self._api.delete_sandbox(
                    x_ascii_confirm_delete=sandbox_id,
                    sandbox_id=sandbox_id,
                    _request_timeout=30,
                )
            )
        except Exception as error:
            if getattr(error, "status", None) == 404:
                return
            raise
        if response is None:
            return
        try:
            for _ in range(15):
                operation = self._api.get_deletion_operation(
                    response.operation.id, _request_timeout=30
                ).operation
                if operation.status in {"blocked", "completed"}:
                    return
                time.sleep(STATE_POLL_SECONDS)
        except Exception as error:
            print(
                f"Boat physical deletion observation unavailable for {sandbox_id}: {error}",
                file=sys.stderr,
            )

    @staticmethod
    def _retry_provider_mutation(operation: Callable[[], Any]) -> Any:
        for attempt in range(1, 4):
            try:
                return operation()
            except Exception as error:
                status = getattr(error, "status", None)
                if status == 404:
                    return None
                if not isinstance(status, int) or status < 500 or attempt == 3:
                    raise
                time.sleep(STATE_POLL_SECONDS * attempt)
        raise AssertionError("unreachable")

    def close(self) -> None:
        self._api_client.__exit__(None, None, None)

    @staticmethod
    def _snapshot_info(snapshot: Any) -> SnapshotInfo:
        created_at = snapshot.created_at
        return SnapshotInfo(
            name=str(snapshot.name),
            status=str(snapshot.status),
            created_at=created_at.isoformat()
            if hasattr(created_at, "isoformat")
            else str(created_at),
            error=getattr(snapshot, "error", None),
        )


def wait_for_sandbox(client: BoatBuildClient, sandbox_id: str) -> SandboxInfo:
    deadline = time.monotonic() + START_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        sandbox = client.get_sandbox(sandbox_id)
        if sandbox.state in {"ready", "idle"}:
            return sandbox
        if sandbox.state == "error":
            raise RuntimeError("Boat build sandbox entered the error state")
        time.sleep(STATE_POLL_SECONDS)
    raise RuntimeError("Boat build sandbox did not become ready")


def stop_and_verify_sandbox(client: BoatBuildClient, sandbox_id: str) -> SandboxInfo:
    client.stop_sandbox(sandbox_id)
    deadline = time.monotonic() + SNAPSHOT_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        sandbox = client.get_sandbox(sandbox_id)
        if sandbox.state in {"stopped", "archived"}:
            if not sandbox.snapshot_available:
                raise RuntimeError("Boat source stopped without a verified snapshot")
            return sandbox
        if sandbox.state == "error":
            raise RuntimeError("Boat source entered the error state while stopping")
        time.sleep(STATE_POLL_SECONDS)
    raise RuntimeError("Boat source did not stop with a verified snapshot")


def wait_for_command(
    client: BoatBuildClient,
    sandbox_id: str,
    process_id: int,
    *,
    failure_context: str = "image install",
) -> CommandStatus:
    deadline = time.monotonic() + COMMAND_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        status = client.command_status(sandbox_id, process_id)
        if not status.running:
            if status.exit_code != 0:
                raise RuntimeError(
                    f"Boat {failure_context} failed (exit {status.exit_code}): {command_failure_detail(status)}"
                )
            return status
        time.sleep(STATE_POLL_SECONDS)
    raise RuntimeError("Boat image install timed out")


def wait_for_snapshot(client: BoatBuildClient, name: str) -> SnapshotInfo:
    deadline = time.monotonic() + SNAPSHOT_TIMEOUT_SECONDS
    while time.monotonic() < deadline:
        snapshot = client.get_named_snapshot(name)
        if snapshot.status == "ready":
            return snapshot
        if snapshot.status == "failed":
            raise RuntimeError(f"Boat named snapshot failed: {snapshot.error or 'unknown error'}")
        time.sleep(STATE_POLL_SECONDS)
    raise RuntimeError("Boat named snapshot did not become ready")


def archive_bundle(bundle: PackedBundle) -> str:
    with tempfile.NamedTemporaryFile(suffix=".tar.gz") as archive:
        with tarfile.open(archive.name, "w:gz") as tar:
            for path in sorted(bundle.directory.rglob("*")):
                tar.add(path, arcname=path.relative_to(bundle.directory), recursive=False)
        return base64.b64encode(Path(archive.name).read_bytes()).decode()


def verify_hosted_websocket(client: BoatBuildClient, sandbox_id: str) -> None:
    from websockets.sync.client import connect

    client.start_command(sandbox_id, WEBSOCKET_SERVER_COMMAND)
    url = client.host_port(sandbox_id, VERIFY_PORT)
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    deadline = time.monotonic() + 60
    while True:
        try:
            with opener.open(url, timeout=5) as response:
                if response.read() != b"boat-http-ok":
                    raise RuntimeError("Boat hosted HTTP probe returned unexpected content")
            break
        except OSError:
            if time.monotonic() >= deadline:
                raise RuntimeError("Boat hosted HTTP route did not become ready")
            time.sleep(STATE_POLL_SECONDS)

    parsed = urlsplit(url)
    ws_url = urlunsplit(("wss", parsed.netloc, parsed.path, parsed.query, ""))
    with connect(ws_url, open_timeout=10, close_timeout=2) as websocket:
        websocket.send("boat-websocket-ok")
        if websocket.recv(timeout=10) != "boat-websocket-ok":
            raise RuntimeError("Boat hosted WebSocket probe did not echo")


def managed_snapshot_candidates(
    snapshots: list[SnapshotInfo], prefix: str, protected: set[str]
) -> list[SnapshotInfo]:
    managed = [snapshot for snapshot in snapshots if snapshot.name.startswith(f"{prefix}-")]
    newest = max(managed, key=lambda snapshot: snapshot.created_at, default=None)
    if newest:
        protected.add(newest.name)
    return sorted(
        (snapshot for snapshot in managed if snapshot.name not in protected),
        key=lambda snapshot: snapshot.created_at,
    )


def ensure_snapshot_capacity(
    client: BoatBuildClient, *, prefix: str, candidate: str, protected: set[str]
) -> None:
    snapshots = client.list_named_snapshots()
    if any(snapshot.name == candidate for snapshot in snapshots):
        return
    removable = managed_snapshot_candidates(snapshots, prefix, protected | {candidate})
    while len(snapshots) >= MAX_NAMED_SNAPSHOTS and removable:
        snapshot = removable.pop(0)
        client.delete_named_snapshot(snapshot.name)
        snapshots = [current for current in snapshots if current.name != snapshot.name]
    if len(snapshots) >= MAX_NAMED_SNAPSHOTS:
        raise RuntimeError(
            "Boat named-snapshot limit reached and no deployment-owned snapshot is safe to remove"
        )


def cleanup_snapshots(client: BoatBuildClient, *, prefix: str, keep: set[str]) -> None:
    snapshots = client.list_named_snapshots()
    managed = [snapshot for snapshot in snapshots if snapshot.name.startswith(f"{prefix}-")]
    effective_keep = set(keep)
    if len({snapshot.name for snapshot in managed if snapshot.name in effective_keep}) < 2:
        previous = max(
            (snapshot for snapshot in managed if snapshot.name not in effective_keep),
            key=lambda snapshot: snapshot.created_at,
            default=None,
        )
        if previous:
            effective_keep.add(previous.name)
    for snapshot in managed:
        if snapshot.name not in effective_keep:
            client.delete_named_snapshot(snapshot.name)


def candidate_name(prefix: str, build_hash: str) -> str:
    candidate = os.environ.get("OPENINSPECT_IMAGE_CANDIDATE") or f"{prefix}-{build_hash[:16]}"
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", candidate):
        raise ValueError("Boat named snapshot must be 1-63 lowercase letters, digits, or dashes")
    return candidate


def build_template(
    client: BoatBuildClient,
    bundle: PackedBundle,
    prefix: str,
    *,
    verify_host: Callable[[BoatBuildClient, str], None] = verify_hosted_websocket,
) -> str:
    candidate = candidate_name(prefix, bundle.plan["buildHash"])
    protected = {value for value in (os.environ.get("BOAT_PROTECTED_SNAPSHOT"),) if value}
    ensure_snapshot_capacity(client, prefix=prefix, candidate=candidate, protected=protected)

    existing = next(
        (snapshot for snapshot in client.list_named_snapshots() if snapshot.name == candidate), None
    )
    if existing and existing.status == "saving":
        existing = wait_for_snapshot(client, candidate)
    if existing and existing.status == "failed":
        client.delete_named_snapshot(candidate)
        existing = None

    source_id: str | None = None
    verifier_id: str | None = None
    created_candidate = False
    try:
        if not existing:
            source = client.create_sandbox(
                sandbox_type=os.environ.get("BOAT_TEMPLATE_SANDBOX_TYPE", DEFAULT_SANDBOX_TYPE),
                ttl_seconds=BUILD_TTL_SECONDS,
            )
            source_id = source.id
            wait_for_sandbox(client, source.id)
            client.write_base64(source.id, "/tmp/openinspect-image.tar.gz", archive_bundle(bundle))
            wait_for_command(client, source.id, client.start_command(source.id, INSTALL_COMMAND))
            install_probe = client.run_command(
                source.id,
                "/opt/openinspect/python/bin/python /app/verify/smoke_test.py install",
                300,
            )
            if install_probe.exit_code != 0:
                raise RuntimeError(
                    f"Boat install verification failed: {command_failure_detail(install_probe)}"
                )
            stop_and_verify_sandbox(client, source.id)
            created_candidate = True
            client.save_named_snapshot(source.id, candidate)
            wait_for_snapshot(client, candidate)

        verifier = client.create_sandbox(
            sandbox_type=os.environ.get("BOAT_TEMPLATE_SANDBOX_TYPE", DEFAULT_SANDBOX_TYPE),
            ttl_seconds=BUILD_TTL_SECONDS,
            environment=bundle.plan["runtimeEnv"],
            snapshot=candidate,
        )
        verifier_id = verifier.id
        wait_for_sandbox(client, verifier.id)
        wait_for_command(
            client,
            verifier.id,
            client.start_command(verifier.id, VERIFY_COMMAND),
            failure_context="image verification",
        )
        verify_host(client, verifier.id)
        return candidate
    except BaseException:
        if created_candidate:
            try:
                client.delete_named_snapshot(candidate)
            except Exception as error:
                print(f"Boat candidate cleanup failed for {candidate}: {error}", file=sys.stderr)
        raise
    finally:
        for sandbox_id in (verifier_id, source_id):
            if sandbox_id:
                try:
                    client.delete_sandbox(sandbox_id)
                except Exception as error:
                    print(
                        f"Boat temporary sandbox cleanup failed for {sandbox_id}: {error}",
                        file=sys.stderr,
                    )


def load_client() -> SdkBoatBuildClient:
    api_key = os.environ.get("BOAT_BUILD_API_KEY") or os.environ.get("BOAT_API_KEY")
    if not api_key:
        raise RuntimeError("BOAT_BUILD_API_KEY or BOAT_API_KEY is required")
    api_url = os.environ.get("BOAT_API_URL", DEFAULT_API_URL)
    parsed = urlsplit(api_url)
    if parsed.scheme != "https" and not (
        parsed.scheme == "http" and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    ):
        raise ValueError("BOAT_API_URL must use HTTPS except for loopback development URLs")
    return SdkBoatBuildClient(api_key, api_url, os.environ.get("BOAT_ORG") or None)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cleanup", action="store_true")
    parser.add_argument("--keep", action="append", default=[])
    args = parser.parse_args()
    prefix = os.environ.get("BOAT_TEMPLATE_PREFIX", DEFAULT_TEMPLATE_PREFIX)
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,45}", prefix):
        raise ValueError("BOAT_TEMPLATE_PREFIX must be 1-46 lowercase letters, digits, or dashes")

    client = load_client()
    try:
        if args.cleanup:
            cleanup_snapshots(client, prefix=prefix, keep=set(args.keep))
            return
        bundle = pack_bundle(ROOT, "boat", ROOT / ".cache/sandbox-images")
        try:
            write_build_result(build_template(client, bundle, prefix))
        finally:
            shutil.rmtree(bundle.directory, ignore_errors=True)
    finally:
        client.close()


if __name__ == "__main__":
    main()
