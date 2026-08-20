/**
 * Shared Vercel Sandbox runtime bootstrap script.
 *
 * Used by CI when building the managed Vercel base-runtime snapshot.
 */

import { SANDBOX_RUNTIME_VERSION } from "../../runtime-manifest";

export const VERCEL_PYTHON_BIN = "/usr/bin/python3.12";
export const DEFAULT_VERCEL_RUNTIME = "node24";
export const VERCEL_SANDBOX_VERSION = SANDBOX_RUNTIME_VERSION;
export const VERCEL_RUNTIME_WORKDIR = "/tmp/open-inspect-runtime";
export const VERCEL_LOCAL_RUNTIME_EXTRACT_DIR = `${VERCEL_RUNTIME_WORKDIR}/packages`;

export function buildVercelBootstrapScript(params: { runtimeExtractDir?: string } = {}): string {
  const gitCredentialHelperCommand = `exec ${VERCEL_PYTHON_BIN} -m sandbox_runtime.credentials.git_credential_helper "$@"`;
  const runtimeExtractDir = params.runtimeExtractDir || VERCEL_LOCAL_RUNTIME_EXTRACT_DIR;
  return `
set -euo pipefail

OPENCODE_VERSION="1.18.18"
CODE_SERVER_VERSION="4.109.5"
AGENT_BROWSER_VERSION="0.21.2"
TTYD_VERSION="1.7.7"
TTYD_SHA256="8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55"
FLUXBOX_VERSION="1.3.7"
FLUXBOX_SHA256="fc8c75fe94c54ed5a5dd3fd4a752109f8949d6df67a48e5b11a261403c382ec0"
LIBVNCSERVER_VERSION="0.9.14"
LIBVNCSERVER_SHA256="83104e4f7e28b02f8bf6b010d69b626fae591f887e949816305daebae527c9a5"
X11VNC_VERSION="0.9.16"
X11VNC_SHA256="885e5b5f5f25eec6f9e4a1e8be3d0ac71a686331ee1cfb442dba391111bd32bd"
NOVNC_VERSION="1.6.0"
NOVNC_SHA256="5066103959ef4e9b10f37e5a148627360dd8414e4cf8a7db92bdbd022e728aaa"

sudo mkdir -p /workspace /app /app/plugins /app/opencode-deps /tmp/opencode /root

sudo dnf install -y dnf-plugins-core git gcc gcc-c++ make ca-certificates openssh-clients jq unzip tar gzip python3.12 python3.12-pip python3.12-devel
sudo dnf install -y xorg-x11-server-Xvfb autoconf automake libtool cmake xz diffutils pkgconf-pkg-config openssl-devel libjpeg-turbo-devel zlib-devel libX11-devel libXext-devel libXft-devel libXinerama-devel libXpm-devel libXrandr-devel libXtst-devel libXfixes-devel libXdamage-devel
sudo dnf install -y libX11 libXcomposite libXdamage libXext libXfixes libXrandr libxcb libxkbcommon libdrm mesa-libgbm alsa-lib atk at-spi2-atk cups-libs pango cairo nspr nss || true
sudo dnf install -y ffmpeg || true
if ! command -v gh >/dev/null 2>&1; then
  sudo dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo || true
  sudo dnf install -y gh || true
fi

curl -fsSL -o /tmp/fluxbox.tar.xz "https://sourceforge.net/projects/fluxbox/files/fluxbox/$FLUXBOX_VERSION/fluxbox-$FLUXBOX_VERSION.tar.xz/download"
echo "$FLUXBOX_SHA256  /tmp/fluxbox.tar.xz" | sha256sum -c -
sudo tar -xJf /tmp/fluxbox.tar.xz -C /tmp
(cd "/tmp/fluxbox-$FLUXBOX_VERSION" && sed -i 's/text_prop.value > 0/text_prop.value != 0/' util/fluxbox-remote.cc && ./configure --disable-imlib2 && make -j2 && sudo make install)

curl -fsSL -o /tmp/libvncserver.tar.gz "https://github.com/LibVNC/libvncserver/archive/refs/tags/LibVNCServer-$LIBVNCSERVER_VERSION.tar.gz"
echo "$LIBVNCSERVER_SHA256  /tmp/libvncserver.tar.gz" | sha256sum -c -
sudo tar -xzf /tmp/libvncserver.tar.gz -C /tmp
cmake -S "/tmp/libvncserver-LibVNCServer-$LIBVNCSERVER_VERSION" -B /tmp/libvncserver-build -DWITH_GCRYPT=OFF -DWITH_GNUTLS=OFF -DWITH_FFMPEG=OFF -DWITH_PNG=OFF -DWITH_SDL=OFF -DWITH_SYSTEMD=OFF
cmake --build /tmp/libvncserver-build --parallel 2
sudo cmake --install /tmp/libvncserver-build
sudo ldconfig

curl -fsSL -o /tmp/x11vnc.tar.gz "https://github.com/LibVNC/x11vnc/archive/refs/tags/$X11VNC_VERSION.tar.gz"
echo "$X11VNC_SHA256  /tmp/x11vnc.tar.gz" | sha256sum -c -
sudo tar -xzf /tmp/x11vnc.tar.gz -C /tmp
(cd "/tmp/x11vnc-$X11VNC_VERSION" && CFLAGS=-fcommon PKG_CONFIG_PATH=/usr/local/lib64/pkgconfig:/usr/local/lib/pkgconfig ./autogen.sh && make -j2 && sudo make install)
sudo rm -rf /tmp/fluxbox.tar.xz "/tmp/fluxbox-$FLUXBOX_VERSION" /tmp/libvncserver.tar.gz "/tmp/libvncserver-LibVNCServer-$LIBVNCSERVER_VERSION" /tmp/libvncserver-build /tmp/x11vnc.tar.gz "/tmp/x11vnc-$X11VNC_VERSION"

sudo ln -sf ${VERCEL_PYTHON_BIN} /usr/local/bin/python3
sudo ln -sf ${VERCEL_PYTHON_BIN} /usr/local/bin/python
if ! ${VERCEL_PYTHON_BIN} -m pip --version >/dev/null 2>&1; then
  sudo ${VERCEL_PYTHON_BIN} -m ensurepip --upgrade
fi
sudo ${VERCEL_PYTHON_BIN} -m pip install --break-system-packages uv httpx websockets websockify 'pydantic>=2.0' 'PyJWT[crypto]' || sudo ${VERCEL_PYTHON_BIN} -m pip install uv httpx websockets websockify 'pydantic>=2.0' 'PyJWT[crypto]'

sudo mkdir -p /usr/share/novnc
curl -fsSL -o /tmp/novnc.tar.gz "https://github.com/novnc/noVNC/archive/refs/tags/v$NOVNC_VERSION.tar.gz"
echo "$NOVNC_SHA256  /tmp/novnc.tar.gz" | sha256sum -c -
sudo tar -xzf /tmp/novnc.tar.gz -C /usr/share/novnc --strip-components=1
sudo rm -f /tmp/novnc.tar.gz
command -v Xvfb
command -v fluxbox
command -v x11vnc
command -v websockify
test -f /usr/share/novnc/vnc.html

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
