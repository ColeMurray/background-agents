# Background Agents: Open-Inspect

An open-source background agents coding system inspired by
[Ramp's Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent).

![Open-Inspect web UI: session sidebar and new session composer](docs/images/ui-overview.png)

## Overview

Open-Inspect provides a hosted background coding agent that can:

- Work on tasks in the background while you focus on other things
- Access full development environments (Node.js, Python, git, browser automation, VS Code)
- Connect from anywhere — web UI, Slack, GitHub PRs, Linear issues, or webhooks
- Enable multiplayer sessions where multiple people can collaborate in real time
- Create PRs with proper commit attribution to the prompting user
- Run scheduled automations for cron jobs, or event-driven automations for GitHub events, Sentry
  alerts, and webhooks
- Spawn parallel sub-tasks that work in separate sandboxes simultaneously
- Use your choice of AI model — Anthropic Claude (via API key or a connected Claude subscription on
  the Claude Agent harness), OpenAI Codex (via ChatGPT subscription), xAI Grok (via SuperGrok
  subscription), or OpenCode Zen

## Security Model (Single-Tenant Only)

> **Important**: This system is designed for **single-tenant deployment only**, where all users are
> trusted members of the same organization. Teams add internal access controls, not tenant
> isolation.

### How It Works

Teams own sessions, environments, and automations. A session's Workspace, Team, or Private
visibility is separate from its fixed ownership; resources cannot move between teams or to/from the
workspace. Team-owned session actions require current owning-team membership, even for workspace
Owners and Administrators. With enforcement on, deletion additionally requires `sessions.delete` and
being the session owner, an owning-team lead, or a workspace administrator; team-owned and private
sessions apply their action checks in every mode.

Private sessions are readable by their owner and explicit collaborators. Workspace Owners have an
audited break-glass read path, not automatic collaboration or sandbox access. Team visibility's read
boundary requires `TEAMS_ENFORCEMENT=on`; the deployment default remains `shadow`.

For a single-team deployment, create one team, add the users who need to act on its sessions, and
grant its repositories. Existing workspace-owned rows are not moved or hidden. Even with every user
in one team, being a Member does not let someone delete another member's session under enforcement
unless they satisfy the ownership/lead rule. Follow the
[first-team setup](docs/GETTING_STARTED.md#step-10-create-the-first-team-and-test-a-session) before
inviting users.

The shared GitHub App installation bounds workspace repository reach. Sandbox git credentials are
limited to the session's persisted repositories and, for team-owned sessions, current owning-team
grants. Workspace permissions and resource access still apply; Open-Inspect does not compare a
user's personal GitHub repository permissions before creating a session. GitLab credentials remain a
deployment-wide PAT rather than a per-session token.

Credentials are brokered on demand but cached on disk, so snapshots can retain them. Grant removal
does not immediately revoke issued tokens. See the canonical
[Authentication and Authorization guide](docs/AUTH.md) for access rules and
[credential boundaries](docs/AUTH.md#repository-and-credential-boundaries), including user versus
App identity and snapshot limitations.

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
3. **Restrict sign-in** - Configure allowed GitHub users, email domains, or active GitHub
   organization membership (`ALLOWED_GITHUB_ORGS`)
4. **Use GitHub's repository selection** - When installing the App, select specific repositories
   rather than "All repositories"

See [Authentication and Authorization](docs/AUTH.md) for workspace roles, session access, automation
ownership, bots, and member suspension.

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
│                 Data Plane (Sandbox Backend)                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                     Session Sandbox                          │  │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐                 │  │
│  │  │ Supervisor│──│  Harness  │──│   Bridge  │─────────────────┼──┼──▶ Control Plane
│  │  └───────────┘  │ (OpenCode │  └───────────┘                 │  │
│  │                 │ or Claude)│                                │  │
│  │                 └───────────┘                                │  │
│  │                      │                                       │  │
│  │              Full Dev Environment                            │  │
│  │      (Node.js, Python, git, agent-browser)                   │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

## Packages

| Package                                           | Description                                 |
| ------------------------------------------------- | ------------------------------------------- |
| [control-plane](packages/control-plane)           | Cloudflare Workers + Durable Objects        |
| [web](packages/web)                               | Next.js web client                          |
| [sandbox-runtime](packages/sandbox-runtime)       | Shared in-sandbox agent runtime             |
| [modal-infra](packages/modal-infra)               | Modal sandbox infrastructure                |
| [daytona-infra](packages/daytona-infra)           | Daytona snapshot infrastructure             |
| [e2b-infra](packages/e2b-infra)                   | E2B sandbox template infrastructure         |
| [opencomputer-infra](packages/opencomputer-infra) | OpenComputer template infrastructure        |
| [slack-bot](packages/slack-bot)                   | Slack integration (sessions from messages)  |
| [github-bot](packages/github-bot)                 | GitHub integration (auto-review, @mention)  |
| [linear-bot](packages/linear-bot)                 | Linear integration (issue → coding session) |
| [shared](packages/shared)                         | Shared types and utilities                  |

## Getting Started

For a practical setup guide (local + contributor + deployment paths), start with
**[docs/SETUP_GUIDE.md](docs/SETUP_GUIDE.md)**.

See **[docs/GETTING_STARTED.md](docs/GETTING_STARTED.md)** for deployment instructions.

To understand the architecture and core concepts, read
**[docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md)**.

To set up recurring scheduled tasks, see **[docs/AUTOMATIONS.md](docs/AUTOMATIONS.md)**.

To create and use reusable agent instructions, see
**[docs/MANAGED_SKILLS.md](docs/MANAGED_SKILLS.md)**.

## Key Features

### Fast Startup

Sessions start near-instantly through multiple layers of warming:

- **Filesystem snapshots** — After each prompt, sandbox state is saved; follow-up sessions restore
  instead of re-cloning
- **Pre-built images** — Toggle per-repo (Settings > Images) or per-environment (Settings >
  Environments); rebuilt every 30 minutes with latest commits and dependencies
- **Proactive warming** — Sandbox begins spinning up as soon as you start typing, before you hit
  Enter

### Multi-Repository Sessions & Environments

One session can work across several repositories in a single sandbox:

- **Ad-hoc sets** — Pick up to 10 repositories in the new-session picker; each is cloned side by
  side and the agent can make coordinated changes and open a PR per repository
- **Environments** — Save a repository set as a named environment with its own secrets scope and
  optional prebuilt images, then launch it from the picker like any repository
- See [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md#environments) for the model and
  [docs/IMAGE_PREBUILD.md](docs/IMAGE_PREBUILD.md) for environment prebuilds

### Managed Skills

Create reusable instructions and supporting files that agents receive when a session starts:

- Assign shared skills globally or to selected repositories and environments
- Save personal profiles for frequently used skill sets
- Pin exact skill revisions to each session for repeatable behavior
- See [docs/MANAGED_SKILLS.md](docs/MANAGED_SKILLS.md) for the user guide

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

Anthropic and OpenAI models are enabled by default. xAI / SuperGrok, OpenCode Zen and Go, Z.AI
Coding Plan, and DeepSeek models are opt-in. See [Available Models](docs/AVAILABLE_MODELS.md) for
current model IDs, descriptions, and reasoning efforts.

OpenAI models work with your existing ChatGPT subscription via OAuth — no separate API key needed.
Anthropic models can run on the **Claude Agent** harness with a connected Claude subscription; see
[Using the Claude Agent Harness](docs/CLAUDE_AGENT.md). Grok models work with an eligible SuperGrok
subscription through control-plane-managed OAuth. See
**[docs/OPENAI_MODELS.md](docs/OPENAI_MODELS.md)** or **[docs/GROK_MODELS.md](docs/GROK_MODELS.md)**
for subscription setup instructions.

### Client Integrations

Interact with agents from wherever your team already works:

- **Web UI** — Full session management with real-time streaming, model/reasoning selectors, terminal
  panel, and multiplayer presence
- **Slack Bot** — @mention or DM to start a session, with PNG, JPEG, WebP, and GIF prompt
  attachments; replies thread back with results. Per-user model and branch preferences via App Home.
  See [Slack integration](docs/integrations/SLACK.md)
- **GitHub Bot** — Auto-review on PR open or respond to @mentions in PR comments. Configurable
  per-repo. See [GitHub integration](docs/integrations/GITHUB.md)
- **Linear Bot** — Mention or assign the agent on an issue to start a coding session, post progress
  activities, and link the resulting PR. See [Linear integration](docs/integrations/LINEAR.md)
- **Webhooks** — Trigger sessions from any external system via authenticated HTTP POST

### Automations

Schedule recurring tasks or react to external events — no human in the loop:

- **Cron schedules** — Hourly, daily, weekly, monthly, or custom 5-field cron with timezone support
- **Sentry alerts** — Auto-triage on new errors, regressions, or critical metric alerts
- **GitHub workflow runs** — Start work when a GitHub Actions workflow finishes, with optional
  workflow-name and conclusion filters
- **Inbound webhooks** — JSONPath condition filters to gate which payloads spawn sessions
- **Multi-repo fan-out** — One scheduled automation can run across up to 10 repositories, opening a
  separate session and pull request for each
- Auto-pause after 5 consecutive failures, configurable concurrent runs per automation, manual
  trigger button, full run history

See **[docs/AUTOMATIONS.md](docs/AUTOMATIONS.md)** for setup instructions.

### Sandbox Environment

Every session runs in an isolated sandbox backend with a full development environment:

- **Pre-installed:** Node.js 24, Python 3.12, Bun, git, GitHub CLI, build-essential
- **Browser automation:** agent-browser CLI with headless Chromium for screenshots, visual diffs,
  and UI verification
- **Code-server:** Optional browser-based VS Code connected to the session workspace
- **Web terminal:** ttyd-powered terminal accessible from the session UI
- **Port tunneling:** Expose up to 10 dev server ports via encrypted tunnels. URLs are available
  in-sandbox at `/workspace/.tunnels.env` before `.openinspect/start.sh` runs
  ([details](docs/HOW_IT_WORKS.md#tunnel-urls-inside-the-sandbox))
- **Secrets:** AES-256-GCM encrypted, scoped globally, per-repo, or per-environment, injected as env
  vars at spawn time. Supports bulk `.env` paste import

### Child Sessions

Agents can decompose work into parallel child sessions:

- `spawn-child` creates a child session in its own sandbox and returns immediately
- Parent continues working while children run in parallel on separate branches
- `send-child-prompt` queues follow-up instructions in an existing direct child session
- `get-child-status` and `cancel-child` coordinate child sessions
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
- `setup.sh` is skipped for prebuilt-image and snapshot-restore starts
- `setup.sh` failures are non-fatal for fresh sessions, but fatal in image build mode
- `start.sh` runs for every non-build session startup (fresh, prebuilt-image, snapshot-restore)
- `start.sh` failures are strict: if present and it fails, session startup fails
- Open-Inspect does not impose hook-specific timeouts. Scripts remain subject to the boot budget
  (`SANDBOX_BOOT_TIMEOUT_MS`, 30 minutes by default, measured across the whole session boot), to
  enclosing sandbox shutdown and image-build limits, and can apply their own command-specific
  deadlines when needed.
- Each script's progress is reported to the session while it runs. Failure reports retain the phase,
  repository when available, and error or warning metadata, but hook stdout and stderr are discarded
  rather than collected or shown. Image builds report neither, having no session to report to. See
  [How Open-Inspect Works](docs/HOW_IT_WORKS.md#fresh-start-no-snapshot)
- Both hooks receive `OPENINSPECT_BOOT_MODE` (`build`, `fresh`, `repo_image`, `snapshot_restore`)
- Git operations in hooks can authenticate to other private repos on the configured SCM host when
  the shared installation has access

## License

MIT

## Credits

Inspired by [Ramp's Inspect](https://builders.ramp.com/post/why-we-built-our-background-agent) and
built with:

- [Modal](https://modal.com) - Cloud sandbox infrastructure
- [Daytona](https://www.daytona.io) - Cloud development sandboxes
- [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) - Cloud sandbox infrastructure
- [OpenComputer](https://www.opencomputer.dev) - Cloud sandbox infrastructure
- [E2B](https://e2b.dev) - Cloud sandbox infrastructure
- [Cloudflare Workers](https://workers.cloudflare.com) - Edge computing
- [OpenCode](https://opencode.ai) - Coding agent runtime (built-in harness)
- [Claude Agent SDK](https://docs.anthropic.com/en/docs/agent-sdk) - Coding agent runtime (Claude
  Agent harness)
- [Next.js](https://nextjs.org) - Web framework
