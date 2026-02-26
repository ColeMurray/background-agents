# AGENTS.md

Background Agents is a local-first background coding agent system. It spawns sandboxed Docker
environments to work on local git repositories. Stack: Fastify (TypeScript), Docker, Next.js
(React), SQLite.

## Architecture

Two tiers connected by WebSockets:

1. **Web Client** (Next.js) — session dashboard, real-time streaming, settings UI
2. **API Server** (Fastify + better-sqlite3) — session lifecycle, WebSocket hub, Docker container
   management, git worktree management

Each session gets a Docker container running a coding agent (OpenCode) with a Python bridge that
streams events back to the server via WebSocket.

**Data flow**: User prompt → web client → API server (WebSocket) → Docker sandbox → streaming events
back through the same WebSocket chain.

### Package Dependency Graph

```
@background-agents/shared  ←  server, web
```

**Build `@background-agents/shared` first** whenever you change shared types. Other packages import
from it at build time.

## Package Overview

| Package   | Lang / Framework                   | Purpose                                           |
| --------- | ---------------------------------- | ------------------------------------------------- |
| `shared`  | TypeScript                         | Shared types, model definitions, git utilities    |
| `server`  | TypeScript / Fastify + SQLite      | Session management, WebSocket hub, Docker mgmt    |
| `web`     | TypeScript / Next.js 16 + React 19 | User-facing dashboard, real-time UI               |
| `sandbox` | Python 3.12 + Dockerfile           | Docker image with coding agent + WebSocket bridge |

## Common Commands

```bash
# Start dev (builds shared, checks Docker, starts server + web)
./scripts/dev.sh

# Install & build
npm install
npm run build                                    # all packages
npm run build -w @background-agents/shared       # shared only (build first!)

# Lint & format
npm run lint:fix                                 # ESLint + Prettier fix
npm run format                                   # Prettier only
npm run typecheck                                # tsc across all TS packages

# Tests
npm test -w @background-agents/web

# Build sandbox Docker image
docker build -t background-agents-sandbox packages/sandbox/
```

## Coding Conventions

### Durations and timeouts

- **Use seconds for Python, milliseconds for TypeScript.**
- **Encode the unit in the name.** Python: `timeout_seconds`. TypeScript: `timeoutMs`,
  `INACTIVITY_TIMEOUT_MS`. Never use a bare `timeout`.
- **Define each default value exactly once.** Extract to a named constant and import everywhere.

### Extending existing patterns

- When threading an existing field through new code paths, evaluate whether the existing design
  (naming, types, units) is correct — don't blindly propagate it. Fix bad names or units in the same
  change rather than spreading the problem.

### Commit messages

Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`. Keep the subject
under 72 characters. Use the PR body for details, not the commit message.

## Key Gotchas

- **Build order**: always build `@background-agents/shared` before packages that depend on it.
- **Docker Desktop required**: the server manages containers via the Docker API.
- **host.docker.internal**: sandbox containers connect back to the host server using this hostname
  (automatic on macOS Docker Desktop).
- **Credentials mounting**: `~/.ssh`, `~/.gitconfig`, `~/.config/gh` are mounted read-only into
  sandbox containers for git push and `gh` CLI support.
- **SQLite WAL**: the server uses WAL mode for concurrent reads. Data is stored at
  `~/.local/share/background-agents/data.sqlite` by default.
