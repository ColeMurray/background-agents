# Using the Claude Agent Harness with a Claude Subscription

Open-Inspect can run a session on one of two agent harnesses. **OpenCode** is the built-in harness
and runs every model in the catalog. **Claude Agent** runs Anthropic models through the Claude Agent
SDK inside the sandbox, and it is the harness that can use a connected Claude subscription instead
of an API key.

This deployment uses a connected Claude account as first-party use of the deployment owner's own
subscription by the owner's own authorised users. The platform holds the credential; users never
sign in inside a sandbox.

> **Note**: Model availability under a Claude subscription is controlled by Anthropic. Confirm the
> account you connect can use the selected model before rolling it out broadly.

---

## Choosing a harness

Every session runs on exactly one harness, chosen when the session is created and fixed for its
lifetime (like the base branch). Child sessions inherit their parent's harness. Automations carry a
harness for the sessions they create. Bots and integrations create OpenCode sessions.

| Harness          | Models                | Anthropic authentication                   | Notes                                 |
| ---------------- | --------------------- | ------------------------------------------ | ------------------------------------- |
| **OpenCode**     | Every catalog model   | `ANTHROPIC_API_KEY` only                   | Built-in; the default                 |
| **Claude Agent** | Anthropic models only | `ANTHROPIC_API_KEY` or a connected account | Reads repository `CLAUDE.md` natively |

The composer shows a harness menu beside the model picker; the model list is filtered to what the
chosen harness can run. A per-message model override that the session's harness cannot run is
rejected with an error rather than silently replaced.

An **installation default** Anthropic account only takes effect on Claude Agent sessions. OpenCode,
bot and automation sessions on OpenCode keep using the API key, so setting a default never breaks
sessions that cannot use it.

---

## Setup

### Step 1: Connect a Claude account

1. Open **Settings > Provider Accounts**.
2. Choose **Add account > Claude** and name the slot.
3. Either:
   - **Authorize in the browser**: open the Anthropic consent page, grant access with the scope
     `user:inference`, copy the code Anthropic displays, and paste it back into the dialog; or
   - **Paste a setup token**: run `claude setup-token` on a workstation signed in to the
     subscription and paste the printed `sk-ant-oat…` value.

The credential is a Claude **setup token**: inference-only, valid for about a year, and static. It
does not rotate and carries no refresh token. Open-Inspect encrypts it at rest and never shows it in
the browser.

A slot connected by **browser authorization** records the Claude account that granted it (Anthropic
returns the account and organization with the token), so a second slot for the same account is
rejected as a duplicate and a reconnect from a different Claude account is refused. A slot connected
by **pasting a setup token** has no identity: Open-Inspect cannot tell two pasted tokens apart and
does not de-duplicate them. A slot's identity is fixed when it is created: reconnecting a pasted
slot in the browser keeps it identity-less. Neither kind can be verified against Anthropic on
demand. Reconnecting replaces what Open-Inspect stores for that slot; it does not revoke the
previous token at Anthropic (see the runbook below).

### Step 2: Configure defaults

Choose an Anthropic **Default account** in **Settings > Provider Accounts** if unattended Claude
Agent sessions should use the subscription. Set **Unattended mode** to **Use API key** to keep
automations on the platform key while interactive sessions pick the account.

### Step 3: Create a Claude Agent session

Pick **Claude Agent** in the composer, choose an Anthropic model, and select the connected account
in the provider controls (or leave the policy default). The session's authentication choice is fixed
at create.

---

## How the credential reaches the sandbox

1. At session create, the Anthropic selection is persisted with the session before any sandbox is
   spawned. Every later prompt runs a pre-spawn check: a disabled, archived or fenced account fails
   the prompt in the queue with reconnect guidance instead of spawning a sandbox into a denial.
2. The sandbox boots with `ANTHROPIC_OAUTH_MANAGED=1` and no Anthropic key in its user secrets.
3. On every bridge start (fresh spawn, supervised restart, snapshot restore), the Claude harness
   calls the sandbox-authenticated endpoint
   `POST /sessions/:id/provider-auth/anthropic/runtime-credential`. The control plane checks the
   binding and the account, decrypts the token, records an **issuance** (session, sandbox,
   credential version) and returns the token with `Cache-Control: no-store`.
4. The harness keeps the token in process memory and launches the `claude` binary through a
   **clean-credential wrapper**: the child sees the sandbox environment exactly as OpenCode does
   (the sandbox token, `SESSION_CONFIG`, user secrets, proxies) minus the Anthropic credentials of
   the other mode, so it holds exactly one Anthropic credential (`CLAUDE_CODE_OAUTH_TOKEN` in
   account mode, `ANTHROPIC_API_KEY` in key mode), never both. Nothing is written to disk, so
   snapshots carry no credential and a restore re-fetches.

