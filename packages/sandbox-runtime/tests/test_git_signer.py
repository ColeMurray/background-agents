import base64
import json
import os
import shlex
import subprocess
import sys
import textwrap
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import httpx
import pytest

from sandbox_runtime.git_signer import GitSignerError, run_signer

PUBLIC_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBaM0ggz8RWOz0lq3xs+vNPvnuWs0SS30txpSJTb357p"
FINGERPRINT = "SHA256:Cu64KulDfH7B8Mu37+JWepAJ1m59o159Y8RPj5Ta1XM"


def _run(*args: str, cwd: Path, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        args,
        cwd=cwd,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def test_git_invokes_custom_ssh_signer_with_literal_public_key(tmp_path: Path) -> None:
    private_key = tmp_path / "signing-key"
    _run(
        "ssh-keygen",
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        str(private_key),
        cwd=tmp_path,
    )
    public_key = " ".join(private_key.with_suffix(".pub").read_text().split()[:2])

    invocation_path = tmp_path / "invocation.json"
    recorder = tmp_path / "record-signer.py"
    recorder.write_text(
        textwrap.dedent(
            """\
            #!/usr/bin/env python3
            import json
            import os
            import subprocess
            import sys
            from pathlib import Path

            arguments = sys.argv[1:]
            key_path = Path(arguments[arguments.index("-f") + 1])
            buffer_path = Path(arguments[-1])
            subprocess.run(
                [
                    "/usr/bin/ssh-keygen",
                    "-Y",
                    "sign",
                    "-n",
                    "git",
                    "-f",
                    os.environ["OI_TEST_PRIVATE_KEY"],
                    str(buffer_path),
                ],
                check=True,
                capture_output=True,
            )
            Path(os.environ["OI_TEST_INVOCATION"]).write_text(
                json.dumps(
                    {
                        "arguments": arguments,
                        "public_key": key_path.read_text().strip(),
                        "buffer": buffer_path.read_text(),
                        "signature_created": Path(f"{buffer_path}.sig").is_file(),
                    }
                )
            )
            """
        )
    )
    recorder.chmod(0o755)

    repository = tmp_path / "repository"
    repository.mkdir()
    _run("git", "init", cwd=repository)
    _run("git", "config", "user.name", "Open Inspect", cwd=repository)
    _run("git", "config", "user.email", "open-inspect@example.com", cwd=repository)
    _run("git", "config", "gpg.format", "ssh", cwd=repository)
    _run("git", "config", "gpg.ssh.program", str(recorder), cwd=repository)
    _run("git", "config", "user.signingkey", f"key::{public_key}", cwd=repository)
    _run("git", "config", "commit.gpgsign", "true", cwd=repository)
    (repository / "change.txt").write_text("signed\n")
    _run("git", "add", "change.txt", cwd=repository)

    _run(
        "git",
        "commit",
        "-m",
        "record signer invocation",
        cwd=repository,
        env={
            **os.environ,
            "OI_TEST_PRIVATE_KEY": str(private_key),
            "OI_TEST_INVOCATION": str(invocation_path),
        },
    )

    invocation = json.loads(invocation_path.read_text())
    assert invocation["arguments"][:4] == ["-Y", "sign", "-n", "git"]
    assert invocation["arguments"][4] == "-f"
    assert invocation["arguments"][6] == "-U"
    assert len(invocation["arguments"]) == 8
    assert invocation["public_key"] == public_key
    assert invocation["buffer"].startswith("tree ")
    assert "\n\nrecord signer invocation\n" in invocation["buffer"]
    assert invocation["signature_created"] is True


def test_git_verification_invocations_can_delegate_unchanged_to_ssh_keygen(
    tmp_path: Path,
) -> None:
    private_key = tmp_path / "signing-key"
    _run(
        "ssh-keygen",
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        str(private_key),
        cwd=tmp_path,
    )
    public_key = " ".join(private_key.with_suffix(".pub").read_text().split()[:2])
    allowed_signers = tmp_path / "allowed-signers"
    allowed_signers.write_text(f"open-inspect@example.com {public_key}\n")

    repository = tmp_path / "repository"
    repository.mkdir()
    _run("git", "init", cwd=repository)
    _run("git", "config", "user.name", "Open Inspect", cwd=repository)
    _run("git", "config", "user.email", "open-inspect@example.com", cwd=repository)
    _run("git", "config", "gpg.format", "ssh", cwd=repository)
    _run("git", "config", "user.signingkey", str(private_key), cwd=repository)
    _run("git", "config", "commit.gpgsign", "true", cwd=repository)
    _run("git", "config", "gpg.ssh.allowedSignersFile", str(allowed_signers), cwd=repository)
    (repository / "change.txt").write_text("signed\n")
    _run("git", "add", "change.txt", cwd=repository)
    _run("git", "commit", "-m", "verify delegation", cwd=repository)

    invocations_path = tmp_path / "verification-invocations.jsonl"
    recorder = tmp_path / "record-verifier.py"
    recorder.write_text(
        textwrap.dedent(
            """\
            #!/usr/bin/env python3
            import json
            import os
            import sys

            with open(os.environ["OI_TEST_INVOCATIONS"], "a", encoding="utf-8") as output:
                output.write(json.dumps(sys.argv[1:]) + "\\n")
            os.execv("/usr/bin/ssh-keygen", ["/usr/bin/ssh-keygen", *sys.argv[1:]])
            """
        )
    )
    recorder.chmod(0o755)
    _run("git", "config", "gpg.ssh.program", str(recorder), cwd=repository)

    _run(
        "git",
        "verify-commit",
        "HEAD",
        cwd=repository,
        env={**os.environ, "OI_TEST_INVOCATIONS": str(invocations_path)},
    )

    invocations = [json.loads(line) for line in invocations_path.read_text().splitlines()]
    assert [arguments[:2] for arguments in invocations] == [
        ["-Y", "find-principals"],
        ["-Y", "verify"],
    ]


@pytest.mark.parametrize("uses_literal_key_flag", [True, False])
def test_supported_git_sign_invocations_post_exact_bytes_and_write_returned_armor(
    tmp_path: Path, uses_literal_key_flag: bool
) -> None:
    key_path = tmp_path / "git-selected-key"
    key_path.write_text(PUBLIC_KEY)
    buffer_path = tmp_path / "commit-buffer"
    payload = b"tree abcdef\x00\xff\n\ncommit message\n"
    buffer_path.write_bytes(payload)
    armor = (
        "-----BEGIN SSH SIGNATURE-----\n"
        f"{base64.b64encode(b'SSHSIG-test').decode()}\n"
        "-----END SSH SIGNATURE-----\n"
    )
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, text=armor)

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        arguments = ["-Y", "sign", "-n", "git", "-f", str(key_path)]
        if uses_literal_key_flag:
            arguments.append("-U")
        arguments.append(str(buffer_path))
        run_signer(
            arguments,
            {
                "CONTROL_PLANE_URL": "https://control.example.com/",
                "SANDBOX_AUTH_TOKEN": "sandbox-token",
                "SESSION_CONFIG": json.dumps({"sessionId": "session/1"}),
            },
            client,
        )

    assert len(requests) == 1
    assert str(requests[0].url) == (
        "https://control.example.com/sessions/session%2F1/commit-signing"
    )
    assert requests[0].headers["Authorization"] == "Bearer sandbox-token"
    assert requests[0].headers["Content-Type"] == "application/octet-stream"
    assert requests[0].headers["X-Open-Inspect-Signing-Fingerprint"] == FINGERPRINT
    assert requests[0].content == payload
    assert Path(f"{buffer_path}.sig").read_text() == armor


