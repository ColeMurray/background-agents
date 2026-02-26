##
## Sandbox image for background-agents.
##
## Provides a complete dev environment for the coding agent:
##   - Debian slim + Node.js 22 + Python 3.12
##   - git, gh CLI, pnpm, Bun
##   - OpenCode CLI (coding agent)
##   - Playwright + Chromium (visual verification)
##   - Bridge process (WebSocket to local server)
##
## Build:  docker build -t background-agents-sandbox packages/sandbox/
## Test:   docker run --rm background-agents-sandbox opencode --version
##

FROM debian:bookworm-slim

# ─── System packages ─────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    build-essential \
    ca-certificates \
    gnupg \
    openssh-client \
    jq \
    unzip \
    python3 \
    python3-pip \
    python3-venv \
    # Playwright dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
  && rm -rf /var/lib/apt/lists/*

# ─── GitHub CLI ───────────────────────────────────────────────────────────────
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# ─── Node.js 22 LTS ──────────────────────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y nodejs \
  && node --version && npm --version

# ─── pnpm + Bun ──────────────────────────────────────────────────────────────
RUN npm install -g pnpm@latest \
  && curl -fsSL https://bun.sh/install | bash

# ─── Python packages ─────────────────────────────────────────────────────────
RUN pip3 install --break-system-packages --no-cache-dir \
    uv \
    httpx \
    websockets \
    playwright \
    "pydantic>=2.0" \
    "PyJWT[crypto]"

# ─── OpenCode CLI ─────────────────────────────────────────────────────────────
RUN npm install -g opencode-ai@latest \
  && npm install -g @opencode-ai/plugin@latest zod \
  && (opencode --version || echo 'OpenCode installed')

# ─── Playwright Chromium ──────────────────────────────────────────────────────
RUN playwright install chromium \
  && playwright install-deps chromium

# ─── Working directories ─────────────────────────────────────────────────────
RUN mkdir -p /workspace /app/plugins /tmp/opencode

# ─── Environment ──────────────────────────────────────────────────────────────
ENV HOME=/root \
    NODE_ENV=development \
    PNPM_HOME=/root/.local/share/pnpm \
    PATH="/root/.bun/bin:/root/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin" \
    PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright \
    PYTHONPATH=/app \
    NODE_PATH=/usr/lib/node_modules

# ─── Sandbox code ────────────────────────────────────────────────────────────
COPY sandbox/ /app/sandbox/

WORKDIR /workspace

ENTRYPOINT ["python3", "-m", "sandbox.entrypoint"]
