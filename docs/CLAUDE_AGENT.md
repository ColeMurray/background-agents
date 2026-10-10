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
harness for the sessions they create. The Linear and GitHub integrations have a harness setting
(global and per repository, OpenCode by default); see [Linear sessions](#linear-sessions). In those
two, a harness/model pair the harness cannot run falls back to OpenCode; the GitHub bot also logs a
warning. The Slack integration has a workspace setting (global only, OpenCode by default) and a
per-user choice in App Home, and refuses a request whose model the harness cannot run instead of
falling back; see [Slack sessions](#slack-sessions).

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

### Linear sessions

**Settings > Integrations > Linear** has an **Agent harness** setting, globally and per repository
override; a repository override wins, and unset means OpenCode. The setting is a preference that
follows the model: Linear resolves the model first (`model:*` label, user preference, repository or
global default, deployment `DEFAULT_MODEL`), then runs the session on the configured harness when it
can run that model and on OpenCode otherwise. So with Claude Agent selected, an Anthropic model runs
on Claude Agent and a `model:gpt-*` label (or a non-Anthropic default) runs on OpenCode instead of
failing. The Linear activity names the harness:
`Creating coding session on <target> (agent: Claude Agent, model: …)`. To keep every Linear session
on Claude Agent, choose an Anthropic default model, keep any repository override's model Anthropic,
and turn off **Allow user model preferences** and **Allow model labels**.

Saving a harness and an incompatible model at the same level (for example Claude Agent with an
OpenAI model) is rejected, and the settings form only lists models the harness can run. A repository
override that sets only one of the two can still combine with the other level's value; the fallback
above covers it.

Linear sessions are unattended, so on Claude Agent they follow the **Automated authentication**
policy: with a default Claude account and that policy on **Use default**, Linear usage draws on the
connected subscription; otherwise it uses `ANTHROPIC_API_KEY`. Switching the setting affects only
new sessions; follow-ups on an existing issue session keep the harness it was created with.

### Slack sessions

A Slack session runs on the user's **Agent harness** choice in the Slack app's **Home** tab
(**Workspace default**, **OpenCode**, or **Claude Agent**), else on the **Agent harness** setting
under **Settings > Integrations > Slack**. That setting is global only, and unset means OpenCode.
The bot resolves the model as before: `!model` and `!reasoning` flags on the request that starts the
session, the user's App Home model and reasoning effort, the Slack **Default model**, deployment
`DEFAULT_MODEL`.

Slack does not fall back to OpenCode. If the session's harness cannot run the resolved model, the
bot creates no session and, after its "Starting work..." message, replies in the thread:

> Model "openai/gpt-5.4" cannot run on the Claude Agent harness. Start your request with `!model`
> and a model Claude Agent can run, or change your model or agent harness in the Slack app's Home
> tab.

App Home lists only models the user's harness can run. If the user's current model cannot run on it,
the model picker shows "Choose a model" with no selection and says new requests are refused until a
model is chosen. The App Home "Currently using" summary names the harness. The "Starting work..."
acknowledgement never names the harness; it names the model and reasoning effort only when they
differ from the user's App Home defaults.

When the workspace **Agent harness** is Claude Agent, a Slack **Default model** is required. The
settings form disables **Save** until one is chosen, and the control plane rejects saving Claude
Agent without one. "Use system default" is not offered for Claude Agent, because the settings page
cannot see the deployment default model, which may be one Claude Agent cannot run. As for Linear,
saving a harness with a model it cannot run is rejected, and the form only lists models the harness
can run.

A thread keeps the harness its session was created with, so switching the setting affects only new
sessions. The control plane rejects a follow-up `!model` that the thread's harness cannot run, and
the bot posts that explanation in the thread with advice:

> Model "openai/gpt-5.4" cannot run on the Claude Agent harness. A thread keeps the harness its
> session started on. Reply without `!model`, or start a new thread to use that model.

A `!reasoning`-only follow-up keeps the thread's session model, as a follow-up without flags does,
even if an administrator has since disabled that model. The thread's harness was chosen to run that
model, so the follow-up always runs.

Slack sessions are unattended, so on Claude Agent they follow the **Automated authentication**
policy. With a default Claude account and that policy on **Use default**, Slack usage draws on the
connected subscription. With **No account (API key)**, it uses `ANTHROPIC_API_KEY`. This also
applies when a user picks Claude Agent in App Home while the workspace harness is OpenCode, so set
**No account (API key)** to keep all Slack sessions on the key.

If the bot cannot read the Slack settings, it treats the workspace harness as OpenCode; a user's App
Home harness choice still applies. An Anthropic model on OpenCode needs `ANTHROPIC_API_KEY`, so a
deployment that relies only on a connected Claude account sees those sessions fail.

On Claude Agent, a Slack session loads the target repository's `CLAUDE.md` and `.claude/` settings
and hooks, and code the agent runs inherits the Anthropic credential (see
[How the credential reaches the sandbox](#how-the-credential-reaches-the-sandbox)). Slack users
choose the branch through App Home, so let Slack channels reach only repositories whose `.claude/`
configuration you trust on every branch.

A Claude Agent session skips prebuilt images older than the Claude image floor
(`harnessMinimumGeneration` in the runtime manifest). After switching, a repository whose image
predates that floor starts its first Claude Agent sessions without it, so they are slower until the
image is rebuilt.

---

## Setup

### Step 1: Connect a Claude account

1. Open **Settings > Provider Accounts**.
2. Choose **Add account > Claude**.
3. Either:
   - **Authorize in the browser** (the default): open the Anthropic consent page, grant access with
     the scope `user:inference`, copy the code Anthropic displays, and paste it back into the
     dialog. The slot is created as **Claude account**; use **Rename** on it afterwards.
   - **Paste a setup token instead**: run `claude setup-token` on a workstation signed in to the
     subscription, name the slot, and paste the printed `sk-ant-oat…` value.

The credential is a Claude **setup token**: inference-only, valid for about a year, and static. It
does not rotate and carries no refresh token. Open-Inspect encrypts it at rest and never shows it in
the browser.

A slot connected by **browser authorization** records the Claude account that granted it, when
Anthropic returns an account id with the token. One Claude account has at most one slot: authorizing
the same account again from **Add account** does not create a duplicate, it reconnects the existing
slot and replaces its stored credential (a disabled slot is refused instead; enable or reconnect it
explicitly), and a reconnect from a different Claude account is refused. A slot connected by
**pasting a setup token** has no identity: Open-Inspect cannot tell two pasted tokens apart and does
not de-duplicate them. A pasted slot adopts an identity the first time it is reconnected in the
browser, unless that Claude account already has a slot. Once a slot has an identity it is
reconnected in the browser only; the setup-token option is not offered for it, so the granting
account is always verified. Neither kind can be verified against Anthropic on demand. Reconnecting
replaces what Open-Inspect stores for that slot; it does not revoke the previous token at Anthropic
(see the runbook below).

### Step 2: Configure defaults

Choose **Make default** on the Anthropic account in **Settings > Provider Accounts** if unattended
Claude Agent sessions should use the subscription. Under **Automated sessions**, set **Automated
authentication** to **No account (API key)** to keep automations on the platform key while
interactive sessions pick the account.

### Step 3: Create a Claude Agent session

Pick **Claude Agent** in the composer, choose an Anthropic model, and select the connected account
in the provider controls (or leave the policy default). The session's authentication choice is fixed
at create.

---

## How the credential reaches the sandbox

1. At session create, the Anthropic selection is persisted with the session before any sandbox is
   spawned. Every later prompt runs a pre-spawn check: a disabled or fenced account fails the prompt
   in the queue with reconnect guidance, and an archived account fails it with "start a new
   session", instead of spawning a sandbox into a denial.
2. The sandbox boots with `ANTHROPIC_OAUTH_MANAGED=1` and no Anthropic key in its user secrets.
3. On every bridge start (fresh spawn, supervised restart, snapshot restore), the Claude harness
   calls the sandbox-authenticated endpoint
   `POST /sessions/:id/provider-auth/anthropic/runtime-credential`. The control plane checks the
   binding and the account, decrypts the token and returns it with `Cache-Control: no-store`.
4. The harness keeps the token in process memory and launches the `claude` binary through a
   **clean-credential wrapper**: the child sees the sandbox environment exactly as OpenCode does
   (the sandbox token, `SESSION_CONFIG`, user secrets, proxies) minus the Anthropic credentials of
   the other mode, so it holds exactly one Anthropic credential (`CLAUDE_CODE_OAUTH_TOKEN` in
   account mode, `ANTHROPIC_API_KEY` in key mode), never both. Open-Inspect writes the token nowhere
   on disk, so a snapshot carries no credential of its own and a restore re-fetches.

Code the agent runs from Bash, and any hooks the repository's `.claude/` settings register, run as
children of the `claude` process and inherit its environment, so repository code can read the token,
the same way it can read the sandbox token and user secrets under either harness. This same-sandbox
exposure is accepted; the wrapper limits accidental propagation (OpenCode, code-server, the terminal
and user shells never see the Claude token), not deliberate exfiltration by code the agent chooses
to run or a hook the repository configures, and what such code persists to disk is that same
accepted exposure. The sandbox helpers (`oi-git-sign`, `oi-git-credentials`, `upload-media`) need
the session context, which is why it passes through.

---

## Lifecycle: disable, archive, reconnect

Disabling or archiving a Claude account stops new hand-outs immediately: the next bridge start on
any session bound to the account is refused, and the next prompt on such a session fails the
pre-spawn check (reconnect guidance for a disabled or fenced account; "start a new session with
another account or an API key" for an archived one, since an archived slot cannot be reconnected).
Reconnecting is different: the slot stays active with the new credential, so sessions bound to it
carry on and their next bridge start fetches the new token. In every case a sandbox that already
holds a token keeps it in memory until it exits (inactivity timeout, hard timeout, or a stop), so a
turn already running finishes on the old token. Open-Inspect does not chase running sandboxes: the
token stays valid at Anthropic whatever Open-Inspect does, so stopping its own sandboxes would only
shorten a window it cannot close. Revocation happens at Anthropic (runbook below).

The sandbox is never authoritative for account lifecycle. A runtime authentication failure fails the
prompt with reconnect guidance and emits an error event; only local expiry (the recorded expiry
approaching) fences an account to **reconnect required**. Quota and rate-limit warnings keep the
account active and appear on the session timeline.

---

## Runbook: revoking a Claude setup token

Reconnecting or disabling in Open-Inspect rotates or fences what Open-Inspect stores. It does
**not** revoke the token at Anthropic, and it does not stop sandboxes that already hold the token;
they keep it until they exit. A token that has left the deployment stays valid until Anthropic
expires it or you revoke it. To revoke:

1. In Open-Inspect, stop new hand-outs of the old token. If the slot stays in service, mint a new
   token (browser authorization or `claude setup-token`) and **Reconnect** the slot: from then on
   only the new token is handed out, and bound sessions carry on. If the slot is being retired,
   **Disable** it (or **Archive** it and create a new slot later; an archived slot cannot be
   reconnected). The provider's default account, which is what a single connected account becomes,
   cannot be disabled or archived: reconnect it in place, or choose **Make default** on another
   account first. Either way, sessions with a running sandbox keep the old token until that sandbox
   exits; stop those sessions from the session page if you want that sooner. The control-plane log
   lists every hand-out under `provider_credential.issued`.
2. At Anthropic, sign in to the subscription that minted the token and revoke it.
   `claude auth logout` on a workstation does **not** revoke an environment-supplied token, so use
   the account's connected-applications / API session management in the Claude console, or contact
   Anthropic support if no self-service revocation is offered for setup tokens.
3. If you disabled the slot, mint a new token and **Reconnect** it; reconnecting reactivates it.
4. Start a new session, or prompt an existing one; the next bridge start fetches the new token.

---

## Deploying this feature: the migration window

Migrations `0075` (session harness) and `0076` (Anthropic provider accounts) are applied by
`terraform apply` before the worker is deployed. Once `0076` is applied, the previous worker rejects
session create/resume until the new worker is live: it requires exactly one provider row per
provider it knows (two), and the migration backfills an Anthropic row onto every session. The
Provider Accounts page keeps working through the window; its Anthropic controls appear once the new
worker and web build are deployed. On Cloudflare this is one window of a few minutes; on Vercel
there is a second window until the web deploy lands. Announce it and prefer a low-traffic slot.

**Rollback is fix-forward.** There is no reverse script: one that deleted Anthropic rows would
delete provider accounts and strand every Claude Agent session created after the migration. Deploy a
fix instead.

---

## Operational notes

- **Cost.** The Claude harness reports the SDK's client-side cost estimate per turn (running total
  at turn end minus the total at turn start, reset when the agent process restarts). Under a
  subscription it is informational, but the session spend limit still applies to it as configured.
  Unlimited is a blank limit in Settings (`null` in the API); `0` is rejected as a value.
- **Skills.** Managed skills and the bundled skills are staged under the per-sandbox
  `CLAUDE_CONFIG_DIR` (`~/.openinspect/claude/skills`); repository `.claude/` settings, hooks and
  agents load through `setting_sources=["user","project"]`, the same trust boundary as the
  repository's `.openinspect/setup.sh` and `.opencode/` directory under OpenCode.
- **Privacy.** The harness disables Claude Code's commit, pull request, and session-link
  attribution. It also disables nonessential Anthropic traffic, error reporting, feedback and
  surveys, and both Anthropic and OpenTelemetry usage telemetry. Model requests and Open-Inspect's
  own per-turn cost accounting are unaffected.
- **Tools.** Open-Inspect's own tools are served to the Claude harness in-process as the `oi` MCP
  server: child sessions and `upload-media` always, `create-pull-request` when the session has a
  repository, and `slack-notify` when agent notifications are enabled for the repository. Session
  MCP servers are passed through, with a server's tool allowlist applied: only its selected tools
  are allowed (`mcp__<server>__<tool>`). The control plane leaves out a server with an empty
  allowlist.
- **Sub-agents.** The child runs with `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, so an `Agent` tool
  call returns only when its sub-agent has finished, and several sub-agents launched in one message
  still run concurrently. This is the same contract as OpenCode's `task` tool, and the timeline
  groups the sub-agent's activity under it the same way. Background sub-agents would let the turn
  end before their work is done and deliver their findings on a later turn nobody reads; as a second
  guard, the harness ignores the result of any turn it did not submit.
- **Memory.** The child runs with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, so Claude Code's file-based
  auto memory (the `memory/` directory under `CLAUDE_CONFIG_DIR` and its system-prompt section) is
  off. Open-Inspect's memory tools are the agent's only memory system.
- **Follow-ups queue.** Both harnesses hold follow-up prompts until the running turn completes.
- **Image.** The sandbox image pins `claude-agent-sdk`, whose wheel bundles the `claude` binary. The
  runtime manifest's `harnessMinimumGeneration` controls which prepared images new Claude sessions
  can use. Older images and resumed snapshots may lack newer models until rebuilt; a model request
  can fail on a sandbox whose bundled CLI does not support it.
