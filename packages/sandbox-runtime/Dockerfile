FROM python:3.12-slim-bookworm

# System packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl build-essential jq unzip ca-certificates gnupg openssh-client \
    # Playwright dependencies
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
    libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
    libatspi2.0-0 libwayland-client0 && \
    rm -rf /var/lib/apt/lists/*

# Node.js 22 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g pnpm@latest && \
    corepack enable

# Bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Python tools
RUN pip install --no-cache-dir \
    uv \
    httpx \
    websockets \
    playwright \
    "pydantic>=2.0" \
    "PyJWT[crypto]"

# Install Playwright browsers (Chromium only)
RUN playwright install chromium && \
    playwright install-deps chromium

# Install OpenCode CLI and plugin
RUN npm install -g opencode-ai@latest @opencode-ai/plugin@latest zod

# Create working directories
RUN mkdir -p /workspace /data /app/plugins /tmp/opencode

# Copy sandbox runtime code
COPY src/ /opt/sandbox/src/
COPY pyproject.toml /opt/sandbox/

WORKDIR /workspace

# Environment
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/opt/sandbox
ENV HOME=/root
ENV NODE_ENV=development
ENV PNPM_HOME=/root/.local/share/pnpm
ENV PATH="/root/.bun/bin:/root/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin"
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
ENV NODE_PATH=/usr/lib/node_modules

ENTRYPOINT ["python", "-m", "src.sandbox.entrypoint"]
