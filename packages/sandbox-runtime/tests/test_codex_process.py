"""Real Linux ownership-domain tests, including setsid escapes."""

import asyncio
import os
import signal
import subprocess
import sys
from pathlib import Path

import pytest

from sandbox_runtime.harness.codex import process as codex_process
from sandbox_runtime.harness.codex.client import CodexClient

pytestmark = pytest.mark.skipif(sys.platform != "linux", reason="Linux subreaper contract")


@pytest.mark.parametrize("machine,exit_code", [("aarch64", 0), ("riscv64", 88)])
def test_process_owner_architecture_gate(tmp_path, machine, exit_code):
    marker = tmp_path / "child-ran"
    script = (
        "import platform,sys; "
        f"platform.machine=lambda: {machine!r}; "
        "from sandbox_runtime.harness.codex import process; "
        f"sys.argv=['owner',sys.executable,'-c',\"from pathlib import Path; Path({str(marker)!r}).touch()\"]; "
        "sys.exit(process.main())"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        env=os.environ | {"PYTHONPATH": str(Path(codex_process.__file__).parents[3])},
    )
    assert result.returncode == exit_code, result.stderr
    assert marker.exists() == (exit_code == 0)


async def test_owned_detached_writer_stops_and_unrelated_process_survives(tmp_path):
    pidfile = tmp_path / "writer.pid"
    output = tmp_path / "writes"
    script = tmp_path / "parent.py"
    writer = f"import os,time; from pathlib import Path; Path({str(pidfile)!r}).write_text(str(os.getpid()));\nwhile True:\n with open({str(output)!r},'a') as f: f.write('x')\n time.sleep(.01)"
    script.write_text(
        f"import subprocess,sys,time\nsubprocess.Popen([sys.executable,'-c',{writer!r}],start_new_session=True)\ntime.sleep(60)\n"
    )
    unrelated = await asyncio.create_subprocess_exec(
        sys.executable, "-c", "import time;time.sleep(60)"
    )
    client = CodexClient(
        command=(sys.executable, codex_process.__file__, sys.executable, str(script)),
        cwd=tmp_path,
        env={"PATH": os.environ["PATH"]},
        containment_owner=True,
    )
    try:
        await client.open()
        async with asyncio.timeout(3):
            while not output.exists():
                await asyncio.sleep(0.02)
        writer_pid = int(pidfile.read_text())
        assert await client.close(timeout_seconds=5)
        size = output.stat().st_size
        await asyncio.sleep(0.1)
        assert output.stat().st_size == size
        with pytest.raises(ProcessLookupError):
            os.kill(writer_pid, 0)
        assert unrelated.returncode is None
    finally:
        await client.close(timeout_seconds=5)
        unrelated.terminate()
        await unrelated.wait()


async def test_killed_ownership_supervisor_is_not_containment_proof(tmp_path):
    client = CodexClient(
        command=(sys.executable, "-c", "import time;time.sleep(60)"),
        cwd=tmp_path,
        env={},
        containment_owner=True,
    )
    await client.open()
    assert client._process is not None
    os.kill(client._process.pid, signal.SIGKILL)
    await asyncio.sleep(0.05)
    assert not await client.close(timeout_seconds=1)
