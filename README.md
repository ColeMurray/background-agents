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
- Use your choice of AI model — Anthropic Claude or OpenAI Codex via your ChatGPT subscription

## Security Model (Single-Tenant Only)

> **Important**: This system is designed for **single-tenant deployment only**, where all users are
> trusted members of the same organization with access to the same repositories.

### How It Works

The system uses a shared deployment-level SCM integration for clone and push operations. This means:

- **All users share the deployment's SCM app credentials** - the active provider is selected with
  `SCM_PROVIDER`, and any user of the system can access any repo the deployment-level app can
  access
- **No per-user repository access validation** - The system does not verify that a user has
  permission to access a specific repository before creating a session
- **User OAuth tokens are used for PR creation** - PRs are created using the user's SCM OAuth
  token, ensuring proper attribution and that users can only create PRs on repos they have write
  access to

### Token Architecture

| Token Type       | Purpose                | Scope                            |
| ---------------- | ---------------------- | -------------------------------- |
| App Token        | Clone repos, push code | All repos where the app can access |
| User OAuth Token | Create PRs, user info  | Repos user has access to         |
| WebSocket Token  | Real-time session auth | Single session                   |

### Why Single-Tenant Only

This architecture follows
[Ramp's Inspect design](https://builders.ramp.com/post/why-we-built-our-background-agent), which was
built for internal use where all employees are trusted and have access to company repositories.

**For multi-tenant deployment**, you would need:

- Per-tenant SCM app installations
- Access validation at session creation
- Tenant isolation in the data model

### Deployment Recommendations

1. **Deploy behind your organization's SSO/VPN** - Ensure only authorized employees can access the
   web interface
2. **Install the SCM app only on intended repositories** - The app's installation scope defines what
   the system can access
3. **Use provider-side repository selection** - limit the installation to the repositories you want
   the system to access

## Architecture

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
│                     Control Plane (Cloudflare)                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                   Durable Objects (per session)               │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌───────────────┐   │  │
│  │  │ SQLite  │  │WebSocket│  │  Event  │  │     SCM       │   │  │
│  │  │   DB    │  │   Hub   │  │ Stream  │  │ Integration   │   │  │
│  │  └─────────┘  └─────────┘  └─────────┘  └───────────────┘   │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              D1 Database (repo-scoped secrets)                │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────┬───────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│                      Data Plane (Modal)                             │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                     Session Sandbox                           │  │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐                 │  │
│  │  │ Supervisor│──│  OpenCode │──│   Bridge  │─────────────────┼──┼──▶ Control Plane
│  │  └───────────┘  └───────────┘  └───────────┘                 │  │
│  │                      │                                        │  │
│  │              Full Dev Environment                             │  │
│  │        (Node.js, Python, git, Playwright)                     │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

## Packages

| Package                                 | Description                          |
| --------------------------------------- | ------------------------------------ |
| [modal-infra](packages/modal-infra)     | Modal sandbox infrastructure         |
| [control-plane](packages/control-plane) | Cloudflare Workers + Durable Objects |
| [web](packages/web)                     | Next.js web client                   |
| [shared](packages/shared)               | Shared types and utilities           |

## Getting Started

For a practical setup guide (local + contributor + deployment paths), start with
**[docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md)**.

See **[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)** for deployment instructions.

To understand the architecture and core concepts, read
**[docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md)**.

To set up recurring scheduled tasks, see **[docs/AUTOMATIONS.md](docs/AUTOMATIONS.md)**.

## Key Features

### Fast Startup

Sessions start near-instantly using Modal filesystem snapshots:

- Images rebuilt every 30 minutes with latest code
- Dependencies pre-installed and cached
- Sandboxes warmed proactively when user starts typing

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
  name: author.scmName,
  email: author.scmEmail,
});
```

### Multi-Provider Model Support

Choose the AI model that fits your task — Anthropic Claude or OpenAI Codex:

| Provider  | Models                                |
| --------- | ------------------------------------- |
| Anthropic | Claude Haiku, Sonnet, Opus            |
| OpenAI    | GPT 5.2, GPT 5.2 Codex, GPT 5.3 Codex |

OpenAI models work with your existing ChatGPT subscription — no separate API key needed. See
**[docs/OPENAI_MODELS.md](docs/OPENAI_MODELS.md)** for setup instructions.

### Repository Lifecycle Scripts

Repositories can define two optional startup scripts under `.openinspect/`:

```bash
# .openinspect/setup.sh (provisioning)
#!/bin/bash
npm install
pip install -r requirements.txt
```

```bash
# .openinspect/start.sh (runtime startup)
#!/bin/bash
docker compose up -d postgres redis
```

- `setup.sh` runs for image builds and fresh sessions
- `setup.sh` is skipped for repo-image and snapshot-restore starts
- `setup.sh` failures are non-fatal for fresh sessions, but fatal in image build mode
- `start.sh` runs for every non-build session startup (fresh, repo-image, snapshot-restore)
- `start.sh` failures are strict: if present and it fails, session startup fails
- Default timeouts:
  - `SETUP_TIMEOUT_SECONDS` (default `300`)
  - `START_TIMEOUT_SECONDS` (default `120`)
- Both hooks receive `OPENINSPECT_BOOT_MODE` (`build`, `fresh`, `repo_image`, `snapshot_restore`)

## License

MIT

## Credits

Inspired by [Ramp's Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent) and
built with:

- [Modal](https://modal.com) - Cloud sandbox infrastructure
- [Cloudflare Workers](https://workers.cloudflare.com) - Edge computing
- [OpenCode](https://opencode.ai) - Coding agent runtime
- [Next.js](https://nextjs.org) - Web framework
