# How Open-Inspect Works

Open-Inspect is a background coding agent system. Unlike interactive coding assistants where you
watch the AI work in real-time, Open-Inspect runs sessions in the cloud independently of your
connection. You send a prompt, optionally close your laptop, and check the results later.

This guide covers the core architecture, how sessions work, and what happens when you send a prompt.
For deployment instructions, see [GETTING_STARTED.md](./GETTING_STARTED.md).

---

## The Background Model

The key insight behind Open-Inspect is that coding sessions don't need your constant attention.

**Traditional coding assistants** require you to stay connected:

```
You type → AI responds → You watch → You respond → Repeat
```

**Open-Inspect** decouples your presence from the work:

```
You send prompt → Session runs in background → You check results when ready
```

This enables workflows that aren't possible with interactive tools:

- **Fire and forget**: Notice a bug before bed, kick off a session, review the PR in the morning
- **Parallel sessions**: Run multiple approaches simultaneously without tying up your machine
- **Multiplayer**: Share a session URL with a colleague and collaborate in real-time
- **Unlimited concurrency**: Your laptop isn't the bottleneck—spin up as many sessions as you need

---

## Sessions

A **session** is the core unit of work in Open-Inspect. Each session is:

- **Tied to a repository**: The agent works in a clone of your repo
- **Persistent**: State survives across connections—close the browser, come back later
- **Multiplayer**: Multiple users can join, send prompts, and see events in real-time
- **Stateful**: Contains messages, events, artifacts, and sandbox state

### Session Lifecycle

```
Created → Active → Archived
            ↑
            └── Can be restored from archive
```

Sessions start when you create one (via web or Slack). They remain active as long as there's work
happening or recent activity. You can archive sessions to clean up your list, and restore them later
if needed.

### What's Stored in a Session

| Data          | Description                                       |
| ------------- | ------------------------------------------------- |
| Messages      | Prompts you've sent and their metadata            |
| Events        | Tool calls, token streams, status updates         |
| Artifacts     | PRs created, screenshots captured                 |
| Participants  | Users who have joined the session                 |
| Sandbox state | Reference to the current sandbox and its snapshot |

Each session gets its own SQLite database in a Cloudflare Durable Object, ensuring isolation and
high performance even with hundreds of concurrent sessions.

---

## Architecture

Open-Inspect uses a three-tier architecture spanning multiple cloud providers:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              Clients                                     │
│                    ┌───────────┬───────────┐                            │
│                    │    Web    │   Slack   │                            │
│                    └─────┬─────┴─────┬─────┘                            │
│                          │           │                                   │
└──────────────────────────┼───────────┼───────────────────────────────────┘
                           │           │
                           ▼           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Control Plane (Cloudflare)                            │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                    Durable Objects (per session)                    │ │
│  │  ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌────────────────┐  │ │
│  │  │  SQLite  │  │ WebSocket │  │   Event    │  │    Sandbox     │  │ │
│  │  │   State  │  │    Hub    │  │   Stream   │  │   Lifecycle    │  │ │
│  │  └──────────┘  └───────────┘  └────────────┘  └────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                   D1 Database (shared state)                        │ │
│  │           Sessions index, repo metadata, encrypted secrets          │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                 Data Plane (Sandbox Backend)                              │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                        Session Sandbox                              │ │
│  │  ┌────────────┐    ┌────────────┐    ┌────────────┐               │ │
│  │  │ Supervisor │───▶│  OpenCode  │───▶│   Bridge   │───────────────┼─┼──▶ Control Plane
│  │  └────────────┘    └────────────┘    └────────────┘               │ │
│  │                           │                                        │ │
│  │                    Full Dev Environment                            │ │
│  │              (Node.js, Python, git, Playwright)                    │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### Control Plane (Cloudflare Workers)

The control plane is the coordinator. It doesn't execute code—it manages state and routes messages.

**Responsibilities:**

- Session state management (SQLite in Durable Objects)
- WebSocket connections for real-time streaming
- Sandbox lifecycle orchestration (spawn, snapshot, restore)
- GitHub integration (repo listing, PR creation)
- Authentication and access control

**Why Cloudflare?** Durable Objects provide per-session isolation with SQLite storage. Each session
gets its own lightweight database that can handle hundreds of events per second without impacting
other sessions. The WebSocket Hibernation API keeps connections alive during idle periods without
incurring compute costs.

### Data Plane (Sandbox Backends)

The data plane is where code actually runs. Each session gets an isolated sandbox with a full
development environment.

**What's in a sandbox:**

