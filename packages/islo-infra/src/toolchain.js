import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BASE_IMAGE = "ghcr.io/islo-labs/islo-runner:latest";
export const OPENCODE_VERSION = "1.14.41";
export const BUN_VERSION = "1.2.19";
export const BUN_LINUX_X64_SHA256 =
  "c3d3c14e9a5ec83ff67d0acfe76e4315ad06da9f34f59fc7b13813782caf1f66";
export const CODE_SERVER_VERSION = "4.109.5";
export const CODE_SERVER_AMD64_SHA256 =
  "297c674d308436af5064514073f8bda3f1ad61095176c6b6f76b4f2a048fdb23";
export const AGENT_BROWSER_VERSION = "0.21.2";
export const TTYD_VERSION = "1.7.7";
export const TTYD_AMD64_SHA256 = "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55";
export const PYTHON_VERSION = "3.12";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "../../..");
export const SANDBOX_RUNTIME_DIR = resolve(
  REPO_ROOT,
  "packages/sandbox-runtime/src/sandbox_runtime"
);

export async function buildSetupScript() {
  return `#!/bin/bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export HOME="/root"
export PATH="/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

apt-get update
apt-get install -y --no-install-recommends \\
  build-essential \\
  ca-certificates \\
  chromium \\
  curl \\
  ffmpeg \\
  git \\
  gnupg \\
  jq \\
  libasound2 \\
  libatk-bridge2.0-0 \\
  libatk1.0-0 \\
  libcairo2 \\
  libcups2 \\
  libdrm2 \\
  libgbm1 \\
  libnspr4 \\
  libnss3 \\
  libpango-1.0-0 \\
  libxcomposite1 \\
  libxdamage1 \\
  libxfixes3 \\
  libxkbcommon0 \\
  libxrandr2 \\
  openssh-client \\
  python3 \\
  python3-pip \\
  tar \\
  unzip

curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \\
  | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \\
  > /etc/apt/sources.list.d/github-cli.list
apt-get update
apt-get install -y --no-install-recommends gh

curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \\
  | gpg --dearmor -o /usr/share/keyrings/nodesource.gpg
echo "deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \\
  > /etc/apt/sources.list.d/nodesource.list
apt-get update
apt-get install -y --no-install-recommends nodejs
node --version
npm --version

npm install -g pnpm@latest
pnpm --version
curl -fsSL -o /tmp/bun-linux-x64.zip \\
  "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-x64.zip"
echo "${BUN_LINUX_X64_SHA256}  /tmp/bun-linux-x64.zip" | sha256sum -c -
mkdir -p /root/.bun/bin
unzip -o -j /tmp/bun-linux-x64.zip "bun-linux-x64/bun" -d /root/.bun/bin
chmod +x /root/.bun/bin/bun
ln -sf /root/.bun/bin/bun /usr/local/bin/bun
rm /tmp/bun-linux-x64.zip
bun --version

ln -sf "$(command -v python3)" /usr/local/bin/python
python --version

python3 -m pip install --no-cache-dir --break-system-packages uv
uv python install "${PYTHON_VERSION}"
PYTHON_BASE_BIN="$(uv python find "${PYTHON_VERSION}")"
PYTHON_VENV="/opt/open-inspect-python"
uv venv --python "$PYTHON_BASE_BIN" "$PYTHON_VENV"
PYTHON_BIN="$PYTHON_VENV/bin/python"
cat > /usr/local/bin/python <<EOF
#!/bin/sh
exec "$PYTHON_BIN" "\\$@"
EOF
cp /usr/local/bin/python /usr/local/bin/python3
chmod 0755 /usr/local/bin/python /usr/local/bin/python3
hash -r
python --version
python3 --version

uv pip install --python "$PYTHON_BIN" \\
  "httpx>=0.27.0" \\
  "websockets>=13.0" \\
  "pydantic>=2.0" \\
  "PyJWT[crypto]>=2.9.0"

npm install -g "opencode-ai@${OPENCODE_VERSION}"
opencode --version || true
npm install -g "@opencode-ai/plugin@${OPENCODE_VERSION}" zod

mkdir -p /app/opencode-deps
printf '%s\\n' '{"name":"opencode-tools","type":"module","dependencies":{"@opencode-ai/plugin":"${OPENCODE_VERSION}"}}' \\
  > /app/opencode-deps/package.json
cd /app/opencode-deps
npm install --ignore-scripts --no-audit --no-fund

curl -fsSL -o /tmp/code-server.deb \\
  "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_amd64.deb"
echo "${CODE_SERVER_AMD64_SHA256}  /tmp/code-server.deb" | sha256sum -c -
dpkg -i /tmp/code-server.deb
rm /tmp/code-server.deb
code-server --version

curl -fsSL -o /usr/local/bin/ttyd \\
  "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.x86_64"
echo "${TTYD_AMD64_SHA256}  /usr/local/bin/ttyd" | sha256sum -c -
chmod +x /usr/local/bin/ttyd
ttyd --version

npm install -g "agent-browser@${AGENT_BROWSER_VERSION}"
test -x /usr/bin/chromium
agent-browser --version

mkdir -p /workspace /app/plugins /tmp/opencode
cat > /usr/local/bin/oi-git-credentials <<'EOF'
#!/bin/sh
exec python3 -m sandbox_runtime.credentials.git_credential_helper "$@"
EOF
chmod 0755 /usr/local/bin/oi-git-credentials
git config --system credential.helper /usr/local/bin/oi-git-credentials
git config --system credential.useHttpPath true

rm -rf /var/lib/apt/lists/*
`;
}

export function buildBaseSandboxCreate({ sandboxName, baseImage }) {
  return {
    name: sandboxName,
    image: baseImage,
    vcpus: 4,
    memory_mb: 8192,
    disk_gb: 20,
    workdir: "/workspace",
    init: { type: "minimal" },
    env: {
      HOME: "/root",
      NODE_ENV: "development",
      PNPM_HOME: "/root/.local/share/pnpm",
      PATH: "/root/.bun/bin:/root/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin",
      PYTHONPATH: "/app",
      NODE_PATH: "/usr/lib/node_modules",
      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
      SANDBOX_VERSION: "islo-snapshot-v1",
    },
  };
}
