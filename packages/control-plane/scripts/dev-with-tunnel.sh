#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

npm run dev:setup

TUNNEL_STATE_DIR=".wrangler"
TUNNEL_STATE="$TUNNEL_STATE_DIR/dev-tunnel.env"
LOG="$(mktemp)"

mkdir -p "$TUNNEL_STATE_DIR"

TUNNEL_URL=""
CF_PID=""
if [[ -f "$TUNNEL_STATE" ]]; then
  # shellcheck disable=SC1090
  source "$TUNNEL_STATE"
  if [[ -n "${CF_PID:-}" ]] && kill -0 "$CF_PID" 2>/dev/null && [[ -n "${TUNNEL_URL:-}" ]]; then
    echo "Reusing cloudflared tunnel: $TUNNEL_URL"
  else
    TUNNEL_URL=""
    CF_PID=""
  fi
fi

if [[ -z "$TUNNEL_URL" ]]; then
  echo "Starting cloudflared tunnel to http://127.0.0.1:8787..."
  npx --yes cloudflared tunnel --url http://127.0.0.1:8787 >"$LOG" 2>&1 &
  CF_PID=$!

  for _ in $(seq 1 45); do
    TUNNEL_URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
    if [[ -n "$TUNNEL_URL" ]]; then
      break
    fi
    sleep 1
  done

  if [[ -z "$TUNNEL_URL" ]]; then
    echo "Failed to obtain a trycloudflare.com URL. cloudflared log:"
    cat "$LOG"
    exit 1
  fi

  cat >"$TUNNEL_STATE" <<EOF
CF_PID=$CF_PID
TUNNEL_URL=$TUNNEL_URL
EOF
fi

echo "Public control plane URL (for Islo sandboxes): $TUNNEL_URL"

if [[ ! -f .dev.vars ]]; then
  echo "Missing .dev.vars — copy .dev.vars.example first."
  exit 1
fi

if grep -q '^WORKER_URL=' .dev.vars; then
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s|^WORKER_URL=.*|WORKER_URL=$TUNNEL_URL|" .dev.vars
  else
    sed -i "s|^WORKER_URL=.*|WORKER_URL=$TUNNEL_URL|" .dev.vars
  fi
else
  echo "WORKER_URL=$TUNNEL_URL" >> .dev.vars
fi

exec npx wrangler dev --config wrangler.dev.jsonc