Code the agent runs from Bash inherits the `claude` process environment, so repository code can read
the token, the same way it can read the sandbox token and user secrets under either harness. This
same-sandbox exposure is accepted; the wrapper limits accidental propagation (OpenCode, code-server,
the terminal, user shells and repository hooks never see the Claude token), not deliberate
exfiltration by code the agent chooses to run. The sandbox helpers (`oi-git-sign`,
`oi-git-credentials`, `upload-media`) need the session context, which is why it passes through.

---

## Lifecycle: disable, archive, reconnect

Disabling, archiving or reconnecting a Claude account denies future issuance immediately and
enqueues a durable cleanup task in the same database write. A coordinator (run every minute by the
scheduler) stops every sandbox that holds a live issuance at or below the revoked credential
version, using a sandbox-id-conditional stop so a session whose sandbox was respawned since is
untouched. The next prompt on an affected session fails the pre-spawn check with reconnect guidance.

The sandbox is never authoritative for account lifecycle. A runtime authentication failure fails the
prompt with reconnect guidance and emits a warning; only local expiry (the recorded expiry
approaching) fences an account to **reconnect required**. Quota and rate-limit warnings keep the
account active and appear on the session timeline.

---

## Runbook: revoking a Claude setup token

Reconnecting or disabling in Open-Inspect rotates what Open-Inspect stores and stops the sandboxes
that received the old token. It does **not** revoke the token at Anthropic. A token that has left
the deployment stays valid until Anthropic expires it. To revoke:

1. In Open-Inspect, **Disable** (or **Archive**) the account. Wait one scheduler tick (one minute)
   and confirm in the control-plane logs that `provider_credential.issuance_terminated` fired for
   every session listed under `provider_credential.issued` for that account.
2. At Anthropic, sign in to the subscription that minted the token and revoke it. A slot connected
   in the browser stores Anthropic's `token_uuid` for the credential; quote it in a support request.
   `claude auth logout` on a workstation does **not** revoke an environment-supplied token, so use
   the account's connected-applications / API session management in the Claude console, or contact
   Anthropic support if no self-service revocation is offered for setup tokens.
3. Mint a new token (browser authorization or `claude setup-token`) and **Reconnect** the slot.
4. Start a new session; sessions that were stopped resume from their snapshot on the next prompt.

---

## Deploying this feature: the migration window

Migrations `0075` (session harness) and `0076` (Anthropic provider accounts) are applied by
`terraform apply` before the worker is deployed. Once `0076` is applied, the previous worker rejects
session create/resume and the Provider Accounts settings page until the new worker is live, because
it requires exactly two provider rows per session and rejects a third provider in payloads. On
Cloudflare this is one window of a few minutes; on Vercel there is a second window until the web
deploy lands. Announce it and prefer a low-traffic slot.

**Rollback is fix-forward.** There is no reverse script: one that deleted Anthropic rows would
delete provider accounts and strand every Claude Agent session created after the migration. Deploy a
fix instead.

---

## Operational notes

- **Cost.** The Claude harness reports the SDK's client-side cost estimate per turn (running total
  at turn end minus the total at turn start, reset when the agent process restarts). Under a
  subscription it is informational, but the session spend limit still applies to it as configured; a
  limit of `0` remains unlimited.
- **Skills.** Managed skills and the bundled skills are staged under the per-sandbox
  `CLAUDE_CONFIG_DIR` (`~/.openinspect/claude/skills`); repository `.claude/` settings, hooks and
  agents load through `setting_sources=["user","project"]`, the same trust boundary as the
  repository's `.openinspect/setup.sh` and `.opencode/` directory under OpenCode.
- **Tools.** Open-Inspect's own tools (`create-pull-request`, child sessions, `slack-notify`,
  `upload-media`) are served to the Claude harness in-process as the `oi` MCP server; session MCP
  servers are passed through unchanged.
- **Sub-agents.** The child runs with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, so an `Agent` tool
  call returns only when its sub-agent has finished, and several sub-agents launched in one message
  still run concurrently. This is the same contract as OpenCode's `task` tool, and the timeline
  groups the sub-agent's activity under it the same way. Background sub-agents would let the turn
  end before their work is done and deliver their findings on a later turn nobody reads; as a second
  guard, the harness ignores the result of any turn it did not submit.
- **Follow-ups queue.** Both harnesses hold follow-up prompts until the running turn completes.
- **Image.** The sandbox image pins `claude-agent-sdk`, whose wheel bundles the `claude` binary. The
  runtime manifest names the first generation that carries it under `harnessMinimumGeneration`, so a
  Claude session never boots a prebuilt image from before that generation; OpenCode sessions keep
  their images and snapshots, since the global compatibility floor did not move.
