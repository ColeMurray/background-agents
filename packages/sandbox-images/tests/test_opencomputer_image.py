"""Execute the installer with isolated destinations and local checked archives."""

import hashlib
import io
import json
import os
import pwd
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest

from sandbox_images.bundle import pack_bundle, plan_image, validate_toolchain

ROOT = Path(__file__).resolve().parents[3]
INSTALL = ROOT / "packages/sandbox-images/install"


def executable(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)
    path.chmod(0o755)


def test_opencomputer_plan_uses_the_v2_substrate():
    target = plan_image(ROOT, "opencomputer")["target"]
    assert target["os"] == "amazon-linux"
    assert target["arch"] == "arm64"


def test_arm64_archives_require_independent_checksums():
    tools = json.loads((ROOT / "packages/sandbox-images/toolchain.json").read_text())
    tools["architectures"]["arm64"]["codex"]["sha256"] = "missing"
    with pytest.raises(ValueError, match="SHA-256"):
        validate_toolchain(tools)


def test_workspace_survives_a_home_only_checkpoint(tmp_path):
    runtime_user = pwd.getpwnam("nobody") if os.geteuid() == 0 else pwd.getpwuid(os.getuid())
    home = tmp_path / "home/sandbox"
    app = tmp_path / "app"
    bin_dir = tmp_path / "usr/local/bin"
    install = tmp_path / "install"
    shutil.copytree(INSTALL, install)
    (app / "opencode-deps").mkdir(parents=True)
    (app / "sandbox_runtime").mkdir()
    (app / "sandbox_runtime/gh-wrapper.sh").write_text("#!/bin/sh\n")
    (tmp_path / "packages/sandbox-images/verify").mkdir(parents=True)
    (tmp_path / "packages/sandbox-images/verify/smoke_test.py").write_text("")
    shutil.copy(
        ROOT / "packages/sandbox-images/toolchain.json",
        tmp_path / "packages/sandbox-images/toolchain.json",
    )
    (tmp_path / "build-config.json").write_text('{"runtimeEnv": {}}')
    executable(bin_dir / "opencode", "#!/bin/sh\nexit 0\n")
    executable(bin_dir / "git", "#!/bin/sh\nexit 0\n")
    python = tmp_path / "opt/openinspect/python/bin/python"
    python.parent.mkdir(parents=True)
    python.symlink_to(sys.executable)
    script = (install / "filesystem.sh").read_text()
    for prefix in ("/opt/openinspect", "/usr/local/bin", "/app", "/tmp/opencode"):
        script = script.replace(prefix, str(tmp_path / prefix.lstrip("/")))
    script = script.replace(" /workspace", f" {tmp_path}/workspace")
    (install / "filesystem.sh").write_text(script)
    env = os.environ | {
        "OI_INSTALL_DIR": str(install),
        "OI_BUNDLE": str(tmp_path),
        "OI_PROVIDER": "opencomputer",
        "OI_RUNTIME_USER": runtime_user.pw_name,
        "OI_RUNTIME_HOME": str(home),
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
    }
    result = subprocess.run(
        ["bash", str(install / "filesystem.sh")], env=env, capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    workspace = tmp_path / "workspace"
    assert workspace.is_symlink()
    assert workspace.resolve() == home / "workspace"
    assert workspace.stat().st_uid == runtime_user.pw_uid
    browser = json.loads((home / ".agent-browser/config.json").read_text())
    assert browser["args"] == "--no-sandbox --disable-dev-shm-usage"
    (workspace / "sentinel").write_text("uncommitted work")
    checkpoint = tmp_path / "checkpoint.tar.gz"
    with tarfile.open(checkpoint, "w:gz") as archive:
        archive.add(home, arcname="sandbox")
    shutil.rmtree(home)
    with tarfile.open(checkpoint) as archive:
        archive.extractall(home.parent, filter="data")
    assert (workspace / "sentinel").read_text() == "uncommitted work"


@pytest.mark.parametrize("arch,machine", [("amd64", "x86_64"), ("arm64", "aarch64")])
def test_installer_accepts_matching_architecture_and_rejects_mismatch(tmp_path, arch, machine):
    install = tmp_path / "packages/sandbox-images/install"
    shutil.copytree(INSTALL, install)
    marker = tmp_path / "installed"
    (install / "languages.sh").write_text(f"touch '{marker}'\n")
    (tmp_path / "image-config.sh").write_text(f"export OI_ARCH={arch} OI_OS=amazon-linux\n")
    bin_dir = tmp_path / "bin"
    executable(bin_dir / "id", "#!/bin/sh\necho 0\n")
    executable(bin_dir / "uname", f"#!/bin/sh\necho {machine}\n")
    env = os.environ | {"PATH": f"{bin_dir}:{os.environ['PATH']}"}
    result = subprocess.run(
        ["bash", str(install / "install.sh"), "languages"], env=env, capture_output=True, text=True
    )
    assert result.returncode == 0, result.stderr
    assert marker.exists()
    marker.unlink()
    executable(bin_dir / "uname", "#!/bin/sh\necho riscv64\n")
    result = subprocess.run(
        ["bash", str(install / "install.sh"), "languages"], env=env, capture_output=True, text=True
    )
    assert result.returncode != 0
    assert not marker.exists()


@pytest.mark.parametrize("provider,arch", [("e2b", "amd64"), ("opencomputer", "arm64")])
def test_packed_toolchain_selects_checked_native_archives(tmp_path, provider, arch):
    packed = pack_bundle(ROOT, provider, tmp_path)
    config = (packed.directory / "image-config.sh").read_text()
    assert f"export OI_ARCH={arch}" in config
    tools = json.loads((packed.directory / "packages/sandbox-images/toolchain.json").read_text())
    original = json.loads((ROOT / "packages/sandbox-images/toolchain.json").read_text())
    assert tools["chrome"]["version"] == (
        "155.0.8059.79" if arch == "arm64" else original["chrome"]["version"]
    )
    for name, prefix in {
        "uv": "UV",
        "codeServer": "CODE_SERVER",
        "codex": "CODEX",
        "ttyd": "TTYD",
        "chrome": "CHROME",
    }.items():
        assert f"export {prefix}_SHA256={tools[name]['sha256']}" in config
        if arch == "arm64":
            assert tools[name]["sha256"] != original[name]["sha256"]


@pytest.mark.parametrize(
    "arch,node_arch,machine,chrome_platform",
    [
        ("amd64", "x64", "x86_64", "linux64"),
        ("arm64", "arm64", "aarch64", "linux-arm64"),
    ],
)
def test_language_and_tool_installers_extract_the_selected_archives(
    tmp_path, arch, node_arch, machine, chrome_platform
):
    # Only destinations are rebased. The real shell, checksum, tar, unzip,
    # install and symlink operations execute; network/npm are local fixtures.
    bundle = tmp_path / "bundle"
    install = bundle / "packages/sandbox-images/install"
    shutil.copytree(INSTALL, install)
    for name in ("languages.sh", "tools.sh"):
        path = install / name
        source = path.read_text()
        for prefix in ("/opt/openinspect", "/usr/local/bin", "/app"):
            source = source.replace(prefix, str(tmp_path / prefix.lstrip("/")))
        path.write_text(source)
    bin_dir = tmp_path / "usr/local/bin"
    bin_dir.mkdir(parents=True)
    fixtures = tmp_path / "archives"
    fixtures.mkdir()
    downloads = {}

    def archive(name, members):
        path = fixtures / name
        if name.endswith(".zip"):
            with zipfile.ZipFile(path, "w") as output:
                for file in members:
                    output.writestr(file, "#!/bin/sh\nexit 0\n")
        else:
            with tarfile.open(path, "w:xz" if name.endswith(".xz") else "w:gz") as output:
                for file in members:
                    content = b"#!/bin/sh\nexit 0\n"
                    info = tarfile.TarInfo(file)
                    info.size = len(content)
                    info.mode = 0o755
                    output.addfile(info, io.BytesIO(content))
        return path, hashlib.sha256(path.read_bytes()).hexdigest()

    versions = {
        "NODE": "24.20.0",
        "UV": "0.9.7",
        "AGENT_BROWSER": "0.37.0",
        "CODE_SERVER": "4.109.5",
        "TTYD": "1.7.7",
        "CHROME": "155.0.8059.79",
        "CODEX": "0.160.0",
    }
    definitions = {
        "NODE": (
            f"https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-{node_arch}.tar.xz",
            ["node/bin/node", "node/bin/npm", "node/bin/npx"],
        ),
        "UV": (
            f"https://github.com/astral-sh/uv/releases/download/0.9.7/uv-{machine}-unknown-linux-gnu.tar.gz",
            ["uv/uv", "uv/uvx"],
        ),
        "AGENT_BROWSER": (
            f"https://github.com/vercel-labs/agent-browser/releases/download/v0.37.0/agent-browser-linux-{node_arch}",
            [],
        ),
        "CODE_SERVER": (
            f"https://github.com/coder/code-server/releases/download/v4.109.5/code-server-4.109.5-linux-{arch}.tar.gz",
            ["code-server/bin/code-server"],
        ),
        "TTYD": (f"https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.{machine}", []),
        "CHROME": (
            f"https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.79/{chrome_platform}/chrome-{chrome_platform}.zip",
            [f"chrome-{chrome_platform}/chrome"],
        ),
        "CODEX": (
            f"https://github.com/openai/codex/releases/download/rust-v0.160.0/codex-package-{machine}-unknown-linux-musl.tar.gz",
            ["bin/codex", "vendor/helper"],
        ),
    }
    env = os.environ | {
        "OI_INSTALL_DIR": str(install),
        "OI_BUNDLE": str(bundle),
        "OI_ARCH": arch,
        "PYTHON_VERSION": json.loads((ROOT / "packages/sandbox-images/toolchain.json").read_text())[
            "python"
        ],
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
    }
    for name, (url, members) in definitions.items():
        if members:
            path, digest = archive(url.rsplit("/", 1)[1], members)
        else:
            path = fixtures / name
            path.write_text("#!/bin/sh\nexit 0\n")
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
        downloads[url] = str(path)
        env[f"{name}_VERSION"] = versions[name]
        env[f"{name}_SHA256"] = digest
    mapping = tmp_path / "downloads.json"
    mapping.write_text(json.dumps(downloads))
    executable(
        bin_dir / "curl",
        f"""#!{shutil.which("python3")}
import json, shutil, sys
paths = json.load(open({str(mapping)!r}))
shutil.copyfile(paths[sys.argv[-1]], sys.argv[sys.argv.index('--output') + 1])
""",
    )
    for name in ("tools", "plugins"):
        directory = bundle / f"packages/sandbox-images/locks/{name}"
        directory.mkdir(parents=True)
        (directory / "package.json").write_text("{}")
        (directory / "package-lock.json").write_text("{}")
    for phase in ("languages", "tools"):
        result = subprocess.run(
            ["bash", str(install / f"{phase}.sh")], env=env, capture_output=True, text=True
        )
        assert result.returncode == 0, result.stderr
    assert (bin_dir / "google-chrome").resolve().is_file()
    assert (bin_dir / "codex").resolve().is_file()
    assert (tmp_path / "opt/openinspect/codex/vendor/helper").is_file()
    assert (bin_dir / "agent-browser").is_file()
