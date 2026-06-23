"""Tests for the shared sandbox toolchain install contract."""

from sandbox_runtime import toolchain


def test_opencode_deps_staging_contract() -> None:
    commands = "\n".join(toolchain.opencode_deps_staging_commands())

    assert "mkdir -p /app/opencode-deps" in commands
    assert f'"@opencode-ai/plugin":"{toolchain.OPENCODE_VERSION}"' in commands
    assert "npm install --ignore-scripts --no-audit --no-fund" in commands
    assert "mkdir -p /root/.config/opencode" in commands
    assert "cp -a /app/opencode-deps/. /root/.config/opencode/" in commands


def test_git_credential_helper_contract() -> None:
    commands = "\n".join(toolchain.git_credential_helper_commands())

    assert "python3 -m sandbox_runtime.credentials.git_credential_helper" in commands
    assert "> /usr/local/bin/oi-git-credentials" in commands
    assert "git config --system credential.helper /usr/local/bin/oi-git-credentials" in commands
    assert "git config --system credential.useHttpPath true" in commands


def test_ttyd_install_contract() -> None:
    commands = "\n".join(toolchain.ttyd_install_commands())

    assert f"/releases/download/{toolchain.TTYD_VERSION}/ttyd.x86_64" in commands
    assert toolchain.TTYD_SHA256 in commands
    assert "chmod +x /usr/local/bin/ttyd" in commands