def test_git_2_39_literal_public_key_reference_is_signed(tmp_path: Path) -> None:
    buffer_path = tmp_path / "commit-buffer"
    buffer_path.write_bytes(b"tree abcdef\n\ncommit message\n")
    armor = (
        "-----BEGIN SSH SIGNATURE-----\n"
        f"{base64.b64encode(b'SSHSIG-test').decode()}\n"
        "-----END SSH SIGNATURE-----\n"
    )
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, text=armor)

    with httpx.Client(transport=httpx.MockTransport(handle)) as client:
        run_signer(
            ["-Y", "sign", "-n", "git", "-f", f"key::{PUBLIC_KEY}", str(buffer_path)],
            {
                "CONTROL_PLANE_URL": "https://control.example.com",
                "SANDBOX_AUTH_TOKEN": "sandbox-token",
                "SESSION_CONFIG": json.dumps({"sessionId": "session-1"}),
            },
            client,
        )

    assert requests[0].headers["X-Open-Inspect-Signing-Fingerprint"] == FINGERPRINT
    assert Path(f"{buffer_path}.sig").read_text() == armor


def test_signer_bounds_streamed_responses_without_leaving_signature_output(
    tmp_path: Path,
) -> None:
    key_path = tmp_path / "git-selected-key"
    key_path.write_text(PUBLIC_KEY)
    buffer_path = tmp_path / "commit-buffer"
    buffer_path.write_bytes(b"commit payload")

    class OversizedStream(httpx.SyncByteStream):
        def __iter__(self):
            yield b"x" * (8 * 1024)
            yield b"y" * (8 * 1024 + 1)

    def handle(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=OversizedStream())

    with (
        httpx.Client(transport=httpx.MockTransport(handle)) as client,
        pytest.raises(GitSignerError, match="response is too large"),
    ):
        run_signer(
            ["-Y", "sign", "-n", "git", "-f", str(key_path), "-U", str(buffer_path)],
            {
                "CONTROL_PLANE_URL": "https://control.example.com",
                "SANDBOX_AUTH_TOKEN": "sandbox-token",
                "SESSION_CONFIG": json.dumps({"sessionId": "session-1"}),
            },
            client,
        )

    assert not Path(f"{buffer_path}.sig").exists()


