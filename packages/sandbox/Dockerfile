# Sandbox container for Open-Inspect on Cloudflare
# Base image includes the Sandbox SDK internal daemon with Bun pre-installed
# We add OpenCode CLI and our supervisor/bridge on top

FROM docker.io/cloudflare/sandbox:0.7.0

# Add opencode install location to PATH
ENV PATH="/root/.opencode/bin:${PATH}"

# Install OpenCode CLI
RUN curl -fsSL https://opencode.ai/install -o /tmp/install-opencode.sh \
    && bash /tmp/install-opencode.sh \
    && rm /tmp/install-opencode.sh \
    && opencode --version

# Create app directory for our supervisor and bridge
RUN mkdir -p /app

# Copy compiled TypeScript (built by npm run build)
COPY dist/ /app/

# Copy OpenCode plugin for PR creation
COPY inspect-plugin.js /app/

# Default workspace directory
WORKDIR /workspace

# Expose OpenCode server port for internal communication
EXPOSE 4096
