#!/usr/bin/env python3
"""Executable image contract. Installation records identity; verification never rewrites it."""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import pwd
import re
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any

IMAGE_PATH = Path("/app/openinspect-image.json")


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


class Probe:
    def __init__(self, plan: dict[str, Any]) -> None:
        self.environment = os.environ | plan["runtimeEnv"]
        self.user = pwd.getpwnam(plan["target"]["user"])
        self.options: dict[str, Any] = {"env": self.environment, "cwd": "/workspace", "text": True}
        if os.geteuid() == 0:
            self.options.update(user=self.user.pw_uid, group=self.user.pw_gid, extra_groups=[])
        elif os.geteuid() != self.user.pw_uid:
            raise RuntimeError("Verification must run as the configured runtime user or root")

    def run(self, command: list[str], *, timeout_seconds: int = 120) -> str:
        result = subprocess.run(
            command, capture_output=True, timeout=timeout_seconds, check=False, **self.options
        )
        if result.returncode:
            raise RuntimeError(
                f"Image probe failed: {command[0]} (exit {result.returncode}): {result.stderr[-2000:]}"
            )
        return result.stdout.strip()

    def desktop(self) -> None:
        display = next(
            number for number in range(90, 190) if not Path(f"/tmp/.X11-unix/X{number}").exists()
        )
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        processes = []
        with tempfile.TemporaryFile(mode="w+") as output:
            try:
                processes.append(
                    subprocess.Popen(
                        ["Xvfb", f":{display}", "-screen", "0", "640x480x24", "-nolisten", "tcp"],
                        stdout=output,
                        stderr=output,
                        start_new_session=True,
                        **self.options,
                    )
                )
                deadline = time.monotonic() + 20
                while not Path(f"/tmp/.X11-unix/X{display}").exists():
                    if processes[0].poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("Xvfb failed to become ready")
                    time.sleep(0.1)
                for command in (
                    ["fluxbox", "-display", f":{display}"],
                    [
                        "x11vnc",
                        "-display",
                        f":{display}",
                        "-rfbport",
                        str(port),
                        "-localhost",
                        "-nopw",
                        "-forever",
                    ],
                ):
                    processes.append(
                        subprocess.Popen(
                            command,
                            stdout=output,
                            stderr=output,
                            start_new_session=True,
                            **self.options,
                        )
                    )
                deadline = time.monotonic() + 20
                while True:
                    if any(process.poll() is not None for process in processes):
                        raise RuntimeError("Desktop process exited during verification")
                    try:
                        with socket.create_connection(("127.0.0.1", port), timeout=1) as connection:
                            if not connection.recv(12).startswith(b"RFB "):
                                raise RuntimeError("VNC server did not speak RFB")
                            break
                    except OSError:
                        if time.monotonic() > deadline:
                            raise RuntimeError("VNC readiness timeout") from None
                        time.sleep(0.1)
                self.service(
                    [
                        "websockify",
                        "--web=/usr/share/novnc",
                        "127.0.0.1:{port}",
                        f"127.0.0.1:{port}",
                    ],
                    "/vnc.html",
                    websocket_rfb=True,
                )
            except Exception as error:
                output.seek(0)
                raise RuntimeError(f"{error}: {output.read()[-4000:]}") from error
            finally:
                for process in reversed(processes):
                    stop_process(process)

    def service(self, command: list[str], path: str = "/", *, websocket_rfb: bool = False) -> None:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        command = [arg.replace("{port}", str(port)) for arg in command]
        with tempfile.TemporaryFile(mode="w+") as output:
            process = subprocess.Popen(
                command, stdout=output, stderr=output, start_new_session=True, **self.options
            )
            try:
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        output.seek(0)
                        raise RuntimeError(
                            f"Image service exited: {command[0]}: {output.read()[-2000:]}"
                        )
                    try:
                        with urllib.request.urlopen(
                            f"http://127.0.0.1:{port}{path}", timeout=1
                        ) as response:
                            if response.status == 200:
                                if websocket_rfb:
                                    verify_rfb_proxy(port)
                                return
                    except OSError:
                        pass
                    time.sleep(0.2)
                raise RuntimeError(f"Image service readiness timeout: {command[0]}")
            finally:
                stop_process(process)


