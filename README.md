# Background Agents: Open-Inspect

An open-source background agents coding system inspired by
[Ramp's Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent).

## Overview

Open-Inspect provides a hosted background coding agent that can:

- Work on tasks in the background while you focus on other things
- Access full development environments (Node.js, Python, git, browser automation, VS Code)
- Connect from anywhere — web UI, Slack, GitHub PRs, Linear issues, or webhooks
- Enable multiplayer sessions where multiple people can collaborate in real time
- Create PRs with proper commit attribution to the prompting user
- Run on a schedule — cron jobs, Sentry alerts, and webhook-triggered automations
- Spawn parallel sub-tasks that work in separate sandboxes simultaneously
- Use your choice of AI model — Anthropic Claude, OpenAI Codex (via ChatGPT subscription), or
  OpenCode Zen

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

### Why Single-Tenant Only

This architecture follows
[Ramp's Inspect design](https://builders.ramp.com/post/why-we-built-our-background-agent), which was
built for internal use where all employees are trusted and have access to company repositories.

**For multi-tenant deployment**, you would need:

- Per-tenant GitHub App installations
- Access validation at session creation
- Tenant isolation in the data model

### Deployment Recommendations

1. **Deploy behind your organization's SSO/VPN** - Ensure only authorized employees can access the
   web interface
2. **Install GitHub App only on intended repositories** - The App's installation scope defines what
   the system can access
3. **Use GitHub's repository selection** - When installing the App, select specific repositories
   rather than "All repositories"

## Architecture

```
                                    ┌──────────────────┐
                                    │     Clients      │
                                    │ ┌──────────────┐ │
                                    │ │  Web / Slack │ │
                                    │ │ GitHub / Lin.│ │
                                    │ │   Webhooks   │ │
                                    │ └──────────────┘ │
                                    └────────┬─────────┘
                                             │
                                             ▼
┌────────────────────────────────────────────────────────────────────┐
│                     Control Plane (Cloudflare)                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                   Durable Objects (per session)              │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌───────────────┐    │  │
│  │  │ SQLite  │  │WebSocket│  │  Event  │  │   GitHub      │    │  │
│  │  │   DB    │  │   Hub   │  │ Stream  │  │ Integration   │    │  │
│  │  └─────────┘  └─────────┘  └─────────┘  └───────────────┘    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              D1 Database (repo-scoped secrets)               │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────┬───────────────────────────────────┘
                                 │
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│                      Data Plane (Modal)                            │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                     Session Sandbox                          │  │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐                 │  │
│  │  │ Supervisor│──│  OpenCode │──│   Bridge  │─────────────────┼──┼──▶ Control Plane
│  │  └───────────┘  └───────────┘  └───────────┘                 │  │
│  │                      │                                       │  │
│  │              Full Dev Environment                            │  │
│  │      (Node.js, Python, git, agent-browser)                   │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

## Packages

| Package                                 | Description                                 |
| --------------------------------------- | ------------------------------------------- |
| [modal-infra](packages/modal-infra)     | Modal sandbox infrastructure                |
| [control-plane](packages/control-plane) | Cloudflare Workers + Durable Objects        |
| [web](packages/web)                     | Next.js web client                          |
| [slack-bot](packages/slack-bot)         | Slack integration (sessions from messages)  |
| [github-bot](packages/github-bot)       | GitHub integration (auto-review, @mention)  |
| [linear-bot](packages/linear-bot)       | Linear integration (issue → coding session) |
| [shared](packages/shared)               | Shared types and utilities                  |

## Getting Started

For a practical setup guide (local + contributor + deployment paths), start with
**[docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md)**.

See **[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)** for deployment instructions.

To understand the architecture and core concepts, read
**[docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md)**.

To set up recurring scheduled tasks, see **[docs/AUTOMATIONS.md](docs/AUTOMATIONS.md)**.

## Key Features

### Fast Startup

Sessions start near-instantly through multiple layers of warming:

- **Filesystem snapshots** — After each prompt, sandbox state is saved; follow-up sessions restore
  instead of re-cloning
- **Pre-built repo images** — Toggle per-repo in Settings; rebuilt every 30 minutes with latest
  commits and dependencies
- **Proactive warming** — Sandbox begins spinning up as soon as you start typing, before you hit
  Enter

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

Choose the AI model that fits your task, with per-session reasoning effort controls:

| Provider     | Models                                                      |
| ------------ | ----------------------------------------------------------- |
| Anthropic    | Claude Haiku 4.5, Sonnet 4.5/4.6, Opus 4.5/4.6              |
| OpenAI       | GPT 5.2, GPT 5.4, GPT 5.2 Codex, 5.3 Codex, 5.3 Codex Spark |
| OpenCode Zen | Kimi K2.5, MiniMax M2.5, GLM 5 (opt-in)                     |

OpenAI models work with your existing ChatGPT subscription via OAuth — no separate API key needed.
See **[docs/OPENAI_MODELS.md](docs/OPENAI_MODELS.md)** for setup instructions.

### Client Integrations

Interact with agents from wherever your team already works:

- **Web UI** — Full session management with real-time streaming, model/reasoning selectors, terminal
  panel, and multiplayer presence
- **Slack Bot** — @mention or DM to start a session; replies thread back with results. Per-user
  model and branch preferences via App Home
- **GitHub Bot** — Auto-review on PR open, respond to @mentions in PR comments, or trigger on
  reviewer assignment. Configurable per-repo
- **Linear Bot** — Assign an issue to the agent and it creates a coding session, posts progress
  activities, and links the resulting PR
- **Webhooks** — Trigger sessions from any external system via authenticated HTTP POST

### Automations

Schedule recurring tasks or react to external events — no human in the loop:

- **Cron schedules** — Hourly, daily, weekly, monthly, or custom 5-field cron with timezone support
- **Sentry alerts** — Auto-triage on new errors, regressions, or critical metric alerts
- **Inbound webhooks** — JSONPath condition filters to gate which payloads spawn sessions
- Auto-pause after 3 consecutive failures, manual trigger button, full run history

See **[docs/AUTOMATIONS.md](docs/AUTOMATIONS.md)** for setup instructions.

### Sandbox Environment

Every session runs in an isolated Modal sandbox with a full development environment:

- **Pre-installed:** Node.js 22, Python 3.12, Bun, git, GitHub CLI, build-essential
- **Browser automation:** agent-browser CLI with headless Chromium for screenshots, visual diffs,
  and UI verification
- **Code-server:** Optional browser-based VS Code connected to the session workspace
- **Web terminal:** ttyd-powered terminal accessible from the session UI
- **Port tunneling:** Expose up to 10 dev server ports via encrypted tunnels
- **Repo secrets:** AES-256-GCM encrypted, scoped per-repo or globally, injected as env vars at
  spawn time. Supports bulk `.env` paste import

### Sub-Task Spawning

Agents can decompose work into parallel child sessions:

- `spawn-task` creates a child session in its own sandbox and returns immediately
- Parent continues working while children run in parallel on separate branches
- `get-task-status` and `cancel-task` for coordination
- Depth limits and per-repo guardrails enforced

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