def test_signer_redacts_control_plane_error_bodies(tmp_path: Path) -> None:
    key_path = tmp_path / "git-selected-key"
    key_path.write_text(PUBLIC_KEY)
    buffer_path = tmp_path / "commit-buffer"
    buffer_path.write_bytes(b"private commit message")
    signature_path = Path(f"{buffer_path}.sig")
    signature_path.write_text("stale signature")

    def handle(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="secret response detail")

    with (
        httpx.Client(transport=httpx.MockTransport(handle)) as client,
        pytest.raises(GitSignerError) as caught,
    ):
        run_signer(
            [
                "-Y",
                "sign",
                "-n",
                "git",
                "-f",
                str(key_path),
                "-U",
                str(buffer_path),
            ],
            {
                "CONTROL_PLANE_URL": "https://control.example.com",
                "SANDBOX_AUTH_TOKEN": "sandbox-token",
                "SESSION_CONFIG": json.dumps({"sessionId": "session-1"}),
            },
            client,
        )

    assert "secret response detail" not in str(caught.value)
    assert "private commit message" not in str(caught.value)
    assert not signature_path.exists()


def test_real_git_commit_signs_through_production_cli_and_verifies(tmp_path: Path) -> None:
    private_key = tmp_path / "remote-signing-key"
    _run(
        "ssh-keygen",
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        str(private_key),
        cwd=tmp_path,
    )
    public_key = " ".join(private_key.with_suffix(".pub").read_text().split()[:2])
    fingerprint = _run(
        "ssh-keygen",
        "-lf",
        str(private_key.with_suffix(".pub")),
        "-E",
        "sha256",
        cwd=tmp_path,
    ).split()[1]
    received: list[tuple[str, str, bytes]] = []

    class SigningHandler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            length = int(self.headers["Content-Length"])
            payload = self.rfile.read(length)
            received.append(
                (
                    self.headers["Authorization"],
                    self.headers["X-Open-Inspect-Signing-Fingerprint"],
                    payload,
                )
            )
            payload_path = tmp_path / f"server-payload-{len(received)}"
            payload_path.write_bytes(payload)
            subprocess.run(
                [
                    "/usr/bin/ssh-keygen",
                    "-Y",
                    "sign",
                    "-n",
                    "git",
                    "-f",
                    str(private_key),
                    str(payload_path),
                ],
                check=True,
                capture_output=True,
            )
            armor = Path(f"{payload_path}.sig").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(armor)))
            self.end_headers()
            self.wfile.write(armor)

        def log_message(self, _format: str, *_args: object) -> None:
            return

    server = ThreadingHTTPServer(("127.0.0.1", 0), SigningHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    try:
        signer = tmp_path / "oi-git-sign"
        signer.write_text(
            f'#!/bin/sh\nexec {shlex.quote(sys.executable)} -m sandbox_runtime.git_signer "$@"\n'
        )
        signer.chmod(0o755)
        allowed_signers = tmp_path / "allowed-signers"
        allowed_signers.write_text(f"open-inspect@example.com {public_key}\n")
        repository = tmp_path / "repository"
        repository.mkdir()
        _run("git", "init", cwd=repository)
        _run("git", "config", "user.name", "Open Inspect", cwd=repository)
        _run("git", "config", "user.email", "open-inspect@example.com", cwd=repository)
        _run("git", "config", "gpg.format", "ssh", cwd=repository)
        _run("git", "config", "gpg.ssh.program", str(signer), cwd=repository)
        _run("git", "config", "user.signingkey", f"key::{public_key}", cwd=repository)
        _run("git", "config", "commit.gpgsign", "true", cwd=repository)
        _run("git", "config", "gpg.ssh.allowedSignersFile", str(allowed_signers), cwd=repository)
        (repository / "change.txt").write_text("signed through control plane\n")
        _run("git", "add", "change.txt", cwd=repository)
        environment = {
            **os.environ,
            "CONTROL_PLANE_URL": f"http://127.0.0.1:{server.server_port}",
            "SANDBOX_AUTH_TOKEN": "sandbox-token",
            "SESSION_CONFIG": json.dumps({"sessionId": "session-1"}),
        }

        _run("git", "commit", "-m", "remote signed", cwd=repository, env=environment)
        _run("git", "verify-commit", "HEAD", cwd=repository, env=environment)
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join()

    assert len(received) == 1
    assert received[0][0] == "Bearer sandbox-token"
    assert received[0][1] == fingerprint
    assert b"\n\nremote signed\n" in received[0][2]
