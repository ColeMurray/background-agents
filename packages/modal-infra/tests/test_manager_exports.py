"""Compatibility coverage for the manager's pre-refactor constant imports."""

import pytest

from sandbox_runtime import constants
from sandbox_runtime.docker_control import CONTROL_TIMEOUT_SECONDS
from src.app_config import APP_NAME
from src.sandbox import manager
from src.sandbox.launch import ACCESS_PASSWORD_READ_TIMEOUT_SECONDS
from src.sandbox.launch_policy import PENDING_VM_REFERENCE_PREFIX
from src.sandbox.models import DEFAULT_VNC_ENABLED
from src.sandbox.tunnels import MAX_TUNNEL_PORTS


@pytest.mark.parametrize(
    "name, expected",
    [
        ("ACCESS_PASSWORD_READ_TIMEOUT_SECONDS", ACCESS_PASSWORD_READ_TIMEOUT_SECONDS),
        ("APP_NAME", APP_NAME),
        ("CODE_SERVER_PORT", constants.CODE_SERVER_PORT),
        ("CODE_SERVER_PORT_ENV_VAR", constants.CODE_SERVER_PORT_ENV_VAR),
        ("DEFAULT_SANDBOX_TIMEOUT_SECONDS", constants.DEFAULT_SANDBOX_TIMEOUT_SECONDS),
        ("DEFAULT_VNC_ENABLED", DEFAULT_VNC_ENABLED),
        ("DOCKER_ENABLED_ENV_VAR", constants.DOCKER_ENABLED_ENV_VAR),
        ("EXPECTED_TUNNEL_PORTS_ENV_VAR", constants.EXPECTED_TUNNEL_PORTS_ENV_VAR),
        ("MAX_TUNNEL_PORTS", MAX_TUNNEL_PORTS),
        ("NOVNC_PORT", constants.NOVNC_PORT),
        ("NOVNC_PORT_ENV_VAR", constants.NOVNC_PORT_ENV_VAR),
        ("PENDING_VM_REFERENCE_PREFIX", PENDING_VM_REFERENCE_PREFIX),
        ("SANDBOX_TIMEOUT_ENV_VAR", constants.SANDBOX_TIMEOUT_ENV_VAR),
        ("SNAPSHOT_FILESYSTEM_TIMEOUT_SECONDS", 300),
        ("CONTROL_TIMEOUT_SECONDS", CONTROL_TIMEOUT_SECONDS),
        ("TTYD_PROXY_PORT", constants.TTYD_PROXY_PORT),
        ("TTYD_PROXY_PORT_ENV_VAR", constants.TTYD_PROXY_PORT_ENV_VAR),
        ("TUNNEL_ENV_FILE_PATH", constants.TUNNEL_ENV_FILE_PATH),
        ("TUNNEL_ENV_SANDBOX_ID_KEY", constants.TUNNEL_ENV_SANDBOX_ID_KEY),
        ("VNC_PASSWORD_ENV_VAR", constants.VNC_PASSWORD_ENV_VAR),
        ("VNC_PASSWORD_MAX_BYTES", constants.VNC_PASSWORD_MAX_BYTES),
        ("VNC_PORT", constants.VNC_PORT),
    ],
)
def test_legacy_manager_constant_exports(name, expected):
    """Legacy import names retain their values and are explicitly public."""
    assert getattr(manager, name) == expected
    assert name in manager.__all__
