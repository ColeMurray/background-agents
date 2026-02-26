# Background Agents

A local-first background coding agent system. Spawn sandboxed Docker environments that work on your
repositories while you focus on other things.

Forked from [open-inspect/background-agents](https://github.com/open-inspect/background-agents),
simplified to run entirely on a single machine with no cloud dependencies.

## Features

- **Fully local** — no cloud services, no external accounts (except LLM API keys)
- **Docker sandboxes** — each session runs in an isolated container with a git worktree
- **Web UI** — Next.js dashboard for managing sessions, sending prompts, viewing agent output
- **Git push / PR support** — via mounted SSH keys and `gh` CLI
- **Model flexibility** — Anthropic Claude or OpenAI Codex, configurable per-session
- **Secrets management** — environment variables injected into sandboxes

## Prerequisites

- **Node.js** >= 20
- **Docker Desktop** (must be running)
- **OpenCode CLI** logged in (`opencode` → `/connect`), or explicit LLM API keys in `.env`

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/anomalyco/background-agents.git
cd background-agents
cp .env.example .env

# 2. Start everything
./scripts/dev.sh
```

If you're already logged into OpenCode with your Anthropic Pro/Max or ChatGPT Plus/Pro account, auth
carries over automatically — the sandbox mounts your `~/.local/share/opencode/auth.json` into each
container. No API keys needed.

This will:

1. Install npm dependencies
2. Build the shared types package
3. Build the sandbox Docker image (first run takes a few minutes)
4. Start the API server on **http://localhost:8787**
5. Start the Next.js web UI on **http://localhost:3000**

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────────┐
│   Web UI        │────▶│   API Server     │────▶│  Docker Sandbox     │
│   (Next.js)     │ WS  │   (Fastify)      │ WS  │  (OpenCode + Bridge)│
│   :3000         │◀────│   :8787          │◀────│                     │
└─────────────────┘     └──────────────────┘     └─────────────────────┘
                              │
                        ┌─────┴─────┐
                        │  SQLite   │
                        │  data.db  │
                        └───────────┘
```

### Packages

| Package   | Description                                                      |
| --------- | ---------------------------------------------------------------- |
| `shared`  | Shared types, model definitions, git utilities                   |
| `server`  | Fastify API server + WebSocket hub + SQLite storage              |
| `web`     | Next.js web UI — session dashboard, prompt input, settings       |
| `sandbox` | Docker image + Python supervisor (entrypoint + WebSocket bridge) |

## Development

```bash
# Start dev servers (server + web in parallel)
./scripts/dev.sh

# Or start individually:
npm run build -w @background-agents/shared   # Build shared first
npm run dev -w @background-agents/server     # API server with hot reload
npm run dev -w @background-agents/web        # Next.js dev server

# Rebuild the sandbox Docker image
docker build -t background-agents-sandbox packages/sandbox/

# Lint and format
npm run lint:fix
npm run format

# Type check
npm run typecheck
```

## Configuration

All configuration is via `.env` in the project root. See `.env.example` for options.

| Variable            | Required | Description                            |
| ------------------- | -------- | -------------------------------------- |
| `ANTHROPIC_API_KEY` | No\*     | Anthropic API key (if not using OAuth) |
| `OPENAI_API_KEY`    | No\*     | OpenAI API key (if not using OAuth)    |
| `REPOS_DIR`         | No       | Path to repos directory (~code)        |
| `PORT`              | No       | Server port (default: 8787)            |
| `DATA_DIR`          | No       | SQLite data directory                  |
| `SANDBOX_IMAGE`     | No       | Docker image name for sandboxes        |

\* Not needed if you're logged into OpenCode via OAuth (`opencode` → `/connect`).

### Host Mounts

The sandbox containers mount your host credentials:

- `~/.local/share/opencode/` — OpenCode OAuth tokens (read-write, for token refresh)
- `~/.config/opencode/` — OpenCode config (read-only)
- `~/.ssh` — for `git push` via SSH (read-only)
- `~/.gitconfig` — for commit identity (read-only)
- `~/.config/gh` — for `gh pr create` via GitHub CLI (read-only)

Make sure you're authenticated with `gh auth login` and have SSH keys set up for your repositories.

## License

Apache 2.0 — see [LICENSE](LICENSE).