- Debian Linux with common dev tools
- Node.js 22, Python 3.12, git, curl
- Package managers: npm, pnpm, pip, uv
- agent-browser CLI + headless Chrome (for browser automation)
- OpenCode (the coding agent)

Open-Inspect supports two backend patterns:

- **Modal**: near-instant startup plus filesystem snapshot restore
- **Daytona**: persistent stop/start sandboxes via direct REST API calls
- **Vercel Sandboxes**: filesystem snapshot restore and repo-image builds via the Vercel Sandbox API

Modal and Vercel support repo-image builds and live filesystem snapshot restore. Daytona uses
persistent sandboxes instead: the control plane stops the sandbox on inactivity or stale heartbeat,
then resumes that same sandbox later with the same logical sandbox ID and auth token.

### Clients

Clients are how users interact with sessions. The architecture is client-agnostic—any client that
can make HTTP requests and maintain WebSocket connections can participate.

**Current clients:**

- **Web**: Next.js app with real-time streaming, session management, and settings
- **Slack**: Bot that responds to @mentions and direct messages, classifies repos, and posts results
- **GitHub**: Bot that reviews PRs and responds to PR `@mentions`
- **Linear**: Agent workflow that starts sessions from Linear issue activity

All clients see the same session state. Send a prompt from Slack or GitHub, watch the results on
web. This works because state lives in the control plane, not the client.

---

## The Sandbox Lifecycle

Understanding the sandbox lifecycle explains why Open-Inspect can be fast despite running in the
cloud.

### Fresh Start (No Snapshot)

When you create a session for a repo without an existing snapshot:

```
┌─────────┐    ┌──────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌───────┐
│ Sandbox │───▶│ Git Sync │───▶│ Setup Script│───▶│ Start Script│───▶│ Agent Start │───▶│ Ready │
│ Created │    │ (clone)  │    │ (optional)  │    │ (optional)  │    │ (OpenCode)  │    │       │
└─────────┘    └──────────┘    └─────────────┘    └─────────────┘    └─────────────┘    └───────┘
                                     │                    │
                                     ▼                    ▼
                            .openinspect/setup.sh   .openinspect/start.sh
```

1. **Sandbox created**: The selected backend creates a fresh sandbox from its base runtime
2. **Git sync**: Clones your repository using brokered SCM credentials from the git credential
   helper
3. **Setup script**: Runs `.openinspect/setup.sh` for provisioning (if present)
4. **Start script**: Runs `.openinspect/start.sh` for runtime startup (if present)
5. **Agent start**: OpenCode server starts and connects back to the control plane
6. **Ready**: Sandbox accepts prompts

### Restore (From Snapshot)

When restoring from a previous snapshot:

```
┌─────────────┐    ┌────────────┐    ┌─────────────┐    ┌───────┐
│  Restore    │───▶│ Quick Sync │───▶│ Start Script│───▶│ Ready │
│  Snapshot   │    │ (git pull) │    │ (optional)  │    │       │
└─────────────┘    └────────────┘    └─────────────┘    └───────┘
```

1. **Restore snapshot**: Modal or Vercel restores the filesystem from a saved snapshot
2. **Quick sync**: Pulls latest changes (usually just a few commits)
3. **Start script**: Runs `.openinspect/start.sh` for runtime startup (if present)
4. **Ready**: Sandbox is ready almost instantly

Snapshots include installed dependencies, built artifacts, and workspace state. This is why
follow-up prompts in an existing session are much faster than the first prompt.

### Repo Image Start

When starting from a pre-built repo image:

1. **Incremental git sync**: Fast fetch + hard reset to latest branch head
2. **Setup skipped**: `.openinspect/setup.sh` already ran when the image was built
3. **Start script runs**: `.openinspect/start.sh` executes for per-session runtime startup
4. **Ready**: Agent starts once runtime hook succeeds

If `start.sh` exists and fails, startup fails fast instead of continuing with a broken runtime.

### When Snapshots Are Taken

- **After successful prompt completion**: Preserves the workspace state
- **Before sandbox timeout**: Saves state before the sandbox shuts down due to inactivity
- **On explicit save**: Can be triggered by the control plane

### Sandbox Warming

To minimize perceived latency, sandboxes warm proactively:

- When you start typing a prompt, the control plane begins warming a sandbox
- By the time you hit enter, the sandbox may already be ready
- If restore is fast enough, you won't notice any delay

### Tunnel URLs Inside the Sandbox

