#!/usr/bin/env python3
"""Build, verify and prune Boat base snapshots from the provider-neutral image bundle.

A build sandbox is created from Boat's stock Ubuntu image with none of the
account's secrets, the shared installation bundle is uploaded and installed in
it, the launcher is baked next to the runtime, and the sandbox's disk is saved
as a saved snapshot. A second sandbox then deploys from that name and runs the
image verification, exactly as a session sandbox will. Only the Boat REST API
is used, through the standard library.
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import shlex
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from http.client import HTTPResponse

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/sandbox-images/src"))

from sandbox_images.bundle import pack_bundle  # noqa: E402
from sandbox_images.native import write_build_result  # noqa: E402

DEFAULT_API_URL = "https://boat.dev/api/v1"
DEFAULT_BUILD_SANDBOX_TYPE = "default"

# Layout shared with the launcher and the control plane: the runtime lives
# under the home directory (which a Boat snapshot saves) and /app and
# /workspace link into it.
USER_HOME = "/home/user"
INSTALL_HOME = f"{USER_HOME}/openinspect"
LAUNCHER_PATH = f"{INSTALL_HOME}/launcher.sh"
LAUNCHER_UPLOAD_PATH = f"{USER_HOME}/openinspect-launcher.sh"
BUNDLE_UPLOAD_PATH = f"{USER_HOME}/openinspect-image.tar.gz"
BUNDLE_EXTRACT_DIR = "/tmp/openinspect-image"
INSTALL_SCRIPT = f"{BUNDLE_EXTRACT_DIR}/packages/sandbox-images/install/install.sh"
# A fresh Boat machine may still be running its own package maintenance; apt
# waits for the dpkg lock this long instead of failing the install outright.
APT_CONFIG_PATH = "/tmp/openinspect-apt.conf"
APT_LOCK_TIMEOUT_SECONDS = 600
VERIFY_COMMAND = "sudo /opt/openinspect/python/bin/python /app/verify/smoke_test.py verify"
# Boat's file API accepts at most this much per write.
MAX_FILE_WRITE_BYTES = 5 * 1024 * 1024

SNAPSHOT_NAME_PATTERN = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
READY_STATES = {"ready", "idle", "running"}
TERMINAL_STATES = {"error", "cancelled"}

POLL_SECONDS = 5
REQUEST_TIMEOUT_SECONDS = 60
# A create whose response was lost is repeated under the same idempotency key,
# so a retry never starts a second sandbox.
CREATE_ATTEMPTS = 3
CREATE_RETRY_DELAY_SECONDS = 5
READY_TIMEOUT_SECONDS = 300
PREPARE_TIMEOUT_SECONDS = 300
INSTALL_TIMEOUT_SECONDS = 45 * 60
VERIFY_TIMEOUT_SECONDS = 15 * 60
STOP_TIMEOUT_SECONDS = 10 * 60
SNAPSHOT_TIMEOUT_SECONDS = 30 * 60
BUILD_SANDBOX_TTL_SECONDS = 3 * 60 * 60
VERIFY_SANDBOX_TTL_SECONDS = 60 * 60
# Enough of each log to explain a failure; never a transcript.
LOG_TAIL_CHARS = 4000


class BoatApiError(RuntimeError):
    def __init__(self, status: int, code: str | None, message: str) -> None:
        super().__init__(f"Boat API {status} {code or 'error'}: {message}")
        self.status = status
        self.code = code


class RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: urllib would carry the bearer key to the new host."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


OPENER = urllib.request.build_opener(RefuseRedirects())


def validate_api_url(api_url: str) -> str:
    """Only HTTPS (or HTTP to a loopback stand-in) may carry the API key."""
    parsed = urllib.parse.urlsplit(api_url)
    loopback = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
    if not parsed.hostname or parsed.scheme not in {"https", "http"}:
        raise RuntimeError(f"BOAT_API_URL is not a valid URL: {api_url!r}")
    if parsed.scheme == "http" and not loopback:
        raise RuntimeError("BOAT_API_URL must use https (http is allowed for loopback only)")
    return api_url.rstrip("/")


def is_retryable_create_failure(error: Exception) -> bool:
    """A lost response or a server-side failure; the same key makes the repeat safe."""
    if isinstance(error, BoatApiError):
        return error.status >= 500 or error.code == "idempotency_in_progress"
    return isinstance(error, (urllib.error.URLError, TimeoutError, OSError))


class BoatApi:
    """The Boat calls used to build and maintain base snapshots."""

    def __init__(self, api_url: str, api_key: str, org: str | None = None) -> None:
        self.api_url = validate_api_url(api_url)
        self.api_key = api_key
        self.org = org
        # One key per create of this run: a repeat after a lost response gets
        # the same sandbox back, a later run never collides with a deleted one.
        self.run_id = uuid.uuid4().hex

    def request(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
        *,
        headers: dict[str, str] | None = None,
        timeout: int = REQUEST_TIMEOUT_SECONDS,
    ) -> dict[str, Any]:
        data = json.dumps(body).encode() if body is not None else None
        request_headers = {"Authorization": f"Bearer {self.api_key}", **(headers or {})}
        if data is not None:
            request_headers["Content-Type"] = "application/json"
        if self.org:
            request_headers["X-Boat-Org"] = self.org
        request = urllib.request.Request(
            f"{self.api_url}{path}", data=data, method=method, headers=request_headers
        )
        try:
            with OPENER.open(request, timeout=timeout) as response:
                payload = read_response(response)
        except urllib.error.HTTPError as error:
            raw = error.read()
            code = None
            message = error.reason if isinstance(error.reason, str) else str(error.reason)
            try:
                envelope = json.loads(raw)
                code = envelope.get("code")
                message = envelope.get("message") or message
            except (ValueError, AttributeError):
                pass
            raise BoatApiError(error.code, code, message) from None
        return json.loads(payload) if payload else {}

    def create_sandbox(self, purpose: str, body: dict[str, Any]) -> dict[str, Any]:
        """Create private, with none of the account's secrets, under one key per purpose and run."""
        key = f"openinspect-image-{purpose}-{self.run_id}"
        for attempt in range(1, CREATE_ATTEMPTS + 1):
            try:
                response = self.request(
                    "POST",
                    "/sandboxes",
                    {"noEnv": True, "snapshots": True, "visibility": "private", **body},
                    headers={"Idempotency-Key": key},
                )
                break
            except Exception as error:
                if attempt == CREATE_ATTEMPTS or not is_retryable_create_failure(error):
                    raise
                print(
                    f"Boat create ({purpose}) attempt {attempt} failed: {error}; retrying",
                    flush=True,
                )
                time.sleep(CREATE_RETRY_DELAY_SECONDS * attempt)
        sandbox = response["sandbox"]
        try:
            return self.ensure_private(sandbox)
        except Exception:
            # The sandbox exists and nothing will use it: do not leave it
            # running, and billing, until its TTL.
            try:
                self.delete_sandbox(sandbox["id"])
            except Exception as cleanup_error:
                print(
                    f"Boat sandbox {sandbox['id']} could not be deleted: {cleanup_error}",
                    flush=True,
                )
            raise

    def ensure_private(self, sandbox: dict[str, Any]) -> dict[str, Any]:
        """Nobody else may touch the image: unshare one that still reports itself shared.

        The create asks for a private sandbox, which Boat sets before the
        sandbox has a machine; this catches one Boat answered shared regardless.
        """
        if sandbox.get("visibility") != "shared":
            return sandbox
        updated = self.request("POST", f"/sandboxes/{sandbox['id']}/unshare")["sandbox"]
        if updated.get("visibility") != "private":
            raise RuntimeError(
                f"Boat sandbox {sandbox['id']} stayed {updated.get('visibility')} after unshare"
            )
        return updated

    def get_sandbox(self, sandbox_id: str) -> dict[str, Any]:
        return self.request("GET", f"/sandboxes/{sandbox_id}")["sandbox"]

    def wait_ready(self, sandbox_id: str, timeout: int = READY_TIMEOUT_SECONDS) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            sandbox = self.get_sandbox(sandbox_id)
            state = sandbox.get("state")
            if state in READY_STATES:
                return sandbox
            if state in TERMINAL_STATES:
                raise RuntimeError(
                    f"Boat sandbox {sandbox_id} entered {state}: {sandbox.get('error')}"
                )
            if time.monotonic() >= deadline:
                raise RuntimeError(
                    f"Boat sandbox {sandbox_id} not ready after {timeout}s ({state})"
                )
            time.sleep(POLL_SECONDS)

    def run(self, sandbox_id: str, command: str, timeout_seconds: int) -> dict[str, Any]:
        """Run `command` to completion and fail on a non-zero exit."""
        result = self.request(
            "POST",
            f"/sandboxes/{sandbox_id}/commands",
            {"command": command, "timeoutSeconds": timeout_seconds},
            timeout=timeout_seconds + REQUEST_TIMEOUT_SECONDS,
        )
        if result.get("timedOut") or result.get("exitCode") != 0:
            raise RuntimeError(
                f"Command failed in {sandbox_id} (exit {result.get('exitCode')}, "
                f"timedOut={result.get('timedOut')}): {command}\n"
                f"{tail(result.get('stdout'))}\n{tail(result.get('stderr'))}"
            )
        return result

    def run_detached(self, sandbox_id: str, command: str, timeout: int) -> None:
        """Start `command` in the background and wait for it, failing on a non-zero exit."""
        started = self.request(
            "POST", f"/sandboxes/{sandbox_id}/commands", {"command": command, "detached": True}
        )
        process_id = started["processId"]
        deadline = time.monotonic() + timeout
        while True:
            status = self.request(
                "GET", f"/sandboxes/{sandbox_id}/commands/{process_id}?tailBytes=8192"
            )
            if status.get("status") == "exited":
                if status.get("exitCode") != 0:
                    raise RuntimeError(
                        f"Command failed in {sandbox_id} (exit {status.get('exitCode')}): "
                        f"{command}\n{tail(status.get('stdout'))}\n{tail(status.get('stderr'))}"
                    )
                return
            if status.get("status") == "lost":
                raise RuntimeError(f"Boat lost track of the command in {sandbox_id}: {command}")
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Command did not finish within {timeout}s: {command}")
            time.sleep(POLL_SECONDS)

    def write_file(self, sandbox_id: str, path: str, content: bytes) -> None:
        if len(content) > MAX_FILE_WRITE_BYTES:
            raise RuntimeError(
                f"{path} is {len(content)} bytes; Boat writes at most {MAX_FILE_WRITE_BYTES}"
            )
        self.request(
            "PUT",
            f"/sandboxes/{sandbox_id}/files",
            {"path": path, "content": base64.b64encode(content).decode(), "encoding": "base64"},
            timeout=5 * 60,
        )

    def stop_and_wait(self, sandbox_id: str, timeout: int = STOP_TIMEOUT_SECONDS) -> None:
        self.request("POST", f"/sandboxes/{sandbox_id}/stop", {"force": False})
        deadline = time.monotonic() + timeout
        while True:
            sandbox = self.get_sandbox(sandbox_id)
            if sandbox.get("state") == "archived":
                if not sandbox.get("snapshotAvailable"):
                    raise RuntimeError(f"Boat archived {sandbox_id} without a snapshot")
                return
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Boat sandbox {sandbox_id} did not archive within {timeout}s")
            time.sleep(POLL_SECONDS)

    def delete_sandbox(self, sandbox_id: str) -> None:
        try:
            self.request(
                "DELETE", f"/sandboxes/{sandbox_id}", headers={"X-Ascii-Confirm-Delete": sandbox_id}
            )
        except BoatApiError as error:
            if error.status != 404:
                raise

    def get_saved_snapshot(self, name: str) -> dict[str, Any] | None:
        try:
            return self.request("GET", f"/saved-snapshots/{urllib.parse.quote(name)}")["snapshot"]
        except BoatApiError as error:
            if error.status == 404:
                return None
            raise

    def save_saved_snapshot(
        self, sandbox_id: str, name: str, timeout: int = SNAPSHOT_TIMEOUT_SECONDS
    ) -> dict[str, Any]:
        self.request("POST", "/saved-snapshots", {"sandboxId": sandbox_id, "name": name})
        return self.wait_saved_snapshot(name, timeout)

    def wait_saved_snapshot(
        self, name: str, timeout: int = SNAPSHOT_TIMEOUT_SECONDS
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        while True:
            snapshot = self.get_saved_snapshot(name)
            if snapshot is None:
                raise RuntimeError(f"Saved snapshot {name} disappeared while saving")
            if snapshot.get("status") == "ready":
                return snapshot
            if snapshot.get("status") == "failed":
                raise RuntimeError(f"Saved snapshot {name} failed: {snapshot.get('error')}")
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Saved snapshot {name} not ready after {timeout}s")
            time.sleep(POLL_SECONDS)


def read_response(response: HTTPResponse) -> bytes:
    return response.read()


def tail(text: Any) -> str:
    return str(text or "")[-LOG_TAIL_CHARS:]


def pack_archive(directory: Path) -> bytes:
    """A gzip tarball of the staged bundle, modes and symlinks preserved."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        archive.add(directory, arcname=".", recursive=True)
    return buffer.getvalue()


def prepare_command() -> str:
    """Lay out the home-anchored install tree and unpack the bundle (as `user`)."""
    return " && ".join(
        [
            f"mkdir -p {INSTALL_HOME}/app {USER_HOME}/workspace {BUNDLE_EXTRACT_DIR}",
            # The base image ships an empty root-owned /app; the runtime's
            # content must live under the home directory to be snapshotted.
            "if [ -d /app ] && [ ! -L /app ]; then sudo rmdir /app; fi",
            f"sudo ln -sfn {INSTALL_HOME}/app /app",
            f"sudo ln -sfn {USER_HOME}/workspace /workspace",
            f"tar -xzf {shlex.quote(BUNDLE_UPLOAD_PATH)} -C {BUNDLE_EXTRACT_DIR}",
            f"install -m 0755 {shlex.quote(LAUNCHER_UPLOAD_PATH)} {shlex.quote(LAUNCHER_PATH)}",
            f"printf 'DPkg::Lock::Timeout \"{APT_LOCK_TIMEOUT_SECONDS}\";\\n' > {APT_CONFIG_PATH}",
        ]
    )


def install_command() -> str:
    """Run the shared installer as root with the apt lock wait applied."""
    return f"sudo env APT_CONFIG={APT_CONFIG_PATH} bash {INSTALL_SCRIPT}"


def cleanup_command() -> str:
    """Remove build inputs so the snapshot holds only the installed image."""
    return " && ".join(
        [
            f"rm -rf {BUNDLE_EXTRACT_DIR} {APT_CONFIG_PATH} {shlex.quote(BUNDLE_UPLOAD_PATH)} {shlex.quote(LAUNCHER_UPLOAD_PATH)}",
            # Never bake a first-boot marker: a deploy from the snapshot is a fresh boot.
            f"rm -rf {USER_HOME}/.openinspect",
            "sudo rm -rf /root/.npm /root/.cache",
        ]
    )


def validate_base_prefix(prefix: str) -> None:
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,45}", prefix):
        raise RuntimeError("BOAT_BASE_SNAPSHOT must be 1-46 lowercase letters, digits or dashes")
    if prefix == "oi-img" or prefix.startswith("oi-img-"):
        raise RuntimeError("The oi-img namespace is reserved for prebuilt images")


def candidate_name(prefix: str, build_hash: str) -> str:
    validate_base_prefix(prefix)
    name = (
        os.environ.get("OPENINSPECT_IMAGE_CANDIDATE")
        or f"{prefix}-{build_hash[:12]}-{time.time_ns()}"
    )
    if not SNAPSHOT_NAME_PATTERN.fullmatch(name):
        raise RuntimeError(
            f"Boat saved snapshot name {name!r} must be 1-63 lowercase letters, digits or dashes; "
            "shorten BOAT_BASE_SNAPSHOT"
        )
    if name == "oi-img" or name.startswith("oi-img-"):
        raise RuntimeError("The oi-img namespace is reserved for prebuilt images")
    return name


def build_snapshot(api: BoatApi, name: str, bundle_directory: Path, build_type: str) -> None:
    archive = pack_archive(bundle_directory)
    launcher = (Path(__file__).resolve().parent / "launcher.sh").read_bytes()
    sandbox = api.create_sandbox(
        "build", {"type": build_type, "ttlSeconds": BUILD_SANDBOX_TTL_SECONDS}
    )
    sandbox_id = sandbox["id"]
    print(f"Boat image build sandbox {sandbox_id} ({build_type})", flush=True)
    try:
        api.wait_ready(sandbox_id)
        api.write_file(sandbox_id, BUNDLE_UPLOAD_PATH, archive)
        api.write_file(sandbox_id, LAUNCHER_UPLOAD_PATH, launcher)
        api.run(sandbox_id, prepare_command(), PREPARE_TIMEOUT_SECONDS)
        api.run_detached(sandbox_id, install_command(), INSTALL_TIMEOUT_SECONDS)
        api.run(sandbox_id, cleanup_command(), PREPARE_TIMEOUT_SECONDS)
        # Archive first so the saved disk is quiescent, then freeze it under the name.
        api.stop_and_wait(sandbox_id)
        api.save_saved_snapshot(sandbox_id, name)
        print(f"Boat saved snapshot {name} saved", flush=True)
    finally:
        api.delete_sandbox(sandbox_id)


def verify_snapshot(api: BoatApi, name: str) -> None:
    """A fresh deploy both verifies the final artifact and exercises the launcher's preparation."""
    sandbox = api.create_sandbox("verify", {"from": name, "ttlSeconds": VERIFY_SANDBOX_TTL_SECONDS})
    sandbox_id = sandbox["id"]
    print(f"Boat image verification sandbox {sandbox_id}", flush=True)
    try:
        api.wait_ready(sandbox_id)
        api.run(
            sandbox_id, f"bash {shlex.quote(LAUNCHER_PATH)} --prepare-only", PREPARE_TIMEOUT_SECONDS
        )
        api.run_detached(sandbox_id, VERIFY_COMMAND, VERIFY_TIMEOUT_SECONDS)
    except Exception as error:
        raise RuntimeError(f"Boat image verification failed: {error}") from error
    finally:
        api.delete_sandbox(sandbox_id)


def print_snapshot_allowance(phase: str, inventory: dict[str, Any]) -> None:
    allowance = inventory.get("allowance") or {}
    print(
        f"Boat snapshot allowance {phase}: "
        f"used/included={allowance.get('used', 'unknown')}/{allowance.get('included', 'unknown')}, "
        f"extraMonthlyDollars={allowance.get('extraMonthlyDollars', 'unknown')}",
        flush=True,
    )


def prune_snapshots(
    api: BoatApi, prefix: str, deployed: str, replaced: str, *, dry_run: bool
) -> None:
    """Retain the deployed base and the explicit predecessor supplied by the deployer."""
    validate_base_prefix(prefix)
    if replaced and replaced == deployed:
        raise RuntimeError(
            "BOAT_REPLACED_SNAPSHOT must differ from BOAT_DEPLOYED_SNAPSHOT. Nothing was deleted."
        )
    inventory = api.request("GET", "/saved-snapshots")
    pattern = re.compile(rf"{re.escape(prefix)}-[0-9a-f]{{16}}")
    candidates = [
        snapshot for snapshot in inventory["snapshots"] if pattern.fullmatch(snapshot["name"])
    ]
    if not any(
        snapshot["name"] == deployed and snapshot["status"] == "ready" for snapshot in candidates
    ):
        raise RuntimeError(
            "BOAT_DEPLOYED_SNAPSHOT must name a ready Terraform base under BOAT_BASE_SNAPSHOT; "
            "check the prefix, wallet and organization. Nothing was deleted."
        )

    kept = {deployed}
    if replaced:
        if not any(
            snapshot["name"] == replaced and snapshot["status"] == "ready"
            for snapshot in candidates
        ):
            raise RuntimeError(
                "BOAT_REPLACED_SNAPSHOT must name a ready Terraform base under BOAT_BASE_SNAPSHOT. "
                "Nothing was deleted."
            )
        kept.add(replaced)

    print_snapshot_allowance("before", inventory)
    for snapshot in candidates:
        name = snapshot["name"]
        if name in kept:
            reason = "deployed" if name == deployed else "rollback"
            print(f"Keep {name} ({reason})", flush=True)
        elif snapshot["status"] not in {"ready", "failed"}:
            print(f"Keep {name} (status {snapshot['status']})", flush=True)
        elif dry_run:
            print(f"Would delete {name}", flush=True)
        else:
            try:
                api.request("DELETE", f"/saved-snapshots/{urllib.parse.quote(name, safe='')}")
            except BoatApiError as error:
                if error.status != 404:
                    raise
                print(f"Already absent {name}", flush=True)
            else:
                print(f"Deleted {name}", flush=True)
    print_snapshot_allowance(
        "after (dry-run, unchanged)" if dry_run else "after",
        api.request("GET", "/saved-snapshots"),
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command")
    prune = commands.add_parser("prune", help="Delete superseded Terraform base snapshots")
    prune.add_argument("--dry-run", action="store_true", help="Preview without deleting snapshots")
    args = parser.parse_args(argv)
    api_key = os.environ.get("BOAT_API_KEY")
    prefix = os.environ.get("BOAT_BASE_SNAPSHOT")
    if not api_key or not prefix:
        raise RuntimeError("BOAT_BASE_SNAPSHOT and BOAT_API_KEY are required")
    validate_base_prefix(prefix)
    api = BoatApi(
        os.environ.get("BOAT_API_URL") or DEFAULT_API_URL,
        api_key,
        os.environ.get("BOAT_ORG") or None,
    )
    if args.command == "prune":
        deployed = os.environ.get("BOAT_DEPLOYED_SNAPSHOT")
        if not deployed:
            raise RuntimeError("BOAT_DEPLOYED_SNAPSHOT is required for prune")
        replaced = os.environ.get("BOAT_REPLACED_SNAPSHOT")
        if replaced is None:
            raise RuntimeError(
                "BOAT_REPLACED_SNAPSHOT is required for prune; "
                "use an empty value only when there is no previous base in this prefix and wallet"
            )
        try:
            prune_snapshots(api, prefix, deployed, replaced, dry_run=args.dry_run)
        except BoatApiError as error:
            # Provider messages may echo credentials; report only the HTTP status.
            raise RuntimeError(f"Boat snapshot prune failed: API {error.status}") from None
        return

    build_type = os.environ.get("BOAT_BUILD_SANDBOX_TYPE") or DEFAULT_BUILD_SANDBOX_TYPE
    bundle = pack_bundle(ROOT, "boat", ROOT / ".cache/sandbox-images")
    name = candidate_name(prefix, bundle.plan["buildHash"])

    existing = api.get_saved_snapshot(name)
    if existing is not None and existing.get("status") == "saving":
        existing = api.wait_saved_snapshot(name)
    if existing is None:
        build_snapshot(api, name, bundle.directory, build_type)
    elif existing.get("status") == "ready":
        # A retry re-verifies the retained artifact instead of rebuilding it.
        print(f"Boat saved snapshot {name} already exists; verifying it", flush=True)
    else:
        # A failed save keeps its name, and the name is fixed by the inputs: a
        # build under it would run the whole install and then fail at the save.
        # Stop before anything is billed; the artifact is the operator's to
        # remove.
        raise RuntimeError(
            f"Boat saved snapshot {name} exists with status {existing.get('status')!r}; "
            "delete it before rebuilding"
        )
    verify_snapshot(api, name)
    write_build_result(name)


if __name__ == "__main__":
    main()
