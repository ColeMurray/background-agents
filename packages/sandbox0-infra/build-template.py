#!/usr/bin/env python3
"""Build a verified Sandbox0 RootFS template using the shared image recipe.

Only disposable builder/probe sandboxes are deleted. Existing templates are
never overwritten. The API key stays on the build host, outside the guest.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/sandbox-images/src"))
from sandbox_images.bundle import pack_bundle  # noqa: E402
from sandbox_images.native import write_build_result  # noqa: E402


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Sandbox0 API redirects are not allowed")


class Client:
    def __init__(self):
        self.key = os.environ["SANDBOX0_API_KEY"]
        self.url = os.environ.get("SANDBOX0_API_URL", "https://api.sandbox0.ai").rstrip("/")
        url = urllib.parse.urlparse(self.url)
        if (
            url.username
            or url.password
            or url.query
            or url.fragment
            or not (
                url.scheme == "https"
                or (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1"))
            )
        ):
            raise ValueError("SANDBOX0_API_URL must use HTTPS (or loopback HTTP)")
        self.http = urllib.request.build_opener(NoRedirect())

    def request(self, method, path, body=None):
        binary = isinstance(body, bytes)
        data = body if binary else json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(
            self.url + path,
            method=method,
            data=data,
            headers={
                "Authorization": f"Bearer {self.key}",
                "User-Agent": "openinspect-sandbox0/1.0",
                "Content-Type": "application/octet-stream" if binary else "application/json",
            },
        )
        for attempt in range(6):
            try:
                with self.http.open(request, timeout=120) as response:
                    return json.load(response)["data"]
            except urllib.error.HTTPError as error:
                if (
                    method in ("GET", "DELETE")
                    and error.code in (429, 502, 503, 504)
                    and attempt < 5
                ):
                    time.sleep(min(2**attempt, 10))
                    continue
                # Never expose response bodies, headers or credentials in build logs.
                raise RuntimeError(f"Sandbox0 {method} {path}: HTTP {error.code}") from None

    def create(self, template):
        return self.request(
            "POST",
            "/api/v1/sandboxes",
            {
                "template": template,
                "config": {
                    "ttl": 3600,
                    "hard_ttl": 7200,
                    "auto_resume": False,
                    "resources": {"memory": "4Gi"},
                },
            },
        )["sandbox_id"]

    def command(self, sandbox, command, timeout=1800):
        path = f"/api/v1/sandboxes/{sandbox}/contexts"
        context = self.request(
            "POST",
            path,
            {
                "type": "cmd",
                "cmd": {"command": command},
                "wait_until_done": False,
                "ttl_sec": timeout,
            },
        )
        deadline = time.monotonic() + timeout + 30
        while context["running"]:
            if time.monotonic() >= deadline:
                raise TimeoutError("Sandbox0 build command timed out")
            time.sleep(5)
            context = self.request("GET", f"{path}/{context['id']}")
        if context.get("exit_code") != 0:
            raise RuntimeError(f"Sandbox0 build command failed: {context.get('exit_code')}")

    def delete(self, sandbox):
        self.request("DELETE", f"/api/v1/sandboxes/{sandbox}")

    def pause(self, sandbox):
        path = f"/api/v1/sandboxes/{sandbox}"
        result = self.request("POST", f"{path}/pause")
        deadline = time.monotonic() + 180
        while not result.get("paused"):
            if time.monotonic() >= deadline:
                raise TimeoutError("Sandbox0 builder pause did not finish")
            time.sleep(2)
            result = self.request("GET", path)


def main():
    client = Client()
    resources = []
    with tempfile.TemporaryDirectory(prefix="openinspect-sandbox0-") as directory:
        packed = pack_bundle(ROOT, "sandbox0", Path(directory))
        candidate = os.environ.get("OPENINSPECT_IMAGE_CANDIDATE")
        retained = bool(candidate)
        candidate = (
            candidate or f"openinspect-{packed.plan['buildHash'][:12]}-{uuid.uuid4().hex[:8]}"
        )
        capture_pending = False
        builder = None
        try:
            if not retained:
                builder = client.create(packed.plan["target"]["base"])
                resources.append(builder)
                print(f"Building {candidate} in {builder}", flush=True)
                # Baked launcher reports this artifact's version, not the Worker's version.
                launcher = (
                    "#!/bin/sh\n"
                    + "\n".join(
                        f"export {key}={shlex.quote(value)}"
                        for key, value in (
                            packed.plan["runtimeEnv"]
                            | {
                                "SANDBOX_VERSION": packed.plan["runtimeVersion"],
                            }
                        ).items()
                    )
                    + '\nexec /opt/openinspect/python/bin/python -m sandbox_runtime.entrypoint "$@"\n'
                )
                (packed.directory / "start-runtime").write_text(launcher)
                archive = Path(directory) / "bundle.tar.gz"
                with tarfile.open(archive, "w:gz") as tar:
                    tar.add(packed.directory, arcname="bundle")
                client.request(
                    "POST",
                    f"/api/v1/sandboxes/{builder}/files?path=/tmp/oi-bundle.tar.gz",
                    archive.read_bytes(),
                )
                client.command(
                    builder,
                    [
                        "bash",
                        "-lc",
                        "mkdir -p /tmp/oi-build && tar -xzf /tmp/oi-bundle.tar.gz -C /tmp/oi-build && "
                        "bash /tmp/oi-build/bundle/packages/sandbox-images/install/install.sh "
                        ">/tmp/oi-image-install.log 2>&1 && "
                        "install -m 755 /tmp/oi-build/bundle/start-runtime /opt/openinspect/start-runtime",
                    ],
                )
                # Builds are finished: checkpoint and quiesce the source before capture.
                client.pause(builder)
                # An ambiguous response can still have started capture: keep its source.
                capture_pending = True
                client.request(
                    "POST",
                    "/api/v1/templates/from-sandbox",
                    {
                        "template_id": candidate,
                        "sandbox_id": builder,
                    },
                )
            deadline = time.monotonic() + 900
            while True:
                template = client.request("GET", f"/api/v1/templates/{candidate}")
                state = template.get("status", {}).get("creation", {}).get("state")
                if state == "ready":
                    capture_pending = False
                    break
                if state == "failed":
                    capture_pending = False
                if state == "failed" or time.monotonic() >= deadline:
                    raise RuntimeError(f"Sandbox0 template capture did not finish: {state}")
                time.sleep(5)
            probe = client.create(candidate)
            resources.append(probe)
            client.command(
                probe,
                ["/opt/openinspect/python/bin/python", "/app/verify/smoke_test.py", "verify"],
                timeout=600,
            )
            write_build_result(candidate)
        finally:
            for sandbox in reversed(resources):
                if capture_pending and sandbox == builder:
                    print(
                        f"Capture pending for {candidate}; retaining source {sandbox} until its hard TTL",
                        file=sys.stderr,
                    )
                    continue
                try:
                    client.delete(sandbox)
                except Exception:
                    print(f"Cleanup required for Sandbox0 sandbox {sandbox}", file=sys.stderr)
            shutil.rmtree(packed.directory, ignore_errors=True)


if __name__ == "__main__":
    main()