def verify_rfb_proxy(port: int) -> None:
    """Require the WebSocket proxy to exchange RFB with its VNC backend."""
    from websockets.sync.client import connect

    with connect(
        f"ws://127.0.0.1:{port}/websockify",
        subprotocols=["binary"],
        open_timeout=5,
        close_timeout=1,
        proxy=None,
    ) as connection:
        banner = connection.recv(timeout=5)
        if not isinstance(banner, bytes) or not banner.startswith(b"RFB ") or len(banner) != 12:
            raise RuntimeError("Desktop WebSocket proxy did not deliver an RFB banner")
        connection.send(banner)
        security = connection.recv(timeout=5)
        if not isinstance(security, bytes) or len(security) < 2 or security[0] == 0:
            raise RuntimeError("Desktop WebSocket proxy did not complete the RFB version exchange")


def stop_process(process: subprocess.Popen) -> None:
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def installed_os_packages(probe: Probe, os_family: str) -> list[str]:
    """Normalize package-manager output before recording or comparing inventory."""
    command = (
        ["dpkg-query", "-W", "-f=${Package}=${Version}\\n"]
        if os_family == "debian"
        else ["rpm", "-qa", "--qf", "%{NAME}=%{VERSION}-%{RELEASE}.%{ARCH}\\n"]
    )
    return sorted(probe.run(command).splitlines())


def observed_tool_version(command: str, expected: str, output: str) -> str:
    """Normalize the command's leading version, not an expected substring."""
    prefixes = {
        "node": r"v",
        "opencode": r"",
        "bun": r"",
        "pnpm": r"",
        "agent-browser": r"agent-browser\s+",
        "code-server": r"",
        "ttyd": r"ttyd version\s+",
        "google-chrome": r"Google Chrome(?: for Testing)?\s+",
    }
    match = re.match(prefixes[command] + r"(\d+(?:\.\d+){2,3})(?=\s|$)", output.strip())
    observed = match.group(1) if match else None
    if observed != expected:
        raise RuntimeError(f"{command} version mismatch: expected {expected}, got {output}")
    return observed


