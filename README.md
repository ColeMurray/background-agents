# Background Agents: Open-Inspect

An open-source background agents coding system inspired by
[Ramp's Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent).

## Overview

Open-Inspect provides a hosted background coding agent that can:

- Work on tasks in the background while you focus on other things
- Access full development environments with all tools engineers have
- Support multiple clients (web, Slack, Chrome extension)
- Enable multiplayer sessions where multiple people can collaborate
- Create PRs with proper commit attribution

## Security Model (Single-Tenant Only)

> **Important**: This system is designed for **single-tenant deployment only**, where all users are
> trusted members of the same organization with access to the same repositories.

### How It Works

The system uses a shared GitHub App installation for all git operations (clone, push). This means:

- **All users share the same GitHub App credentials** - The GitHub App must be installed on your
  organization's repositories, and any user of the system can access any repo the App has access to
- **No per-user repository access validation** - The system does not verify that a user has
  permission to access a specific repository before creating a session
- **User OAuth tokens are used for PR creation** - PRs are created using the user's GitHub OAuth
  token, ensuring proper attribution and that users can only create PRs on repos they have write
  access to

### Token Architecture

| Token Type       | Purpose                | Scope                            |
| ---------------- | ---------------------- | -------------------------------- |
| GitHub App Token | Clone repos, push code | All repos where App is installed |
| User OAuth Token | Create PRs, user info  | Repos user has access to         |
| WebSocket Token  | Real-time session auth | Single session                   |

## Architecture

Open-Inspect runs entirely on open-source infrastructure using Kubernetes:

```
                                    ┌──────────────────┐
                                    │     Clients      │
                                    │ ┌──────────────┐ │
                                    │ │     Web      │ │
                                    │ │    Slack     │ │
                                    │ │   Extension  │ │
                                    │ └──────────────┘ │
                                    └────────┬─────────┘
                                             │
                                             ▼
┌────────────────────────────────────────────────────────────────────┐
│               Control Plane (Rivet Actors on K8s)                   │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              Rivet Session Actors (per session)               │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌───────────────┐   │  │
│  │  │  Actor  │  │WebSocket│  │  Event  │  │   GitHub      │   │  │
│  │  │  State  │  │   Hub   │  │ Stream  │  │ Integration   │   │  │
│  │  └─────────┘  └─────────┘  └─────────┘  └───────────────┘   │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                  PostgreSQL (shared state)                     │  │
│  │           Sessions index, repo metadata, encrypted secrets     │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────┬───────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│                   Data Plane (Kubernetes Pods)                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                     Session Sandbox Pod                        │  │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐                 │  │
│  │  │ Supervisor│──│  OpenCode │──│   Bridge  │─────────────────┼──┼──▶ Control Plane
│  │  └───────────┘  └───────────┘  └───────────┘                 │  │
│  │                      │                                        │  │
│  │              Full Dev Environment                             │  │
│  │        (Node.js, Python, git, Playwright)                     │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

### Infrastructure Components

| Component        | Technology                  | Purpose                                |
| ---------------- | --------------------------- | -------------------------------------- |
| **Rivet Engine** | Rust orchestration on K8s   | Actor scheduling, state persistence    |
| **NATS**         | Message bus                 | Inter-service communication            |
| **PostgreSQL**   | Relational database         | Session index, repo metadata, secrets  |
| **Redis**        | In-memory cache             | Repository list caching                |
| **Hono**         | TypeScript HTTP framework   | API server for control plane           |
| **Next.js**      | React framework             | Web frontend                           |

## Packages

| Package                                       | Description                          |
| --------------------------------------------- | ------------------------------------ |
| [control-plane](packages/control-plane)       | Hono API + Rivet Session Actors      |
| [sandbox-runtime](packages/sandbox-runtime)   | Sandbox Docker image & runtime       |
| [web](packages/web)                           | Next.js web client                   |
| [shared](packages/shared)                     | Shared types and utilities           |

## Getting Started

See **[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)** for deployment instructions.

To understand the architecture and core concepts, read
**[docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md)**.

## Key Features

### Fast Startup

Sessions start quickly using pre-built container images:

- Docker images pre-built with all dependencies
- Sandboxes warmed proactively when user starts typing
- Kubernetes pod scheduling optimized for fast startup

### Multiplayer Sessions

Multiple users can collaborate in the same session:

- Presence indicators show who's active
- Prompts are attributed to their authors in git commits
- Real-time streaming to all connected clients

### Commit Attribution

Commits are attributed to the user who sent the prompt:

```typescript
// Configure git identity per prompt
await configureGitIdentity({
  name: author.githubName,
  email: author.githubEmail || generateNoreplyEmail(author.githubId, author.githubLogin),
});
```

### Repository Setup Scripts

Repositories can include a `.openinspect/setup.sh` script for custom environment setup:

```bash
# .openinspect/setup.sh
#!/bin/bash
npm install
pip install -r requirements.txt
```

- Runs automatically after git clone, before the agent starts
- Non-blocking: failures are logged but don't prevent the session from starting
- Default timeout: 5 minutes (configurable via `SETUP_TIMEOUT_SECONDS` environment variable)

## Self-Hosting

Open-Inspect runs on any Kubernetes cluster. Deployment manifests are provided in the `k8s/`
directory. See [docs/GETTING_STARTED.md](docs/GETTING_STARTED.md) for the full deployment guide.

### Prerequisites

- Kubernetes cluster (1.28+)
- kubectl configured
- Docker registry for custom images
- GitHub App for repository access
- Anthropic API key

### Quick Deploy

```bash
# Apply all Kubernetes manifests
kubectl apply -k k8s/

# Wait for services
kubectl -n open-inspect wait --for=condition=ready pod -l app=rivet-engine --timeout=300s
kubectl -n open-inspect wait --for=condition=ready pod -l app=postgres --timeout=300s

# Verify
kubectl -n open-inspect get pods
```

## License

MIT

## Credits

Inspired by [Ramp's Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent) and
built with:

- [Rivet](https://rivet.dev) - Open-source stateful actor infrastructure
- [Kubernetes](https://kubernetes.io) - Container orchestration
- [OpenCode](https://opencode.ai) - Coding agent runtime
- [Next.js](https://nextjs.org) - Web framework
- [Hono](https://hono.dev) - TypeScript HTTP framework
- [PostgreSQL](https://postgresql.org) - Relational database
