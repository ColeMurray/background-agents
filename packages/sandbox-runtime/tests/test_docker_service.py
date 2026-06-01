"""Tests for Docker daemon supervision in the sandbox entrypoint."""

import os
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sandbox_runtime.docker_service import DockerService
from sandbox_runtime.entrypoint import SandboxSupervisor


def test_from_env_reads_enabled_and_data_root(monkeypatch, tmp_path):
    data_root = tmp_path / "docker-data"
    monkeypatch.setenv("OPENINSPECT_DOCKER_ENABLED", "true")
    monkeypatch.setenv("DOCKER_DATA_ROOT", str(data_root))

    service = DockerService.from_env(MagicMock())

    assert service.enabled is True
    assert service.data_root == data_root


def test_prepare_runtime_state_preserves_snapshot_content(tmp_path):
    data_root = tmp_path / "docker-data"
    stale_dirs = ["network", "containers", "containerd", "runtimes", "tmp"]
    preserved_dirs = ["image", "vfs", "overlay2", "volumes", "buildkit"]

    for name in stale_dirs + preserved_dirs:
        path = data_root / name
        path.mkdir(parents=True)
        (path / "marker").write_text(name)

    socket_path = tmp_path / "docker.sock"
    socket_path.write_text("stale")
    run_dir = tmp_path / "containerd"
    run_dir.mkdir()
    (run_dir / "marker").write_text("stale")

    service = DockerService(MagicMock(), data_root=data_root, run_paths=(socket_path, run_dir))
    service.prepare_runtime_state()

    for name in stale_dirs:
        assert not (data_root / name).exists()
    for name in preserved_dirs:
        assert (data_root / name / "marker").read_text() == name
    assert not socket_path.exists()
    assert not run_dir.exists()


@pytest.mark.asyncio
async def test_supervisor_starts_docker_before_setup_in_build_mode():
    env = {
        "SANDBOX_ID": "test-sandbox",
        "REPO_OWNER": "acme",
        "REPO_NAME": "repo",
        "SESSION_CONFIG": "{}",
        "IMAGE_BUILD_MODE": "true",
        "OPENINSPECT_DOCKER_ENABLED": "true",
    }

    order: list[str] = []

    with patch.dict(os.environ, env, clear=False):
        supervisor = SandboxSupervisor()

    supervisor.perform_git_sync = AsyncMock(side_effect=lambda: order.append("git") or True)
    supervisor.runtime_services.start_before_hooks = AsyncMock(
        side_effect=lambda: order.append("docker")
    )
    supervisor.run_setup_script = AsyncMock(side_effect=lambda: order.append("setup") or True)
    supervisor.shutdown = AsyncMock()
    supervisor.shutdown_event.set()

    with patch.dict(os.environ, env, clear=False):
        await supervisor.run()

    assert order == ["git", "docker", "setup"]


@pytest.mark.asyncio
async def test_configure_network_adds_snat_rules(tmp_path):
    calls: list[tuple[str, ...]] = []

    async def fake_run_command(*args: str, check: bool = True):
        calls.append(args)
        if args == ("ip", "route", "show", "default"):
            return 0, "default via 10.0.0.1 dev eth0\n"
        if args == ("ip", "-4", "addr", "show", "dev", "eth0"):
            return 0, "2: eth0: <UP>\n    inet 10.0.0.2/24 scope global eth0\n"
        if args[:4] == ("iptables-legacy", "-t", "nat", "-C"):
            return 1, ""
        return 0, ""

    ip_forward = tmp_path / "ip_forward"

    service = DockerService(
        MagicMock(),
        data_root=tmp_path / "docker-data",
        ip_forward_path=ip_forward,
    )
    service._run_command = fake_run_command

    await service.configure_network()

    assert ip_forward.read_text() == "1\n"
    assert (
        "iptables-legacy",
        "-t",
        "nat",
        "-A",
        "POSTROUTING",
        "-o",
        "eth0",
        "-p",
        "tcp",
        "-j",
        "SNAT",
        "--to-source",
        "10.0.0.2",
    ) in calls
    assert (
        "iptables-legacy",
        "-t",
        "nat",
        "-A",
        "POSTROUTING",
        "-o",
        "eth0",
        "-p",
        "udp",
        "-j",
        "SNAT",
        "--to-source",
        "10.0.0.2",
    ) in calls
