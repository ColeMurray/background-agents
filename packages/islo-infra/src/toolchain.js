import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_BASE_IMAGE = "ghcr.io/islo-labs/islo-runner:latest";
export const OPENCODE_VERSION = "1.14.41";
export const CODE_SERVER_VERSION = "4.109.5";
export const AGENT_BROWSER_VERSION = "0.21.2";
export const TTYD_VERSION = "1.7.7";
export const TTYD_AMD64_SHA256 = "8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "../../..");
export const SANDBOX_RUNTIME_DIR = resolve(
  REPO_ROOT,
  "packages/sandbox-runtime/src/sandbox_runtime"
);

export async function buildSetupScript() {
  const helperScript = await readFile(
    resolve(SANDBOX_RUNTIME_DIR, "credentials/git_credential_helper.py"),
    "utf8"
  );

  return `#!/bin/sh
set -eu

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

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y --no-install-recommends nodejs
node --version
npm --version

npm install -g pnpm@latest
pnpm --version
curl -fsSL https://bun.sh/install | bash
if [ -x /root/.bun/bin/bun ]; then
  ln -sf /root/.bun/bin/bun /usr/local/bin/bun
elif [ -x "$HOME/.bun/bin/bun" ]; then
  ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
fi
bun --version

ln -sf "$(command -v python3)" /usr/local/bin/python
python --version

python3 -m pip install --no-cache-dir --break-system-packages \\
  uv \\
  "httpx>=0.27.0" \\
  "websockets>=13.0" \\
  "pydantic>=2.0" \\
  "PyJWT[crypto]>=2.9.0" \\
  "typing_extensions>=4.12.0"

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

cat > /tmp/oi-git-credential-helper.py <<'EOF'
${helperScript}
EOF

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
