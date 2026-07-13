# Open-Inspect E2B sandbox template.
#
# Mirrors the toolchain pinned in packages/daytona-infra/src/toolchain.py so an
# E2B sandbox boots the same sandbox-runtime supervisor that Modal and Daytona use.
# Keep the versions below in sync with toolchain.py.
#
# Built remotely on E2B (amd64) via the Template SDK — see build-template.py,
# which stages packages/sandbox-runtime/src/sandbox_runtime and applies the COPY /
# WORKDIR / start-command steps programmatically (API-key auth, no access token).
#
# Start command (set by build-template.py / Terraform, not ENTRYPOINT here):
#   python /usr/local/bin/oi-launch

FROM python:3.12-slim-bookworm

# Pinned toolchain versions (keep in sync with daytona-infra/src/toolchain.py).
ARG OPENCODE_VERSION=1.14.41
ARG CODE_SERVER_VERSION=4.109.5
ARG AGENT_BROWSER_VERSION=0.21.2

# System packages: git/build toolchain + headless-browser shared libs + ffmpeg.
RUN apt-get update \
  && apt-get install -y git curl build-essential ca-certificates gnupg \
     openssh-client jq unzip libnss3 libnspr4 libatk1.0-0 \
     libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
     libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
     libpango-1.0-0 libcairo2 ffmpeg \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
     | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' \
     > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && npm install -g pnpm@latest \
  # Install bun system-wide (not /root/.bun, which the runtime `user` can't read).
  && BUN_INSTALL=/usr/local curl -fsSL https://bun.sh/install | bash \
  && python -m pip install --upgrade pip

# Python runtime deps for the supervisor + bridge.
RUN pip install uv httpx websockets "pydantic>=2.0" "PyJWT[crypto]"

# Agent toolchain: OpenCode, code-server, agent-browser.
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" \
  && npm install -g "@opencode-ai/plugin@${OPENCODE_VERSION}" zod \
  && curl -fsSL -o /tmp/code-server.deb \
     "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server_${CODE_SERVER_VERSION}_amd64.deb" \
  && dpkg -i /tmp/code-server.deb \
  && rm /tmp/code-server.deb \
  && npm install -g "agent-browser@${AGENT_BROWSER_VERSION}" \
  && agent-browser install \
  && mkdir -p /workspace /app /tmp/opencode \
  # E2B runs as non-root `user`; the supervisor clones into /workspace and writes
  # /tmp/opencode, so make them world-writable (sticky).
  && chmod 1777 /workspace /tmp/opencode

# Build-time env only. E2B does NOT propagate Docker ENV to the runtime process,
# so the start command (build-template.py) re-exports PYTHONPATH / NODE_PATH;
# control-plane-injected vars (CONTROL_PLANE_URL, etc.) arrive via E2B envVars.
ENV HOME=/root \
    NODE_ENV=development \
    PATH=/usr/local/bin:/usr/bin:/bin \
    PYTHONPATH=/app \
    NODE_PATH=/usr/lib/node_modules \
    SANDBOX_VERSION=e2b-v1

# NOTE: file staging (sandbox_runtime, oi-launch.py), WORKDIR, and the start/ready
# commands are applied by build-template.py via the E2B Template SDK
# (.copy()/.setWorkdir()/.setStartCmd()) — not here. This Dockerfile defines only
# the base image layers; it is not built standalone.