When a session uses the `tunnelPorts` sandbox setting, the resolved tunnel URLs are written to
`/workspace/.tunnels.env` so processes started by `.openinspect/start.sh` (or by the agent later)
can read them locally.

```dotenv
# /workspace/.tunnels.env
TUNNEL_3000=https://abc123-3000.modal.host
TUNNEL_5173=https://abc123-5173.modal.host
```

This dotenv shape works directly with tools that accept an env-file path — `node --env-file=...`,
`bun --env-file=...`, `docker compose --env-file=...`. The format is plain `KEY=value`, so any other
dotenv consumer can read it without parsing.

**Boot ordering.** On every non-build boot, the supervisor:

1. Clears any stale file inherited from a snapshot.
2. Waits up to `TUNNEL_WAIT_TIMEOUT_SECONDS` (default `30`) for fresh URLs.
3. Runs `.openinspect/start.sh`.

If the wait times out (for example, because the backend has not resolved tunnel URLs yet),
`start.sh` proceeds without fresh local URLs and the supervisor logs `tunnel.env_file_wait_timeout`.
The control plane still receives and broadcasts the URLs to clients on a separate path. The file is
not written when `tunnelPorts` is empty or in build mode.

---

## How Prompts Flow Through the System

Here's what happens when you send a prompt:

```
┌──────┐   ┌────────┐   ┌───────────────┐   ┌─────────┐   ┌──────────┐
│ User │──▶│ Client │──▶│ Control Plane │──▶│ Sandbox │──▶│ OpenCode │
└──────┘   └────────┘   └───────────────┘   └─────────┘   └──────────┘
              │                 │                              │
              │                 │         Events stream back   │
              │◀────────────────┼◀─────────────────────────────┘
              │                 │
              ▼                 ▼
         Display to        Broadcast to
           user           all clients
```

### Step by Step

1. **You send a prompt** via web or Slack

2. **Control plane queues it**: The prompt goes to the session's Durable Object and is added to the
   message queue. If a sandbox isn't running, one is spawned or restored.

3. **Sandbox receives the prompt**: Via WebSocket, the control plane sends the prompt to the sandbox
   along with author information (for commit attribution).

4. **OpenCode processes it**: The agent reads files, makes edits, runs commands—whatever the task
   requires. Each action generates events.

5. **Events stream back**: Tool calls, token streams, and status updates flow back through the
   WebSocket to the control plane.

6. **Control plane broadcasts**: Events are stored in the session database and broadcast to all
   connected clients in real-time.

7. **Artifacts are created**: If the agent creates a PR or captures a screenshot, these are stored
   as artifacts and announced to clients.

### Prompt Queuing

If you send a prompt while the agent is still working on a previous one, it's queued:

```
Prompt 1 (processing) ──▶ Prompt 2 (queued) ──▶ Prompt 3 (queued)
```

This lets you send follow-up thoughts while the agent works. Prompts are processed in order.

You can also stop the current execution if the agent is going down the wrong path.

---

## The Agent