def inspect_image(plan: dict[str, Any], tools: dict[str, Any], *, services: bool) -> dict[str, Any]:
    probe = Probe(plan)
    versions = {}
    for command, version in (
        ("node", tools["node"][plan["target"]["node"]]["version"]),
        ("opencode", tools["opencode"]),
        ("bun", tools["bun"]),
        ("pnpm", tools["pnpm"]),
        ("agent-browser", tools["agentBrowser"]),
        ("code-server", tools["codeServer"]["version"]),
        ("ttyd", tools["ttyd"]["version"]),
        ("google-chrome", tools["chrome"]["version"]),
    ):
        observed = probe.run([command, "--version"])
        versions[command] = observed_tool_version(command, version, observed)
    installed_runtime = probe.run(
        [
            "python3",
            "-I",
            "-c",
            "import sandbox_runtime, sandbox_runtime.runtime_manifest, httpx, websockets, pydantic, jwt, cryptography; print(sandbox_runtime.runtime_manifest.RUNTIME_VERSION)",
        ]
    )
    if installed_runtime != plan["runtimeVersion"]:
        raise RuntimeError("Installed runtime manifest does not match the recipe")
    probe.run(
        [
            "python3",
            "-c",
            "import os, pathlib, shutil, tempfile; assert shutil.which('gh') == '/usr/local/bin/gh'; assert os.access('/usr/bin/gh', os.X_OK); assert pathlib.Path('/app/sandbox_runtime/skills/agent-browser/SKILL.md').is_file(); f=tempfile.TemporaryFile(dir='/workspace'); f.close(); f=tempfile.TemporaryFile(dir=pathlib.Path.home()); f.close()",
        ]
    )
    probe.run(["gh", "--version"])
    if probe.run(["git", "config", "--system", "credential.useHttpPath"]) != "true":
        raise RuntimeError("SCM credential helper is not repository-path scoped")
    probe.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "const p = await import('/app/opencode-deps/node_modules/@opencode-ai/plugin/dist/index.js'); if (typeof p.tool !== 'function') process.exit(1)",
        ]
    )
    for command in ("Xvfb", "fluxbox", "x11vnc", "websockify"):
        probe.run(["python3", "-c", "import shutil,sys; assert shutil.which(sys.argv[1])", command])
    if not Path("/usr/share/novnc/vnc.html").is_file():
        raise RuntimeError("noVNC assets missing")
    video = (
        subprocess.run(
            ["sh", "-c", "command -v ffmpeg"], capture_output=True, **probe.options
        ).returncode
        == 0
    )
    if not video and plan["provider"] != "vercel":
        raise RuntimeError("Required video encoder missing")
    if services:
        probe.desktop()
        probe.service(
            ["opencode", "serve", "--hostname", "127.0.0.1", "--port", "{port}"], "/global/health"
        )
        probe.service(
            [
                "code-server",
                "--bind-addr",
                "127.0.0.1:{port}",
                "--auth",
                "none",
                "--disable-telemetry",
                "/workspace",
            ],
            "/healthz",
        )
        probe.service(["ttyd", "--interface", "127.0.0.1", "--port", "{port}", "bash"])
        try:
            probe.run(
                ["agent-browser", "--session", "openinspect-image-verify", "open", "about:blank"]
            )
            probe.run(
                [
                    "agent-browser",
                    "--session",
                    "openinspect-image-verify",
                    "screenshot",
                    "/tmp/openinspect-image-verify.png",
                ]
            )
        finally:
            probe.run(["agent-browser", "--session", "openinspect-image-verify", "close"])
            Path("/tmp/openinspect-image-verify.png").unlink(missing_ok=True)
    return {
        "schemaVersion": 1,
        "runtimeVersion": plan["runtimeVersion"],
        "recipeDigest": plan["recipeDigest"],
        "target": plan["provider"],
        "architecture": platform.machine(),
        "pythonVersion": platform.python_version(),
        "os": platform.freedesktop_os_release(),
        "toolVersions": versions,
        "pythonPackages": sorted(
            f"{dist.metadata['Name']}=={dist.version}"
            for dist in importlib.metadata.distributions()
        ),
        "osPackages": installed_os_packages(probe, plan["target"]["os"]),
        "runtimeEnv": plan["runtimeEnv"],
        "runtimeUser": {
            "name": probe.user.pw_name,
            "uid": probe.user.pw_uid,
            "gid": probe.user.pw_gid,
            "home": probe.user.pw_dir,
        },
        "capabilities": {
            "agent": True,
            "editor": True,
            "terminal": True,
            "browser": True,
            "desktop": True,
            "videoEncoding": video,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("install", "verify"))
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--expected-recipe")
    args = parser.parse_args()
    plan = json.loads(Path("/app/openinspect-image-plan.json").read_text())
    tools = json.loads(Path("/app/openinspect-toolchain.json").read_text())
    if args.expected_recipe and plan["recipeDigest"] != args.expected_recipe:
        raise RuntimeError("The provider artifact does not match the selected recipe")
    inventory = inspect_image(plan, tools, services=args.command == "verify")
    digest = hashlib.sha256(canonical(inventory).encode()).hexdigest()
    identity = inventory | {"inventoryDigest": digest}
    if args.command == "install":
        IMAGE_PATH.write_text(canonical(identity) + "\n")
    else:
        baked = json.loads(IMAGE_PATH.read_text())
        if baked != identity:
            raise RuntimeError("Installed image contents differ from the baked inventory")
    print(
        json.dumps(
            {"passed": True, "identity": identity, "servicesVerified": args.command == "verify"}
        )
    )


if __name__ == "__main__":
    main()
