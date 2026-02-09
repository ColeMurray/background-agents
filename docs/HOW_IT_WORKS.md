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
| Sandbox state | Reference to the current sandbox and its status   |

Each session gets its own Rivet Actor, ensuring isolation and high performance even with hundreds of
concurrent sessions. Actor state is automatically persisted by the Rivet Engine.

---

## Architecture

Open-Inspect uses a two-tier architecture running entirely on Kubernetes:

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
│               Control Plane (Hono + Rivet Actors on K8s)                 │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                  Rivet Session Actors (per session)                 │ │
│  │  ┌──────────┐  ┌───────────┐  ┌────────────┐  ┌────────────────┐  │ │
│  │  │  Actor   │  │ WebSocket │  │   Event    │  │    Sandbox     │  │ │
│  │  │   State  │  │    Hub    │  │   Stream   │  │   Lifecycle    │  │ │
│  │  └──────────┘  └───────────┘  └────────────┘  └────────────────┘  │ │
│  └────────────────────────────────────────────────────────────────────┘ │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                   PostgreSQL (shared state)                         │ │
│  │           Sessions index, repo metadata, encrypted secrets          │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────┬─────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    Data Plane (Kubernetes Pods)                           │
│  ┌────────────────────────────────────────────────────────────────────┐ │
│  │                        Session Sandbox Pod                          │ │
│  │  ┌────────────┐    ┌────────────┐    ┌────────────┐               │ │
│  │  │ Supervisor │───▶│  OpenCode  │───▶│   Bridge   │───────────────┼─┼──▶ Control Plane
│  │  └────────────┘    └────────────┘    └────────────┘               │ │
│  │                           │                                        │ │
│  │                    Full Dev Environment                            │ │
│  │              (Node.js, Python, git, Playwright)                    │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

### Control Plane (Rivet Actors on Kubernetes)

The control plane is the coordinator. It doesn't execute code—it manages state and routes messages.

**Responsibilities:**

- Session state management (Rivet Actor state, auto-persisted)
- WebSocket connections for real-time streaming
- Sandbox lifecycle orchestration (spawn K8s Jobs, monitor health)
- GitHub integration (repo listing, PR creation)
- Authentication and access control

**Why Rivet Actors?** Each session gets its own isolated actor with in-memory state that's
automatically persisted. Actors hibernate when idle and wake instantly on new requests. This provides
the same per-session isolation as Durable Objects but runs on your own Kubernetes cluster.

The Rivet Engine (Rust) handles actor scheduling, state persistence to PostgreSQL, health checking,
and failover. NATS provides the inter-service message bus.

### Data Plane (Kubernetes Pods)

The data plane is where code actually runs. Each session gets an isolated sandbox as a K8s Job/Pod
with a full development environment.

**What's in a sandbox:**

- Debian Linux with common dev tools
- Node.js 22, Python 3.12, git, curl
- Package managers: npm, pnpm, pip, uv
- Playwright + headless Chrome (for visual verification)
- OpenCode (the coding agent)

**Why Kubernetes?** K8s provides robust container orchestration, resource limits, RBAC, and
integrates with existing infrastructure. Sandbox pods are created as Jobs, which K8s schedules
and monitors. No vendor lock-in—runs on any K8s cluster.

### Clients

Clients are how users interact with sessions. The architecture is client-agnostic—any client that
can make HTTP requests and maintain WebSocket connections can participate.

**Current clients:**

- **Web**: Next.js app with real-time streaming, session management, and settings
- **Slack**: Bot that responds to @mentions, classifies repos, and posts results

All clients see the same session state. Send a prompt from Slack, watch the results on web. This
works because state lives in the control plane, not the client.

---

## The Sandbox Lifecycle

Understanding the sandbox lifecycle explains how Open-Inspect manages code execution.

### Fresh Start

When you create a session:

```
┌─────────┐    ┌──────────┐    ┌─────────────┐    ┌─────────────┐    ┌───────┐
│ K8s Job │───▶│ Git Sync │───▶│ Setup Script│───▶│ Agent Start │───▶│ Ready │
│ Created │    │ (clone)  │    │ (optional)  │    │ (OpenCode)  │    │       │
└─────────┘    └──────────┘    └─────────────┘    └─────────────┘    └───────┘
                                     │
                                     ▼
                            .openinspect/setup.sh
                            (if present in repo)
```

1. **K8s Job created**: Control plane creates a Job with the sandbox Docker image
2. **Git sync**: Clones your repository using GitHub App credentials
3. **Setup script**: Runs `.openinspect/setup.sh` if present (for `npm install`, etc.)
4. **Agent start**: OpenCode server starts and connects back to the control plane
5. **Ready**: Sandbox accepts prompts

### Sandbox Warming

To minimize perceived latency, sandboxes warm proactively:

- When you start typing a prompt, the control plane begins creating a sandbox
- By the time you hit enter, the sandbox may already be ready
- Pre-built Docker images include all common dependencies

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

2. **Control plane queues it**: The prompt goes to the session's Rivet Actor and is added to the
   message queue. If a sandbox isn't running, one is spawned via K8s Job.

3. **Sandbox receives the prompt**: Via WebSocket, the control plane sends the prompt to the sandbox
   along with author information (for commit attribution).

4. **OpenCode processes it**: The agent reads files, makes edits, runs commands—whatever the task
   requires. Each action generates events.

5. **Events stream back**: Tool calls, token streams, and status updates flow back through the
   WebSocket to the control plane.

6. **Control plane broadcasts**: Events are stored in the session actor's state and broadcast to all
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

- Stored encrypted (AES-256-GCM) in PostgreSQL
- Injected into sandbox pods at startup
- Never exposed to clients (only key names are visible)

### Deployment Recommendations

1. **Deploy behind SSO/VPN**: Control who can access the web interface
2. **Limit GitHub App scope**: Only install on repositories you want accessible
3. **Use "Select repositories"**: Don't give the App access to all org repos

---

## What's Next

- **[Getting Started](./GETTING_STARTED.md)**: Deploy your own instance
- **[Debugging Playbook](./DEBUGGING_PLAYBOOK.md)**: Troubleshoot issues with structured logs
