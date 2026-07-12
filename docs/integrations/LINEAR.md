# Linear Integration

Open-Inspect's Linear integration starts coding sessions from Linear issues. Mention or assign the
Linear Agent to start work, then use Linear for progress, results, and follow-ups.

This guide is for people using the Linear integration day to day. If you are installing the Linear
OAuth app or deploying the worker, start with the
[Linear Bot setup guide](../../packages/linear-bot/README.md#setup).

---

## Quick Start

1. Open the Linear issue you want Open-Inspect to work on.
2. Mention the agent in a comment:
   ```text
   @OpenInspect please implement this issue and open a pull request
   ```
3. Or assign the issue to the Linear Agent when the issue already explains the work.
4. Include `owner/repo` if the issue could match more than one repository.
5. Use **View Session** to watch the full session.
6. Send follow-ups through the same active Linear Agent session.

---

## What Linear Can Do

| Workflow                    | How it works                                                             |
| --------------------------- | ------------------------------------------------------------------------ |
| Start from an issue mention | Mention the Linear Agent on an issue                                     |
| Start from assignment       | Assign the issue to the Linear Agent                                     |
| Continue active work        | Send a follow-up through the same active Linear Agent session            |
| Stop or cancel work         | Stop or cancel the Linear Agent session to stop the Open-Inspect session |
| Resolve the repository      | Let Open-Inspect infer the repo, or include `owner/repo` when asked      |
| Follow progress             | Watch Linear activities or open the full session with **View Session**   |

Start work by mentioning or assigning the Linear Agent. Regular issue comments only continue work
when they are part of an active Linear Agent session.

---

## Start, Continue, or Stop Work

### From an `@mention`

Mention the Linear Agent on an issue when you want Open-Inspect to start work from that issue:

```text
@OpenInspect can you fix the failing invite flow described above?
```

Open-Inspect uses the issue and recent comments as context. The triggering comment becomes the agent
instruction, so include the concrete work you want done.

### From Assignment

Assign the issue to the Linear Agent when the title and description already describe the work.

Assignment works best when the issue includes:

- A clear title and description
- Acceptance criteria or expected result
- The target repository, if it is ambiguous
- Whether the agent should open a pull request

### Follow-Up Messages

Follow-up prompts on an issue with an active Open-Inspect session go to that session. When
available, Open-Inspect adds recent agent output as context.

Issue-to-session mappings are kept for several days. If the mapping has expired, or if the previous
session was stopped or cancelled, a new Linear Agent request may start a new Open-Inspect session.

### Stop or Cancel

Stopping or cancelling the Linear Agent session stops the associated Open-Inspect sandbox session
and clears the issue's session mapping.

---

## Repository Selection

Before starting work, Open-Inspect chooses a repo from the Linear project, team, labels, issue text,
comments, and repo metadata.

If the issue could match more than one repository, include the intended repository name in the issue
or trigger comment:

```text
Please handle this in acme/billing-api.
```

If Open-Inspect asks for clarification, reply with `owner/repo`. That answer is used on the next
resolution attempt.

Admins can map Linear projects or teams to repositories. See
[Configure Repo Mapping](../../packages/linear-bot/README.md#4-configure-repo-mapping-optional) for
details.

If the resolved repo is outside the selected Linear scope, Linear shows an error and no session
starts.

---

## What Linear Shows

| Activity            | What it means                                              |
| ------------------- | ---------------------------------------------------------- |
| Thinking            | Open-Inspect is analyzing the issue or choosing a repo     |
| Working             | A session has started                                      |
| Tool progress       | Optional updates for file reads, edits, and commands       |
| Clarification       | Open-Inspect needs more information, usually the repo name |
| Completion or error | The session finished, failed, or could not continue        |

When a session starts, Linear receives a **View Session** link. If the agent opens a pull request,
Linear receives a **Pull Request** link when the session finishes.

Open the web session for live output, logs, artifacts, and file changes. Linear does not currently
update issue status, labels, assignee, priority, or project.

---

## Settings

Open the web app and go to **Settings > Integrations > Linear** to configure the Linear Agent.

| Setting                        | What it controls                                                  |
| ------------------------------ | ----------------------------------------------------------------- |
| Default model and effort       | Model and reasoning depth for Linear-started sessions             |
| Repository Scope               | Whether Linear can run in all accessible repos or selected repos  |
| Issue Session Instructions     | Extra guidance appended to Linear issue prompts                   |
| Allow user model preferences   | Whether admin-managed user preferences can override the model     |
| Allow model labels (`model:*`) | Whether Linear issue labels can choose the model                  |
| Tool progress activities       | Whether Linear shows intermediate file and command activity       |
| Repository Overrides           | Per-repository defaults for model, reasoning, and Linear behavior |

If no Linear settings are configured, all accessible repositories are in scope, user preferences and
model labels are allowed, and tool progress is enabled.

Model selection uses this priority, highest to lowest:

1. `model:*` issue label, when allowed.
2. Linear user preference, when allowed.
3. Repository override or global Linear default.
4. Deployment default model.

Linear user preferences are currently admin/API-managed, not set from a self-service Linear screen.

---

## Admin and Safety Notes

- Linear webhooks are verified before Open-Inspect acts on them.
- Linear client credentials, runtime access tokens, webhook secrets, and callback secrets stay
  server-side. Runtime access tokens are cached and replaced automatically; refresh tokens are not
  used for runtime API access.
- Runtime tokens are cached under `oauth:client-credentials:{organizationId}` with their verified
  workspace/app identity and expire with the provider lease. Do not edit cached token values
  manually.
- Linear does not provide Git credentials. Repository access still comes from the deployment's
  configured source-control integration, such as the GitHub App installation.
- Repository scope in Linear settings controls which resolved repositories can receive
  Linear-started sessions.
- Linear issue titles, descriptions, comments, and agent prompts may be sent to the coding agent. Do
  not include secrets.

---

## Troubleshooting

### The agent does not appear in Linear

Confirm the Linear OAuth app is installed in the workspace and that the app was installed with the
agent scopes required for mentions and assignment. Setup details live in the
[Linear Bot setup guide](../../packages/linear-bot/README.md#setup).

### A request does not start

Make sure the request mentions or assigns the Linear Agent on an issue. Also check that the issue
belongs to a repo Open-Inspect can resolve and access.

If the Worker logs a client-credentials failure, confirm **Client credentials tokens** is enabled
for the application in **Linear Settings → API → Applications**. Existing eligible installations do
not need to be uninstalled and reinstalled. A client-credentials viewer-organization mismatch means
the application credentials resolve to a different workspace than the incoming webhook and must be
corrected before the deployment is eligible.

### Open-Inspect asks which repository to use

Reply with `owner/repo`. To avoid future prompts, add the repo to the issue or ask an admin to map
the Linear project or team.

### I see progress in Linear but need full logs

Open **View Session**. Linear shows status and completion activity, while detailed logs,
transcripts, artifacts, and file changes live in the Open-Inspect web session.

### Linear stays Working after the web session completes

Linear leaves Working only after the bot delivers a terminal `response` or `error` activity. If the
web session has completed but Linear has not:

1. Find the Open-Inspect session ID from **View Session**.
2. Confirm the Linear bot logged `agent_session.followup` for the follow-up webhook.
3. In control-plane logs, find `prompt.enqueue` for the follow-up message. A healthy Linear prompt
   has `has_callback_context:true`; `false` means completion had no Linear callback destination.
4. Confirm control-plane `prompt.complete`, followed by linear-bot `callback.complete`. If the first
   exists without the second, inspect callback routing and context. If both exist, inspect
   `linear.emit_activity_failed`, credential identity failures, and GraphQL errors.

A completion that was skipped cannot repair itself later. After deploying a callback-context fix,
send another follow-up through the same Linear Agent session to produce a new terminal activity, or
start a new Agent session if the issue mapping has expired.

### Linear client secret was rotated

Deploy the replacement `LINEAR_CLIENT_SECRET` promptly. Linear invalidates tokens minted with the
old secret; the Worker replaces the cached token after a cache miss, expiry, or HTTP 401 and retries
the rejected API request once. A reinstall is not normally required.

### The wrong model was used

Check **Settings > Integrations > Linear**. Repository overrides, user preferences, and `model:*`
labels can affect model selection. Changes apply to new Linear-started sessions.

### The wrong repository was used

Check project and team repo mappings, issue labels, repository metadata, and the selected repository
scope. If an issue is ambiguous, include the intended `owner/repo` in the issue or trigger comment.

### The agent is active in too many repositories

Limit the source-control installation to intended repositories, or set **Repository Scope** to
**Selected repositories** in the Linear integration settings.
