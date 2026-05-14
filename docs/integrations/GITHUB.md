# GitHub Integration

Open-Inspect's GitHub integration lets your team start agent work from pull requests. The GitHub Bot
can automatically review new PRs and respond when you mention it in PR comments or inline review
threads.

This guide is for people using the GitHub integration day to day. If you are installing the GitHub
App or deploying the bot worker, start with
[Create GitHub App](../GETTING_STARTED.md#step-3-create-github-app) and
[Complete GitHub Bot Setup](../GETTING_STARTED.md#step-7c-complete-github-bot-setup-if-using-github-bot).

---

## Quick Start

1. Make sure the GitHub App is installed on the repository.
2. To get an automatic review, open a non-draft PR in a repository where auto-review is enabled.
3. To ask for analysis or a reply, mention the bot in a PR comment:
   ```text
   @my-app[bot] can you explain why the checkout test is failing?
   ```
4. For line-specific discussion, mention the bot in an inline PR review comment.
5. Watch for the eyes reaction, which means the bot accepted the request.
6. Open the Open-Inspect web app to watch the full session.

---

## Supported Workflows

| Workflow                  | How it works                                                               |
| ------------------------- | -------------------------------------------------------------------------- |
| Auto-review new PRs       | Review non-draft PRs when they are opened, if auto-review is enabled       |
| Respond to PR comments    | Mention the bot in a PR conversation comment                               |
| Respond to review threads | Mention the bot in an inline review comment                                |
| Post back to GitHub       | Submit a PR review, reply to a review thread, or post a PR summary comment |
| Customize behavior        | Set repository scope, trigger users, models, and custom instructions       |

Open-Inspect does not use GitHub slash commands today, and it does not support requesting the GitHub
App bot through the PR reviewer picker. Use auto-review or `@mention` comments instead.

---

## Automatic PR Reviews

### When It Runs

When **Auto-review new PRs** is enabled, Open-Inspect starts a review session for newly opened,
non-draft PRs in enabled repositories. The agent inspects the PR diff and posts a GitHub review.

### When It Skips

Auto-review is skipped when:

- The PR is a draft
- The PR was opened by the GitHub App bot itself
- The repository is outside the configured GitHub Bot scope
- The PR opener is not allowed to trigger the bot
- Auto-review is disabled globally or for that repository

Converting a draft PR to ready for review does not start the same auto-review path. If you need a
follow-up after a draft becomes ready, mention the bot in a PR comment.

### What It Posts

The agent can submit a general review comment, approve the PR, request changes, or add inline review
comments when useful.

---

## `@Mention` Actions

### PR Conversation Comments

Mention the GitHub App bot in a PR conversation comment to ask for analysis, a follow-up answer, or
a GitHub reply:

```text
@my-app[bot] can you explain why this retry path is failing?
```

Open-Inspect strips the bot mention before sending the request to the agent. The rest of the comment
becomes the prompt.

### Inline Review Threads

When you mention the bot in a PR review thread, Open-Inspect includes the file path and diff context
from that thread. The agent can reply directly to the review thread and can also post a summary
comment on the PR.

### Current Branch Behavior

Comment-triggered sessions currently start from the repository default branch, not the PR head
branch. Use them for responses and review-thread discussion rather than asking the agent to push
commits to the existing PR branch.

Each accepted GitHub webhook starts a new Open-Inspect session. GitHub comments do not continue an
existing session the way Slack thread replies do. The agent still reads the current PR conversation
when it needs context.

Comment-triggered actions only run on pull requests. Mentions on ordinary GitHub issues are ignored.
Comments from the bot itself are also ignored so the bot does not respond to its own output.

---

## What You See

### Acknowledgment

When a GitHub request is accepted, the bot adds an eyes reaction. That reaction is best-effort; if
GitHub rejects the reaction, the session can still start.

### GitHub Output

For auto-review workflows, the agent posts the review result back to the PR. Depending on what it
finds, that may be a general review comment, an approval, a request for changes, or inline review
comments.

For `@mention` workflows, the agent posts a PR comment summarizing its response or answering the
question. If the request came from an inline review thread, the agent may also reply in that thread.

GitHub does not receive the same managed completion message that Slack receives. After the initial
eyes reaction, GitHub-facing output is written by the agent from inside the session. Use the
Open-Inspect web app to watch live progress, inspect logs, or see artifacts.

---

## Settings

Open the web app and go to **Settings > Integrations > GitHub** to configure the GitHub Bot.

### Defaults and Scope

| Setting               | What it controls                                                                      |
| --------------------- | ------------------------------------------------------------------------------------- |
| Auto-review new PRs   | Whether new non-draft PRs should be reviewed automatically                            |
| Repository Scope      | Whether the bot responds in all accessible repositories or only selected repositories |
| Allowed Trigger Users | Who can trigger the bot from GitHub                                                   |

If no GitHub Bot settings are configured, Open-Inspect uses permissive defaults: all repositories
available to the GitHub App are in scope, auto-review is enabled, and users with write, maintain, or
admin access to the repository can trigger the bot.

If repository scope is set to **Selected repositories** and no repositories are selected, direct
GitHub Bot workflows are disabled. If **Only specific users** is selected and the user list is
empty, no one can trigger direct bot workflows for that scope.

These settings do not gate GitHub event automations. Automations are matched separately by their
repository, event type, enabled state, and trigger conditions.

### Models and Instructions

| Setting                     | What it controls                                                          |
| --------------------------- | ------------------------------------------------------------------------- |
| Model and reasoning effort  | Model and reasoning depth for GitHub-started sessions, when configured    |
| Code Review Instructions    | Extra guidance appended to PR review prompts                              |
| Comment Action Instructions | Extra guidance appended to `@mention` action prompts                      |
| Repository Overrides        | Per-repository overrides for model, reasoning, instructions, and behavior |

Repository overrides take priority over global defaults for the repository they apply to. The web UI
currently exposes model and reasoning settings on repository overrides. If global model or reasoning
defaults exist in integration settings, GitHub-started sessions honor them. If neither a repository
override nor global default sets a model, sessions use the deployment default model.

---

## Admin and Safety Notes

### Access Boundaries

- Repository access is deployment-scoped through the configured GitHub App installation. To restrict
  what Open-Inspect can access, install the GitHub App only on intended repositories and use
  **Repository Scope** for an additional bot-level filter.
- The same GitHub App is used for OAuth and repository access. GitHub App credentials and webhook
  secrets stay server-side.
- By default, trigger access is checked against GitHub repository permission and requires write,
  maintain, or admin access. If you configure **Only specific users**, that list becomes the trigger
  gate for the configured scope.

### Bot Behavior

- Auto-review skips draft PRs and PRs opened by the GitHub App bot. Manual `@mention` triggers are
  still evaluated through the normal repository and user gates.
- The bot ignores bot-authored comments, ordinary issue comments, and comments that do not mention
  the bot.
- If the bot cannot load its GitHub integration settings, it fails closed and does not start direct
  bot sessions.

### Prompt Safety

- Initial prompts mark selected GitHub fields as untrusted. Code-review prompts wrap PR title,
  author, branches, and description; comment-triggered prompts wrap the triggering comment.
- Review-thread file and diff context, plus GitHub context later read by the agent, are not
  separately transformed by the bot.
- Webhooks are verified before Open-Inspect acts on them. Duplicate webhook deliveries are
  deduplicated so GitHub retries do not normally create duplicate direct bot sessions.

---

## Troubleshooting

### The bot does not respond to a PR

Check that the GitHub App is installed on the repository and that the GitHub Bot worker is enabled.
Then confirm the webhook URL, webhook secret, subscribed events, and `github_bot_username` in
[Complete GitHub Bot Setup](../GETTING_STARTED.md#step-7c-complete-github-bot-setup-if-using-github-bot).

Also check **Settings > Integrations > GitHub**. For direct GitHub Bot workflows, the repository may
be outside the selected repository scope, or the triggering user may be outside the allowed user
list.

### Auto-review did not run

Auto-review only runs for newly opened, non-draft PRs. It is skipped for draft PRs, bot-authored
PRs, disabled repositories, and users who are not allowed to trigger the bot.

If a PR was converted from draft to ready for review, mention the bot in a PR comment instead.

### A mention did not start a session

Mentions must be in a pull request conversation comment or PR review thread. Mentions on ordinary
GitHub issues are ignored. Use the bot's full GitHub username, including `[bot]`, such as
`@my-app[bot]`.

### I see an eyes reaction but no follow-up

The eyes reaction means the bot accepted the request. GitHub completion output is posted by the
agent, not by a managed bot callback. The session may still be running, or the agent may have failed
after the request was accepted. Open the Open-Inspect web app to inspect the session.

### The wrong model or instructions were used

Check **Settings > Integrations > GitHub**. Repository overrides take priority over global defaults.
Changes apply to new GitHub-triggered sessions.

### The bot is active in too many repositories

Limit the GitHub App installation to the repositories Open-Inspect should access. You can also set
**Repository Scope** to **Selected repositories** in the GitHub integration settings.