Open-Inspect uses [OpenCode](https://opencode.ai) as its coding agent. OpenCode is an open-source
agent designed to run as a server, making it ideal for background execution.

### What the Agent Can Do

| Capability              | Description                              |
| ----------------------- | ---------------------------------------- |
| **Read files**          | Explore the codebase, understand context |
| **Edit files**          | Make changes, refactor code              |
| **Run commands**        | Execute tests, builds, scripts           |
| **Git operations**      | Commit changes, create branches          |
| **Web browsing**        | Look up documentation, research errors   |
| **Visual verification** | Use Playwright to check UI changes       |

### How Changes Are Attributed

When the agent makes commits, they're attributed to the user who sent the prompt:

```
Author: Jane Developer <jane@example.com>
Committer: Open-Inspect <bot@open-inspect.dev>
```

This ensures your contributions are properly credited in git history.

### Creating Pull Requests

When you ask the agent to create a PR:

1. Agent pushes the branch using brokered SCM credentials from the sandbox credential helper
2. Control plane receives the branch name
3. Control plane creates the PR using _your_ GitHub OAuth token
4. PR appears as created by you, not a bot

This maintains proper code review workflows—you can't approve your own PRs.

---

## Real-time Events

Sessions stream events to all connected clients via WebSocket.

### Event Types

| Event              | Description                                   |
| ------------------ | --------------------------------------------- |
| `sandbox_spawning` | Sandbox is being created                      |
| `sandbox_ready`    | Sandbox is ready to accept prompts            |
| `sandbox_event`    | Tool call, token stream, or other agent event |
| `artifact_created` | PR created, screenshot captured               |
| `presence_update`  | User joined or left the session               |
| `session_status`   | Session state changed                         |

### Multiplayer

Multiple users can connect to the same session:

- **Presence**: See who else is watching
- **Shared stream**: Everyone sees the same events
- **Attributed prompts**: Each prompt is tagged with who sent it
- **Collaborative**: One person can start a task, another can refine it

This makes sessions useful for pair programming, live debugging, or teaching.

---

## Snapshots and Performance

Speed is critical for background agents. If sessions are slow, people won't use them.

### The Cold Start Problem

Without optimization, starting a session would require:

1. Spinning up a container (~5-10s)
2. Cloning the repository (~10-30s for large repos)
3. Installing dependencies (~30s-5min)
4. Starting the agent (~5s)

That's potentially minutes before the agent can start working.

### How Snapshots Solve This

Modal and Vercel filesystem snapshots let us capture a sandbox's state after setup:

```
First session:  Clone ─▶ Install/Build ─▶ Start Runtime ─▶ [Snapshot] ─▶ Work
                              (slow)

Later sessions: [Restore Snapshot] ─▶ Quick sync ─▶ Start Runtime ─▶ Work
                     (fast)
```

The first session for a repo pays the setup cost. Subsequent sessions restore in seconds.

For Vercel, Terraform builds a base-runtime snapshot from the local checkout and wires a
deterministic snapshot name into `VERCEL_BASE_SNAPSHOT_NAME`. Fresh Vercel sandboxes resolve that
name to the newest created snapshot instead of cloning and installing the sandbox runtime on every
session. See [Vercel Sandbox Provider](VERCEL_SANDBOX_PROVIDER.md) for the full provider flow.

### Image Prebuilding

For frequently-used repositories, images can be prebuilt on a schedule:

- Clone repo, install dependencies, run initial build
- Save as a snapshot
- Sessions start from this snapshot, only syncing recent changes

This means even "cold" sessions (no previous snapshot) start from a recent baseline.

---

## Security Model

Open-Inspect is designed for **single-tenant deployment** where all users are trusted members of the
same organization.

### Why Single-Tenant?

The system uses a shared GitHub App installation for all git operations. This means:

- Any user can access any repository the GitHub App is installed on
- There's no per-user repository access validation
- The trust boundary is your organization, not individual users

This follows
[Ramp's original design](https://builders.ramp.com/post/why-we-built-our-background-agent), which
was built for internal use where all employees have access to company repositories.

### Token Architecture

| Token              | Purpose                                    | Scope                            |
| ------------------ | ------------------------------------------ | -------------------------------- |
| GitHub App Token   | Mint brokered git credentials              | All repos where App is installed |
| User OAuth Token   | Create PRs, identify users                 | Repos the user has access to     |
| Sandbox Auth Token | Authenticate sandbox → control plane calls | Single session                   |
| WebSocket Token    | Authenticate client connections            | Single session                   |

Fresh sandboxes fetch git credentials on demand through the control plane instead of relying on a
token embedded in the environment or remote URL. Older snapshots and repo images may still receive
env-token fallbacks so they can boot through the credential-helper migration. The helper authorizes
HTTPS requests for the configured SCM host, preserving existing setup/start hooks that clone other
private repositories available to the installation. This primarily protects continuously running
sessions and Daytona persistent resumes from expired embedded credentials; Modal snapshot restores
already mint a fresh fallback token on restore.

### Secrets

You can configure environment variables (API keys, credentials) at global or per-repository scope:

- **Global secrets** apply to all repositories (e.g., `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`)
- **Repository secrets** apply to a single repo and override global secrets with the same key
- Stored encrypted (AES-256-GCM) in D1 database
- Injected into sandboxes at startup
- Never exposed to clients (only key names are visible)

> **Daytona and Vercel users**: LLM API keys (e.g., `ANTHROPIC_API_KEY` for Claude models) must be
> added as global secrets. DeepSeek models require `DEEPSEEK_API_KEY` with any sandbox provider.

See [Secrets Management](./SECRETS.md) for setup instructions.

### Deployment Recommendations

1. **Deploy behind SSO/VPN**: Control who can access the web interface
2. **Limit GitHub App scope**: Only install on repositories you want accessible
3. **Use "Select repositories"**: Don't give the App access to all org repos

---

## What's Next

- **[Getting Started](./GETTING_STARTED.md)**: Deploy your own instance
- **[Debugging Playbook](./DEBUGGING_PLAYBOOK.md)**: Troubleshoot issues with structured logs
