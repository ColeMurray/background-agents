FROM node:22-slim AS node-base

FROM python:3.12-slim-bookworm

# Install Node.js from node-base
COPY --from=node-base /usr/local/bin/node /usr/local/bin/
COPY --from=node-base /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && \
    ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    gh \
    build-essential \
    ca-certificates \
    gnupg \
    openssh-client \
    jq \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install OpenCode
RUN npm install -g opencode-ai@latest

# Install Python dependencies for the bridge and supervisor
RUN pip install --no-cache-dir \
    httpx \
    websockets \
    "pydantic>=2.0"

# Setup workspace
WORKDIR /workspace

# Copy sandbox code
COPY packages/modal-infra/src/sandbox /app/sandbox
ENV PYTHONPATH=/app

# Expose ports
# OpenCode
EXPOSE 4096
# Reverse Proxy
EXPOSE 3000

# Set entrypoint to the supervisor
# Use module mode to support relative imports
ENTRYPOINT ["python", "-m", "sandbox.entrypoint"]
