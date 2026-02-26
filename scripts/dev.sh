#!/usr/bin/env bash
set -euo pipefail

# Background Agents - Development startup script
# Usage: ./scripts/dev.sh
#
# This script:
#   1. Builds the shared package
#   2. Builds the sandbox Docker image (if needed)
#   3. Starts the API server (port 8787)
#   4. Starts the Next.js dev server (port 3000)

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

echo -e "${GREEN}Background Agents${NC} - Development Mode"
echo ""

# ── Check prerequisites ───────────────────────────────────────────────────────

if ! command -v docker &>/dev/null; then
  echo -e "${RED}Error:${NC} Docker is not installed. Install Docker Desktop."
  exit 1
fi

if ! docker info &>/dev/null 2>&1; then
  echo -e "${RED}Error:${NC} Docker daemon is not running. Start Docker Desktop."
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo -e "${RED}Error:${NC} Node.js is not installed. Install Node.js >= 20."
  exit 1
fi

# Check for .env
if [ ! -f .env ]; then
  echo -e "${YELLOW}Warning:${NC} No .env file found. Copy .env.example to .env and add your API keys."
  echo "  cp .env.example .env"
  echo ""
fi

# ── Install dependencies ─────────────────────────────────────────────────────

echo "Installing dependencies..."
npm install --silent

# ── Build shared package ──────────────────────────────────────────────────────

echo "Building @background-agents/shared..."
npm run build -w @background-agents/shared

# ── Build sandbox Docker image ────────────────────────────────────────────────

IMAGE_NAME="${SANDBOX_IMAGE:-background-agents-sandbox}"

if ! docker image inspect "$IMAGE_NAME" &>/dev/null 2>&1; then
  echo "Building sandbox Docker image (this may take a few minutes on first run)..."
  docker build -t "$IMAGE_NAME" packages/sandbox/
else
  echo -e "Sandbox image ${GREEN}${IMAGE_NAME}${NC} already exists."
  echo "  To rebuild: docker build -t $IMAGE_NAME packages/sandbox/"
fi

echo ""

# ── Start servers ─────────────────────────────────────────────────────────────

echo -e "${GREEN}Starting servers...${NC}"
echo "  API server:  http://localhost:8787"
echo "  Web UI:      http://localhost:3000"
echo ""

# Run both in parallel, kill both on Ctrl+C
trap 'kill 0' EXIT

npm run dev -w @background-agents/server &
npm run dev -w @background-agents/web &

wait
