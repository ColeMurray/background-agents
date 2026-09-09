#!/usr/bin/env bash
# Kirk's workload tools, shared by its Modal and E2B images.
set -euo pipefail
case "$OI_PROVIDER" in modal|e2b) ;; *) exit 0 ;; esac
export PATH="/opt/openinspect/node/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export DEBIAN_FRONTEND=noninteractive
export COREPACK_HOME=/opt/corepack GOPATH=/opt/go GOTOOLCHAIN=local
apt-get update
apt-get install -y --no-install-recommends sudo postgresql-client ripgrep libnss3-tools iptables uidmap fuse-overlayfs
curl -fsSL --retry 3 --retry-all-errors https://dl.google.com/go/go1.25.8.linux-amd64.tar.gz | tar -C /usr/local -xzf -
ln -sf /usr/local/go/bin/go /usr/local/bin/go
ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
curl -fsSL https://github.com/golangci/golangci-lint/releases/download/v2.6.2/golangci-lint-2.6.2-linux-amd64.tar.gz | tar -C /usr/local/bin -xzf - --strip-components=1 --wildcards '*/golangci-lint'
chmod +x /usr/local/bin/golangci-lint
GOPATH=/tmp/gobuild GOBIN=/usr/local/bin GOFLAGS=-mod=mod go install github.com/air-verse/air@v1.62.0
rm -rf /tmp/gobuild
curl -fsSL https://cache.agilebits.com/dist/1P/op2/pkg/v2.39.0/op_linux_amd64_v2.39.0.zip -o /tmp/op.zip
unzip -o /tmp/op.zip -d /usr/local/bin op
chmod +x /usr/local/bin/op
rm /tmp/op.zip
curl -fsSL https://github.com/stripe/stripe-cli/releases/download/v1.50.6/stripe_1.50.6_linux_x86_64.tar.gz | tar -C /usr/local/bin -xzf - stripe
chmod +x /usr/local/bin/stripe
curl -fsSL -o /usr/local/bin/mkcert https://github.com/FiloSottile/mkcert/releases/download/v1.4.4/mkcert-v1.4.4-linux-amd64
chmod +x /usr/local/bin/mkcert
curl -fsSL https://github.com/grafana/gcx/releases/download/v1.2.0/gcx_1.2.0_linux_amd64.tar.gz | tar -C /usr/local/bin -xzf - gcx
chmod +x /usr/local/bin/gcx
curl -fsSL https://github.com/PostHog/posthog/releases/download/posthog-cli/v0.16.0/posthog-cli-x86_64-unknown-linux-gnu.tar.gz | tar -C /usr/local/bin -xzf - --strip-components=1 --wildcards '*/posthog-cli'
chmod +x /usr/local/bin/posthog-cli
git init -q /tmp/stripe-ai
(cd /tmp/stripe-ai && git remote add origin https://github.com/stripe/ai.git && git fetch -q --depth 1 origin e8f9aee6f9a34a633243e632e650401a76c36c41 && git checkout -q FETCH_HEAD)
mkdir -p "${OI_RUNTIME_HOME}/.agents/skills"
cp -a /tmp/stripe-ai/providers/claude/plugin/skills/. "${OI_RUNTIME_HOME}/.agents/skills/"
rm -rf /tmp/stripe-ai
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y --no-install-recommends docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
rm -rf /var/lib/apt/lists/*
mkdir -p /opt/corepack /opt/pnpm-home /opt/pnpm-store /opt/turbo-cache /opt/go/bin /opt/go/pkg/mod
chmod -R 1777 /opt/pnpm-home /opt/pnpm-store /opt/turbo-cache /opt/go
npm install -g @posthog/wizard@2.70.1 corepack@0.34.0
corepack install -g "pnpm@$PNPM_VERSION"
chmod -R a+rX /opt/corepack
gcx agent skills install --all --dir "${OI_RUNTIME_HOME}/.agents"
posthog-cli api agents-md install --path "${OI_RUNTIME_HOME}/.config/opencode/AGENTS.md"

# E2B runs as user; Modal runs as root. Both share these build-warmed caches.
if [[ "$OI_PROVIDER" == e2b ]]; then
  printf '%s\n' 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/oi-user
  chmod 0440 /etc/sudoers.d/oi-user
  for helper in iptables ip6tables useradd usermod groupadd service; do
    if [[ -x "/usr/sbin/$helper" ]]; then ln -sf "/usr/sbin/$helper" "/usr/local/bin/$helper"; fi
  done
fi
chown -R "$OI_RUNTIME_USER:$(id -gn "$OI_RUNTIME_USER")" "$OI_RUNTIME_HOME/.agents" "$OI_RUNTIME_HOME/.config/opencode"
rm -rf /var/lib/apt/lists/*
