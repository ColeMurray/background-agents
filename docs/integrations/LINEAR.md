# Linear Integration

Open-Inspect's Linear integration lets your team start coding sessions from Linear issues. The
Linear Agent can be mentioned or assigned on an issue, posts progress and results back to Linear,
and can continue active issue work with follow-up prompts.

This guide is for people using the Linear integration day to day. If you are installing the Linear
OAuth app or deploying the worker, start with the
[Linear Bot setup guide](../../packages/linear-bot/README.md#setup).

---

## Quick Start

1. Make sure the Linear Agent is installed in your workspace.
2. Open the Linear issue you want Open-Inspect to work on.
3. Mention the agent in a comment:
   ```text
   @OpenInspect please implement this issue and open a pull request
   ```
4. Or assign the issue to the Linear Agent.
5. If Open-Inspect asks which repository to use, include the repository name in your reply, such as
   `owner/repo`.
6. Use **View Session** to watch the full Open-Inspect session while the agent works.
7. Send follow-up prompts from the same issue's active Linear Agent session.

---

## Supported Workflows

| Workflow                    | How it works                                                                  |
| --------------------------- | ----------------------------------------------------------------------------- |
| Start from an issue mention | Mention the Linear Agent on an issue                                          |
| Start from assignment       | Assign the issue to the Linear Agent                                          |
| Continue active work        | Send a follow-up prompt on the same issue while the session is still mapped   |
| Stop or cancel work         | Stop or cancel the Linear Agent session to stop the Open-Inspect session      |
| Resolve the repository      | Let Open-Inspect infer the repo, or include `owner/repo` when asked           |
| Follow progress             | Watch Linear activities or open the full session with **View Session**        |
| Customize behavior          | Set repository scope, model defaults, model overrides, and issue instructions |

Linear currently responds to Linear Agent session events. Ordinary Linear issue or comment webhook
events do not start Open-Inspect sessions by themselves.

---

## Starting Sessions

### From an `@mention`

Mention the Linear Agent on an issue when you want Open-Inspect to start work from that issue:

```text
@OpenInspect can you fix the failing invite flow described above?
```

Open-Inspect uses the issue title, description, labels, project, assignee, priority, recent
comments, and triggering comment as context. The triggering comment becomes the agent instruction,
so include the concrete work you want done.

### From Assignment

Assign the issue to the Linear Agent to ask Open-Inspect to pick it up. This is useful when the
issue already has enough title and description detail for the agent to understand the requested
work.

If the issue could apply to several repositories, include the repository name in the issue or a
comment. Open-Inspect may ask for clarification before starting.

### Follow-Up Messages

When a Linear issue already has an active Open-Inspect session, follow-up prompts on that issue are
sent to the existing session instead of creating a new one. The follow-up includes the new prompt
and a short summary of recent agent output when available.

Issue-to-session mappings are kept for several days. If the mapping has expired, or if the previous
session was stopped or cancelled, a new Linear Agent request may start a new Open-Inspect session.

### Stop or Cancel

Stopping or cancelling the Linear Agent session stops the associated Open-Inspect sandbox session
and clears the issue's session mapping.

---

## What You See

### Linear Activities

The Linear Agent posts progress through Linear's agent activity surface:

| Activity            | What it means                                                              |
| ------------------- | -------------------------------------------------------------------------- |
| Thinking            | Open-Inspect is analyzing the issue, resolving the repo, or creating work  |
| Working             | A session has started and the agent is working in the sandbox              |
| Tool progress       | Optional updates such as reading files, editing files, or running commands |
| Clarification       | Open-Inspect needs more information, usually the target repository         |
| Completion or error | The session finished, failed, or could not continue                        |

Tool progress is best-effort and may be disabled by an admin. The Open-Inspect web session remains
the best place to watch live output, inspect files, view logs, or take over.

### Session and Pull Request Links

When a session starts, Linear receives a **View Session** link. Follow-up acknowledgments include
the same session link.

When the agent finishes, Linear receives the final agent response. If the agent created a pull
request, Linear also gets a **Pull Request** link.

### Linear Issue Fields

Open-Inspect does not currently update Linear issue status, labels, assignee, priority, or project.
It posts Linear Agent activity and session links, while code changes and pull requests happen in the
connected repository.

---

## Repository Resolution

Open-Inspect needs to choose a repository before it can start a coding session. It usually resolves
the repository from the Linear project, team, labels, issue content, recent comments, and available
repository metadata.

If the issue could match more than one repository, include the intended repository name in the issue
or trigger comment:

```text
Please handle this in acme/billing-api.
```

If Open-Inspect is not confident, it asks a clarification question in Linear. Include the repository
name in `owner/repo` format in your reply. That follow-up gives Open-Inspect more context for the
next resolution attempt.

Admins can configure project-to-repository and team-to-repository mappings through the Linear Bot
setup/API flow. See
[Configure Repo Mapping](../../packages/linear-bot/README.md#4-configure-repo-mapping-optional) for
details.

After the repo is resolved, Open-Inspect checks whether the Linear integration is enabled for that
repository. If repository scope is set to **Selected repositories** and the repo is not selected,
Linear shows an error activity and the session does not start.

---

## Settings

Open the web app and go to **Settings > Integrations > Linear** to configure the Linear Agent.

### Defaults and Scope

| Setting                    | What it controls                                                             |
| -------------------------- | ---------------------------------------------------------------------------- |
| Default model              | Model used for Linear-started sessions when no higher-priority override wins |
| Default reasoning effort   | Reasoning depth for models that support reasoning effort controls            |
| Repository Scope           | Whether Linear can run against all accessible repos or only selected repos   |
| Issue Session Instructions | Extra guidance appended to Linear issue prompts                              |

If no Linear settings are configured, Open-Inspect uses permissive defaults: all accessible
repositories are in scope, user model preferences are allowed, model labels are allowed, and tool
progress activities are enabled.

If repository scope is set to **Selected repositories** and no repositories are selected, Linear
shows an error activity after repository resolution and the session does not start.

### Model Overrides

| Setting                        | What it controls                                                  |
| ------------------------------ | ----------------------------------------------------------------- |
| Allow user model preferences   | Whether admin-managed user preferences can override the model     |
| Allow model labels (`model:*`) | Whether Linear issue labels can choose the model                  |
| Repository Overrides           | Per-repository defaults for model, reasoning, and Linear behavior |

The settings page controls whether user preferences and labels are allowed, but Linear user
preferences are currently managed through admin/API configuration rather than a self-service Linear
screen.

Model selection uses this priority, highest to lowest:

1. `model:*` issue label, when allowed.
2. Linear user preference, when allowed.
3. Repository override or global Linear default.
4. Worker default model.

Label overrides win over user preferences. Supported label names include `model:haiku`,
`model:sonnet`, `model:opus`, `model:opus-4-6`, `model:opus-4-7`, `model:gpt-5.2`, `model:gpt-5.4`,
`model:gpt-5.5`, `model:gpt-5.2-codex`, and `model:gpt-5.3-codex`.

### Progress Updates

**Emit tool progress activities** controls whether Linear receives ephemeral activity updates for
file edits, file reads, and commands. Turning it off keeps completion responses and session links,
but hides intermediate tool activity in Linear.

---

## Admin and Safety Notes

- Linear webhooks are verified before Open-Inspect acts on them.
- Linear OAuth tokens, webhook secrets, and callback secrets stay server-side.
- Linear does not provide Git credentials. Repository access still comes from the deployment's
  configured source-control integration, such as the GitHub App installation.
- Repository scope in Linear settings controls which resolved repositories can receive
  Linear-started sessions.
- Linear issue text, comments, and prompt context are treated as untrusted content before being sent
  to the agent.
- The Linear Agent ignores ordinary non-agent webhook events today.

---

## Troubleshooting

### The agent does not appear in Linear

Confirm the Linear OAuth app is installed in the workspace and that the app was installed with the
agent scopes required for mentions and assignment. Setup details live in the
[Linear Bot setup guide](../../packages/linear-bot/README.md#setup).

### Mentioning the agent does not start a session

Make sure the mention is creating a Linear Agent session on an issue. Ordinary Linear comment
webhooks do not start Open-Inspect sessions unless they are part of the Linear Agent workflow.

### Assignment does not start a session

Check that the Linear Agent is assignable in the workspace and that the issue belongs to a repo
Open-Inspect can resolve and access.

### Open-Inspect asks which repository to use

Include the repository name in `owner/repo` format in your Linear reply. To avoid repeated
clarification, include the repository name in future issues or ask an admin to configure project or
team mappings through the Linear Bot setup/API flow.

### I see progress in Linear but need full logs

Open **View Session**. Linear shows status and completion activity, while detailed logs,
transcripts, artifacts, and file changes live in the Open-Inspect web session.

### The wrong model was used

Check **Settings > Integrations > Linear**. Repository overrides, user preferences, and `model:*`
labels can all affect model selection. Changes apply to new Linear-started sessions.

### The wrong repository was used

Check project and team repo mappings, issue labels, repository metadata, and the selected repository
scope. If an issue is ambiguous, include the intended `owner/repo` in the issue or trigger comment.

### The agent is active in too many repositories

Limit the source-control installation to intended repositories, or set **Repository Scope** to
**Selected repositories** in the Linear integration settings.
