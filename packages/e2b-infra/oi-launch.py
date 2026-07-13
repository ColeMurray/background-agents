#!/usr/bin/env python3
"""
Open-Inspect E2B launcher — the template's start command.

E2B runs the template start command once at *build* time, snapshots it, and
resumes that process on every sandbox create; create-time env vars are NOT
visible to it (https://e2b.dev/docs/template/start-ready-command). The supervisor
needs per-session env (CONTROL_PLANE_URL, SESSION_CONFIG, auth token, clone token,
secrets), so the control plane drops those as a JSON file via envd's filesystem
API after create. This launcher waits for that file, loads it, and execs the
supervisor with the merged environment — so the supervisor starts fresh per
session regardless of E2B's snapshot/resume model.

On pause/resume the supervisor process itself is frozen/thawed by E2B, so this
launcher only runs for a fresh spawn.
"""

import json
import os
import sys
import time

SESSION_ENV_PATH = "/tmp/oi-session.env"
POLL_INTERVAL_SECONDS = 0.3
# Heartbeat log cadence while waiting for the session env file.
HEARTBEAT_EVERY = 100  # iterations (~30s at 0.3s)

# Static runtime env. The template start command inherits the Dockerfile's
# HOME=/root (needed by root at build), but E2B runs the sandbox as non-root
# `user`, so opencode/code-server must write under /home/user — otherwise they
# hit EACCES on /root/.local. PYTHONPATH/NODE_PATH aren't propagated by E2B.
STATIC_ENV = {
    "HOME": "/home/user",
    "PYTHONPATH": "/app",
    "NODE_PATH": "/usr/lib/node_modules",
}


def _log(msg: str) -> None:
    print(f"[oi-launch] {msg}", flush=True)


def main() -> None:
    # Poll indefinitely. E2B runs this start command once at build, snapshots it
    # mid-poll, and resumes it on each create — so a wall-clock deadline measured
    # here would be relative to *build* time and expire before any create. The
    # real bounds are E2B's sandbox TTL and the control plane's connecting-timeout
    # (which stops the sandbox if the bridge never phones home).
    _log(f"waiting for session env at {SESSION_ENV_PATH}")
    i = 0
    session_env = None
    while session_env is None:
        i += 1
        if i % HEARTBEAT_EVERY == 0:
            _log(f"still waiting for session env ({i} polls)")
        if os.path.exists(SESSION_ENV_PATH):
            # envd may materialize the upload non-atomically, so a read can race
            # the write and see a partial file. Treat any read/parse failure as
            # "not ready yet" and keep polling — the control plane's write is the
            # sole producer and converges to valid JSON.
            try:
                with open(SESSION_ENV_PATH, encoding="utf-8") as f:
                    parsed = json.load(f)
            except (OSError, ValueError) as e:
                _log(f"session env present but unreadable (partial write?): {e} — retrying")
            else:
                if isinstance(parsed, dict):
                    session_env = parsed
                else:
                    _log("session env is not a JSON object — retrying")
        time.sleep(POLL_INTERVAL_SECONDS)

    env = {**os.environ, **STATIC_ENV}
    for k, v in session_env.items():
        env[str(k)] = str(v)

    _log(f"loaded {len(session_env)} session vars; starting supervisor")
    # E2B's `sandbox logs` does not surface the start command's stdout/stderr, so
    # mirror the supervisor's output to a file operators can tail for debugging.
    try:
        log_fd = os.open("/tmp/oi-supervisor.log", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        os.dup2(log_fd, 1)
        os.dup2(log_fd, 2)
        os.close(log_fd)
    except OSError as e:
        _log(f"could not redirect supervisor output: {e}")
    # Replace this process so the supervisor runs as the sandbox's main process.
    os.execvpe("python", ["python", "-m", "sandbox_runtime.entrypoint"], env)


if __name__ == "__main__":
    main()
