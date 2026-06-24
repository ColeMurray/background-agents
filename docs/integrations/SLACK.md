# Slack Integration

Open-Inspect's Slack integration lets your team start coding sessions from Slack, continue work in
the same Slack thread, set personal defaults in App Home, and ask agents to post Slack updates when
that workflow is enabled.

This guide is for people using the Slack integration day to day. If you are installing the Slack app
or deploying the worker, start with
[Getting Started](../GETTING_STARTED.md#step-4-create-slack-app-optional) and
[Complete Slack Setup](../GETTING_STARTED.md#step-7b-complete-slack-setup-if-using-slack). Optional
notification controls and safety notes are covered near the end.

---

## Quick Start

1. Invite the Open-Inspect Slack app to any channel where you want to use it.
2. In a channel, mention the bot with your request:
   ```text
   @Open-Inspect fix the failing checkout tests in acme/web
   ```
3. In a DM with the bot, send the request directly. You do not need to mention the bot in DMs.
4. If Open-Inspect asks which repository to use, choose one from the dropdown.
5. Use **View Session** to open the full web session while the agent works.
6. Reply in the same Slack thread to continue the same session.

---

## What Slack Can Do

| Workflow                    | How it works                                                               |
| --------------------------- | -------------------------------------------------------------------------- |
| Start from a channel        | Invite the bot, then `@mention` it with a request                          |
| Start from a DM             | Send the bot a direct message                                              |
| Continue a session          | Reply in the same Slack thread                                             |
| Pick the repository         | Let Open-Inspect infer it, or choose from a dropdown when it is unsure     |
| Set personal defaults       | Use the Slack app's **Home** tab for model, reasoning effort, and branch   |
| Follow the result           | Read the completion reply or open the full session with **View Session**   |
| Ask the agent to post Slack | Enable agent notifications, then explicitly ask the agent to post to Slack |
| Auto-trigger from a channel | Opt-in: watch a channel so matching messages start an automation           |

Open-Inspect does not use slash commands today. In channels, it normally responds only to
`@mentions`, not to every message. The optional
[channel-message triggers](#channel-message-triggers) feature can additionally start an
**automation** from non-mention messages that match conditions you configure; it is disabled by
default and must be enabled by an operator.

---

## Starting Sessions

### From a channel

Invite the bot to the channel first, then mention it with the work you want done. Include the
repository name when the request could apply to more than one repo:

```text
@Open-Inspect update the billing docs in acme/api
```

Open-Inspect chooses from repositories available to this Open-Inspect deployment, using the message,
Slack channel context, and recent thread context. It picks a repository in this order: if only one
repository is available, it uses that one; if your message contains a configured
[routing-rule keyword](#routing-rules), it routes to that keyword's repository; if an administrator
has associated the Slack channel with exactly one repository, that repository is used; otherwise it
infers the repository from your message. When the match is unclear, Open-Inspect asks you to choose
from candidate repositories in the Slack thread.

### From a DM

Open a direct message with the Open-Inspect bot and send the request:

```text
Can you investigate the flaky login test in acme/web?
```

DMs do not need an `@mention`. If you include one anyway, Open-Inspect strips it before sending the
request to the agent.

To continue a session that started from a DM, reply in the Slack thread created for that DM request.
Sending a new top-level DM is treated as a new request and may start repository selection again.

### Repository dropdowns

Repository dropdowns are tied to the pending Slack thread, not to a personal GitHub repository list.
They show candidate repositories that the Open-Inspect deployment can access. Open-Inspect keeps the
original request for one hour; after a repository is selected, the session starts with that original
request and thread context.

In shared channels, the original requester should choose the repository. If the dropdown has
expired, send the request again and include the repository name, such as `owner/repo`.

### Routing rules

Administrators can map keywords to repositories so common requests route instantly, without
Open-Inspect having to guess. Configure them in the web app under **Settings → Integrations → Slack
→ Routing rules**: each rule pairs a keyword with a target repository.

For example, with `frontend → acme/web-app` and `api → acme/backend`:

- `@Open-Inspect fix the frontend nav bug` → routes to `acme/web-app`
- `@Open-Inspect add the new api endpoint` → routes to `acme/backend`

How matching works:

- **Whole words, case-insensitive.** `api` matches "the api is down" but not "rapidly".
- **Channels and DMs.** Rules apply everywhere, which makes them especially useful in DMs where
  there is no channel association.
- **Rules beat channel association.** An explicit keyword always wins over the channel's default
  repository.
- **Ambiguity asks, never guesses.** If one message matches keywords for two different repositories,
  Open-Inspect shows the repository picker seeded with those candidates.
- **Stale targets are ignored.** A rule whose repository is later removed from the deployment
  becomes inert until access is restored, rather than routing somewhere unexpected.

Routing rules do not override an active thread: a keyword in a thread reply does not move that
conversation to a different repository.

---

## Threaded Conversations

A top-level Slack request starts a new Slack thread. Reply in that thread to send follow-up prompts
to the same Open-Inspect session. This applies in both channels and DMs: in a direct message, the
follow-up still needs to be a thread reply, not a fresh top-level DM.

Open-Inspect keeps the Slack thread connected to the session for about 24 hours. If you reply after
that mapping expires, or if you reply outside the thread, the bot may start repository selection
again and create a new session.

For follow-ups, Open-Inspect includes recent thread context with the new prompt. It also adds an
eyes reaction while the follow-up is being processed, then removes it when the completion reply is
posted.

---

## What Gets Posted Back

When a request is accepted, Open-Inspect posts a working reply in the Slack thread and then adds a
link to the web session once it exists. For confident repository matches, the working reply may
include a **View Session** button. Every session also gets a session-started reply with a **View
progress** link.

The web session is the best place to watch live output, inspect files, or take over.

When the agent finishes, Slack receives a completion reply with:

- The agent's final response, shortened if it is too long for Slack
- Created artifacts such as pull requests or branches
- A few key tool actions, such as edits or commands
- The final status, model, repository, and reasoning effort when available
- A **View Session** button

If the agent created a manual-PR branch and no PR artifact is already present, Slack may also show a
**Create PR** button. Screenshots and detailed event logs stay in the web session instead of being
expanded into the Slack completion reply.

---

## App Home Preferences

Open the Open-Inspect app in Slack and go to the **Home** tab to set your personal defaults for new
Slack sessions.

| Setting          | What it controls                                                             |
| ---------------- | ---------------------------------------------------------------------------- |
| Model            | The model used when you start a new session from Slack                       |
| Reasoning effort | The reasoning depth, shown for models that support reasoning effort controls |
| Branch           | A global branch override for new Slack sessions                              |
| Branch by repo   | A branch override for one repository, shown when repositories are available  |

The selector normally uses models enabled in **Settings > Models** in the web app. If Slack cannot
load that list, it falls back to the default enabled models.

Branch preference priority is:

1. Repository-specific branch override
2. Global branch override
3. Repository default branch

These preferences are per Slack user. They affect new Slack sessions; follow-ups in an existing
Slack thread continue the existing session.

---

## Optional Agent Notifications

Slack-started sessions always get their normal thread replies and completion messages. Agent
notifications are separate: they let an agent post an extra message to a Slack channel when you
explicitly ask for it:

```text
When you finish, post a short summary to #eng-updates.
```

To use this workflow:

1. Open the web app and go to **Settings > Integrations > Slack**.
2. Turn on **Enable agent notifications**.
3. Invite the Open-Inspect Slack bot to any channel where agents should be allowed to post.
4. Optional: add repository overrides to inherit, force on, or force off agent notifications for
   specific repositories.

Channel membership controls where these extra posts can go. Invite the bot to a channel to make it
available; remove it from a channel to remove access. Slack may still reject missing, archived,
inaccessible, or rate-limited targets.

Changes apply to new sessions. If you turn notifications on and an existing session cannot post to
Slack, start a new session. Turning notifications off blocks future notification attempts.

### Mentions

The Slack settings page includes a workspace-wide mentions policy for direct user mentions like
`<@U123>`.

| Policy | Result                                                          |
| ------ | --------------------------------------------------------------- |
| Allow  | Direct user mentions are posted to Slack                        |
| Escape | Direct user mentions are rewritten as literal text like `@U123` |
| Strip  | Direct user mentions are removed                                |

Broadcast mention tokens such as `<!channel>`, `<!here>`, `<!everyone>`, and `<!subteam^...>` are
always stripped from agent notification messages.

---

## Channel Message Triggers

Channel message triggers let an **automation** start a session when someone posts a matching message
in a watched channel — without `@mentioning` the bot. This is distinct from the interactive
`@mention` flow: it is driven by [automations](../AUTOMATIONS.md#slack-message-triggers) with
keyword, substring, or regex conditions.

The feature is **disabled by default** and gated by the `SLACK_TRIGGERS_ENABLED` deployment flag.
When the flag is off, the bot ignores channel messages and forwards nothing; authoring a Slack
automation in the web app is still allowed, but it will not run until the flag is enabled.

### Slack app setup

In addition to the standard event subscription the bot already uses, enable the bot to receive
ordinary channel messages:

- **Event subscriptions**: subscribe to `message.channels` (public channels). Add `message.groups`
  if you also want to watch private channels.
- **Bot token scopes**: `channels:history` (public) and, for private channels, `groups:history`.
- Invite the bot to every channel you intend to watch. The bot only sees messages in channels it is
  a member of.

Then, in the web app, create a **Slack Message** automation, add a **Slack Channel** condition with
the channel ID(s), and a **Message Text** condition. See
[Slack Message Triggers](../AUTOMATIONS.md#slack-message-triggers) for the full field reference.

### Reply and rate behavior

- The run result is posted back into the originating thread when **Reply in thread** is on
  (default).
- A triggering message gets a 👀 reaction while its run is in flight; it is cleared when the result
  posts.
- **Max runs per hour** caps how often an automation fires; messages over the cap are skipped
  (recorded as `rate_limited`) and start no session.
- A new matching message in a thread that already has an active run is skipped and the author gets
  an ephemeral "a run is already active" notice.

### Threat model

Channel triggers widen who can start a coding session, so weigh the following before enabling them:

- **Any member of a watched channel can trigger a run** simply by posting a matching message. Treat
  every watched channel as a list of people authorized to start sessions against the automation's
  repository.
- **Prefer an allowlist.** Add a **Slack User** condition (`include`) so only specific people can
  trigger the automation, and keep watched channels small and trusted.
- **Message text reaches the agent.** The triggering message becomes part of the prompt. Scope the
  automation's instructions defensively and rely on the deployment's repository access boundary —
  the same GitHub App installation limits used elsewhere apply here too.
- **Regex conditions run untimed.** Conditions are evaluated with the native regex engine and no
  per-match timeout; a pathological pattern is an operator-authored risk. Patterns are length-capped
  and validated at save time, and the `SLACK_TRIGGERS_ENABLED` flag is the kill switch if a bad
  pattern degrades automation dispatch.
- **The kill switch is immediate.** Setting `SLACK_TRIGGERS_ENABLED` back to `false` stops the bot
  from ingesting or forwarding channel messages right away.

---

## Admin and Safety Notes

These notes are most useful for workspace admins deciding where the Slack bot should be available.

- Slack bot tokens stay server-side. They are not sent to sandboxes.
- Slack requests are verified before Open-Inspect acts on them.
- Slack-created sessions use deployment-level repository access. The repositories shown in Slack are
  the repositories accessible to the configured GitHub App or SCM installation, not a per-Slack-user
  GitHub permission list.
- Slack identity linking is best-effort and is not used to approve repository access. To restrict
  what Slack sessions can touch, limit the GitHub App installation to selected repositories and
  invite the Slack bot only into trusted channels.
- Bot messages are ignored so the Slack bot does not respond to itself.
- Agent notifications use Slack channel membership as the access boundary.
- Accepted notification text is sanitized and shortened to fit Slack block limits; extremely large
  raw inputs are rejected.

---

## Troubleshooting

### The bot does not respond in a channel

Check that the bot has been invited to the channel and that your message mentions the bot. The bot
does not act on ordinary channel messages.

If setup was just changed, confirm the Slack app event subscriptions and interactivity URLs in
[Complete Slack Setup](../GETTING_STARTED.md#step-7b-complete-slack-setup-if-using-slack).

### DMs do not start sessions

The Slack app needs the direct message event subscription configured. Once that is set up, send the
bot a plain DM with your request. No `@mention` is required.

### Open-Inspect asks which repository to use

Choose a repository from the dropdown, or resend the request with the repository name included. The
dropdown expires after one hour.

### A follow-up started a new session

Reply inside the same Slack thread as the original request. Thread-to-session mappings last about 24
hours, so older threads may need a fresh request.

### The wrong model or branch was used

Open the Slack app's **Home** tab and check your model, reasoning effort, and branch preferences.
Repository-specific branch overrides take priority over the global branch override. Preference
changes apply to new Slack sessions.

### The agent could not post a Slack notification

Check **Settings > Integrations > Slack** and confirm agent notifications are enabled for the
repository. Also confirm the bot is in the target channel. If Slack rate-limits the post, the web
session may show retry timing when Slack provides it.

### The Slack completion looks short

Slack completion replies are shortened to fit Slack message limits. Open the full web session for
the complete transcript, tool output, screenshots, and artifacts.
