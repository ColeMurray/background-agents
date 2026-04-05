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

Open-Inspect runs entirely on Cloudflare, with both the control plane and sandboxes on the same
platform:

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
│               Data Plane (Cloudflare Containers)                                 │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                 Sandbox (Durable Object + Container)                              │ │
│  │  ┌────────────┐    ┌────────────┐    ┌────────────┐               │ │
│  │  │ Supervisor │───▶│  OpenCode  │───▶│   Bridge   │───────────────┼─┼──▶ Control Plane
│  │  └────────────┘    └────────────┘    └────────────┘               │ │
│  │                           │                                        │ │
│  │                    Full Dev Environment                            │ │
│  │        (Node.js 22, Python 3.10, git, code-server, Chromium)      │ │
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
incurring compute costs. Cloudflare Containers run sandboxes on the same platform, eliminating
cross-provider networking complexity.

### Data Plane (Cloudflare Containers)

The data plane is where code actually runs. Each session gets an isolated sandbox backed by a
Cloudflare Container (Durable Object + Docker container).

**What's in a sandbox:**

- Base image: `cloudflare/sandbox:0.7.18` (Debian with Python 3.10, Node.js 20)
- Node.js 22 LTS, pnpm, yarn, Bun
- Python 3.10 with uv, httpx, websockets, pydantic
- OpenCode (`opencode-ai@latest`) — the coding agent, running in serve mode
- code-server (browser-based VS Code)
- agent-browser + headless Chromium
- GitHub CLI

**Why Cloudflare Containers?** Running sandboxes on the same platform as the control plane
eliminates cross-provider networking. The `@cloudflare/sandbox` SDK manages container lifecycle
(start, sleep, destroy) automatically. Containers sleep after inactivity and wake on the next
operation, keeping costs low.

**How sandboxes connect to OpenCode:**

The sandbox uses a three-process architecture managed by a Python supervisor (`entrypoint.py`):

1. **OpenCode** runs in `serve` mode on port 4096, exposing an HTTP/SSE API
2. **Bridge** connects to the control plane via WebSocket, forwards prompts to OpenCode, and streams
   events back
3. **code-server** (optional) provides browser-based editing on port 5656

### LLM Provider Configuration

OpenCode inside the sandbox is configured via `.opencode/opencode.json`, written at startup by the
supervisor. This supports custom LLM providers through npm packages.

**Fuelix proxy example** (used when `ANTHROPIC_BASE_URL` is set):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "fuelix": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "FuelIX",
      "options": {
        "baseURL": "https://api.fuelix.ai",
        "apiKey": "<key>"
      },
      "models": {
        "claude-sonnet-4-6": { "name": "Claude Sonnet 4.6" },
        "claude-sonnet-4-5": { "name": "Claude Sonnet 4.5" }
      }
    }
  },
  "model": "fuelix/claude-sonnet-4-6"
}
```

When no proxy is configured, OpenCode uses its built-in Anthropic provider with `ANTHROPIC_API_KEY`.

**Why a custom provider instead of the built-in Anthropic provider?** OpenCode's built-in Anthropic
provider hardcodes the `x-api-key` header, but proxies like Fuelix require `Authorization: Bearer`.
The `@ai-sdk/openai-compatible` provider handles Bearer auth natively.

### Clients

Clients are how users interact with sessions. The architecture is client-agnostic—any client that
can make HTTP requests and maintain WebSocket connections can participate.

**Current clients:**

- **Web**: Next.js app with real-time streaming, session management, and settings
- **Slack**: Bot that responds to @mentions and direct messages, classifies repos, and posts results

All clients see the same session state. Send a prompt from Slack, watch the results on web. This
works because state lives in the control plane, not the client.

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

1. **Sandbox created**: Cloudflare starts a container from the sandbox image
2. **Git sync**: Clones your repository using GitHub App credentials
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

1. **Restore snapshot**: Container restores from a saved image
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

1. Agent pushes the branch using GitHub App credentials
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

### How Cloudflare Containers Help

Cloudflare Containers sleep after inactivity and wake automatically on the next SDK call. The
`gitCheckout()` call triggers container start, and `setEnvVars()` configures the environment before
the entrypoint runs. This means:

- **No cold start penalty for subsequent prompts**: The container stays warm between messages
- **Automatic cleanup**: Containers sleep after 1 hour of inactivity
- **Same-platform networking**: No cross-provider latency between control plane and sandbox

The first prompt for a session pays the container start + git clone cost (~5-10s). Follow-up prompts
in the same session are near-instant since the container is already running.

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

| Token              | Purpose                              | Scope                            |
| ------------------ | ------------------------------------ | -------------------------------- |
| GitHub App Token   | Clone repos, push commits            | All repos where App is installed |
| User OAuth Token   | Create PRs, identify users           | Repos the user has access to     |
| Sandbox Auth Token | Authenticate sandbox → control plane | Single session                   |
| WebSocket Token    | Authenticate client connections      | Single session                   |

### Repo-Scoped Secrets

You can configure environment variables (API keys, credentials) per repository:

- Stored encrypted (AES-256-GCM) in D1 database
- Injected into sandboxes at startup
- Never exposed to clients (only key names are visible)

### Deployment Recommendations

1. **Deploy behind SSO/VPN**: Control who can access the web interface
2. **Limit GitHub App scope**: Only install on repositories you want accessible
3. **Use "Select repositories"**: Don't give the App access to all org repos

---

## What's Next

- **[Getting Started](./GETTING_STARTED.md)**: Deploy your own instance
- **[Debugging Playbook](./DEBUGGING_PLAYBOOK.md)**: Troubleshoot issues with structured logs
