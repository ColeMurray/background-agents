/**
 * Shared Vercel Sandbox runtime bootstrap script.
 *
 * Used by CI when building the managed Vercel base-runtime snapshot.
 */

export const VERCEL_PYTHON_BIN = "/usr/bin/python3.12";
export const DEFAULT_VERCEL_RUNTIME = "node24";
export const VERCEL_RUNTIME_WORKDIR = "/tmp/open-inspect-runtime";
export const VERCEL_LOCAL_RUNTIME_EXTRACT_DIR = `${VERCEL_RUNTIME_WORKDIR}/packages`;

export function buildVercelBootstrapScript(params: { runtimeExtractDir?: string } = {}): string {
  const gitCredentialHelperCommand = `exec ${VERCEL_PYTHON_BIN} -m sandbox_runtime.credentials.git_credential_helper "$@"`;
  const runtimeExtractDir = params.runtimeExtractDir || VERCEL_LOCAL_RUNTIME_EXTRACT_DIR;
  return `
set -euo pipefail

OPENCODE_VERSION="1.17.18"
CODE_SERVER_VERSION="4.109.5"
AGENT_BROWSER_VERSION="0.21.2"
TTYD_VERSION="1.7.7"
TTYD_SHA256="8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55"

sudo mkdir -p /workspace /app /app/plugins /app/opencode-deps /tmp/opencode /root

sudo dnf install -y dnf-plugins-core git gcc gcc-c++ make ca-certificates openssh-clients jq unzip tar gzip python3.12 python3.12-pip python3.12-devel
sudo dnf install -y libX11 libXcomposite libXdamage libXext libXfixes libXrandr libxcb libxkbcommon libdrm mesa-libgbm alsa-lib atk at-spi2-atk cups-libs pango cairo nspr nss || true
sudo dnf install -y ffmpeg || true
if ! command -v gh >/dev/null 2>&1; then
  sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo || true
  sudo dnf install -y gh || true
fi

sudo ln -sf ${VERCEL_PYTHON_BIN} /usr/local/bin/python3
sudo ln -sf ${VERCEL_PYTHON_BIN} /usr/local/bin/python
if ! ${VERCEL_PYTHON_BIN} -m pip --version >/dev/null 2>&1; then
  sudo ${VERCEL_PYTHON_BIN} -m ensurepip --upgrade
fi
sudo ${VERCEL_PYTHON_BIN} -m pip install --break-system-packages uv httpx websockets 'pydantic>=2.0' 'PyJWT[crypto]' || sudo ${VERCEL_PYTHON_BIN} -m pip install uv httpx websockets 'pydantic>=2.0' 'PyJWT[crypto]'

sudo npm install -g pnpm@latest opencode-ai@"$OPENCODE_VERSION" @opencode-ai/plugin@"$OPENCODE_VERSION" zod agent-browser@"$AGENT_BROWSER_VERSION"
if [ ! -x /root/.bun/bin/bun ]; then
  curl -fsSL https://bun.sh/install | sudo -E bash || true
fi
sudo env PATH="/root/.bun/bin:$PATH" agent-browser install || true

if ! command -v code-server >/dev/null 2>&1; then
  curl -fsSL https://code-server.dev/install.sh | sudo sh -s -- --version "$CODE_SERVER_VERSION" || true
fi
if ! command -v ttyd >/dev/null 2>&1; then
  curl -fsSL -o /tmp/ttyd "https://github.com/tsl0922/ttyd/releases/download/$TTYD_VERSION/ttyd.x86_64"
  echo "$TTYD_SHA256  /tmp/ttyd" | sha256sum -c -
  sudo mv /tmp/ttyd /usr/local/bin/ttyd
  sudo chmod 0755 /usr/local/bin/ttyd
fi

test -d ${shellQuote(runtimeExtractDir)}
cd ${shellQuote(VERCEL_RUNTIME_WORKDIR)}
test -f packages/sandbox-runtime/pyproject.toml
test -d packages/sandbox-runtime/src/sandbox_runtime

sudo rm -rf /app/sandbox_runtime
sudo cp -a packages/sandbox-runtime/src/sandbox_runtime /app/sandbox_runtime
sudo chmod -R a+rX /app/sandbox_runtime
sudo ${VERCEL_PYTHON_BIN} -m pip install --break-system-packages -e packages/sandbox-runtime || sudo ${VERCEL_PYTHON_BIN} -m pip install -e packages/sandbox-runtime

printf '%s\\n' '#!/bin/sh' ${shellQuote(gitCredentialHelperCommand)} | sudo tee /usr/local/bin/oi-git-credentials >/dev/null
sudo chmod 0755 /usr/local/bin/oi-git-credentials
sudo git config --system credential.helper /usr/local/bin/oi-git-credentials || true
sudo git config --system credential.useHttpPath true || true

cat > /tmp/opencode-deps-package.json <<EOF
{"name":"opencode-tools","type":"module","dependencies":{"@opencode-ai/plugin":"$OPENCODE_VERSION"}}
EOF
sudo mv /tmp/opencode-deps-package.json /app/opencode-deps/package.json
cd /app/opencode-deps
sudo npm install --ignore-scripts --no-audit --no-fund
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
