# Slack Integration

Open-Inspect's Slack integration lets your team start coding sessions from Slack, continue work in
the same Slack thread, set personal defaults in App Home, and ask agents to post Slack updates when
that workflow is enabled.

This guide is for people using the Slack integration day to day. If you are installing the Slack app
or deploying the worker, start with [Getting Started](../GETTING_STARTED.md#create-the-slack-app)
and [Complete Slack Setup](../GETTING_STARTED.md#complete-slack-setup). Optional notification
controls and safety notes are covered near the end.

---

## Quick Start

1. Invite the Open-Inspect Slack app to any channel where you want to use it.
2. In a channel, mention the bot with your request:
   ```text
   @Open-Inspect fix the failing checkout tests in acme/web
   ```
3. In a DM with the bot, send the request directly. You do not need to mention the bot in DMs.
4. If Open-Inspect asks which target to use, choose a repository, environment, or **No repository**
   from the dropdown.
5. Use **View Session** to open the full web session while the agent works.
6. Reply in the same Slack thread to continue the same session.

---

## What Slack Can Do

| Workflow                    | How it works                                                               |
| --------------------------- | -------------------------------------------------------------------------- |
| Start from a channel        | Invite the bot, then `@mention` it with a request                          |
| Start from a DM             | Send the bot a direct message                                              |
| Continue a session          | Reply in the same Slack thread                                             |
| Send images to the agent    | Attach PNG, JPEG, WebP, or GIF images to an interactive request            |
| Forward a message           | Share another Slack message with the bot; text, images, and source travel  |
| Pick the session target     | Use a repository, environment, or empty sandbox                            |
| Set personal defaults       | Use the Slack app's **Home** tab for model, reasoning effort, and branch   |
| Follow the result           | Read the completion reply or open the full session with **View Session**   |
| Review generated media      | Optionally attach charts, screenshots, and small recordings to the thread  |
| Ask the agent to post Slack | Enable agent notifications, then explicitly ask the agent to post to Slack |
| Auto-trigger from a channel | Watch a channel so matching messages start an automation                   |

Open-Inspect does not use slash commands today. In channels, interactive requests require an
`@mention`. [Channel-message triggers](#channel-message-triggers) can additionally start an
**automation** from non-mention messages that match conditions you configure.

All completion replies are delivered asynchronously through a Cloudflare Queue. Open-Inspect
attaches generated PNG, JPEG, WebP, or MP4 session artifacts to the completion thread. Delivery is
bounded to five files, 10 MiB per file, and 25 MiB total per completion. Additional or oversized
media remains available through **View Session**. Files merely written into the repository are not
uploaded automatically. Queue delivery requires the Terraform operator's Cloudflare token to have
**Queues: Edit**. Media delivery requires the Slack app's `files:write` bot scope and a one-time app
reinstall for each workspace.

Inbound images use a separate path and permission: images that you attach to a prompt require
`files:read`, while generated media that Open-Inspect posts back requires `files:write`. Adding
either scope to an existing Slack app requires reinstalling the app for the workspace.

---

## Starting Sessions

### From a channel

Invite the bot to the channel first, then mention it with the work you want done. Include the
repository name when the request could apply to more than one repo:

```text
@Open-Inspect update the billing docs in acme/api
```

Open-Inspect chooses from repositories and environments available in the channel's scope, using the
message, Slack channel context, and recent thread context. A configured
[routing-rule keyword](#routing-rules) takes precedence, followed by a single channel association.
Otherwise the classifier chooses the best target for the request, including **No repository** when
the task does not require a codebase. When the match is unclear, Open-Inspect asks you to choose a
repository, environment, or **No repository** in the Slack thread.

### From a DM

Open a direct message with the Open-Inspect bot and send the request:

```text
Can you investigate the flaky login test in acme/web?
```

DMs do not need an `@mention`. If you include one anyway, Open-Inspect strips it before sending the
request to the agent.

### Model and reasoning overrides

Start a DM or `@mention` request with `!model` or `!reasoning` to override your App Home defaults:

```text
@Open-Inspect !model anthropic/claude-sonnet-4-6 !reasoning max investigate the flaky test
```

Where you use the flags decides how long they last:

- **On a request that starts a session**, they become that session's defaults. Every follow-up in
  the thread keeps running on them until the thread ends, so you only have to pick the model once
  per task. The "Starting work..." acknowledgement names the model when it is not your App Home
  default.
- **On a follow-up in an existing session thread**, they apply to that one request and leave the
  session's defaults alone.

A running session's defaults cannot be changed. Naming your App Home model on a follow-up runs that
one request on it and leaves the session where it is; to go back to your defaults for good, start a
new session in a new thread.

Both flags accept a space or colon before their value, such as `!model:openai/gpt-5.6-sol` and
`!reasoning:high`. Any flags must appear together at the start of the request. Models must be
enabled under **Settings > Models**, and reasoning values must be supported by the selected model.

When your [agent harness](#default-model-and-agent-harness) is Claude Agent, a session-starting
`!model` that Claude Agent cannot run, such as `!model openai/gpt-5.4`, is refused and no session
starts. A follow-up stays on the thread's harness, so the control plane rejects a follow-up `!model`
that the harness cannot run. The bot replies in the thread:

> Model "openai/gpt-5.4" cannot run on the Claude Agent harness. A thread keeps the harness its
> session started on. Reply without `!model`, or start a new thread to use that model.

A `!reasoning`-only follow-up keeps the thread's session model, as a follow-up without flags does,
even if an administrator has since disabled that model. The thread's harness was chosen to run that
model, so the follow-up always runs.

To continue a session that started from a DM, reply in the Slack thread created for that DM request.
Sending a new top-level DM is treated as a new request and may start repository selection again.

### With image attachments

Attach PNG, JPEG, WebP, or GIF images to a DM, a channel request that `@mentions` the bot, or an
interactive thread follow-up. You can include instructions with the images or send images alone; for
example, attach a screenshot and ask Open-Inspect to fix the visible error. Open-Inspect forwards at
most six images per message, and each image must be no larger than 10 MiB.

If Open-Inspect asks you to choose a target, make the selection normally. The bot retrieves the
original message's images after you choose and forwards them with the saved request. If only some
images can be read, the remaining images and any message text still reach the agent, and the bot
posts a warning in the thread. If an image-only request loses every image, no empty session or
follow-up is sent.

This feature requires the Slack app's `files:read` bot scope and a reinstall after adding the scope.
Remote files hosted outside Slack and non-image attachments are not forwarded.

Interactive requests also retain files from the recent Slack thread context. A supported image on an
earlier selected message is forwarded through the same protected attachment path; file-only messages
remain visible through URL-free metadata in the message's JSON context record even when their file
type is unsupported or the image cannot be retrieved. Images on the current request take priority
within the six-image prompt limit, followed by deduplicated images from earlier context.

### With forwarded messages

Forward (share) another Slack message to a DM, to a channel request that `@mentions` the bot, or to
an interactive thread follow-up. Add your own comment — "deal with this" — and it becomes the
instruction the agent acts on; forward with no comment and the shared message is the whole request.

The whole forwarded message reaches the agent:

- Its text, with any links exactly as written.
- Its images, forwarded as prompt attachments like images you attach yourself. They share the
  per-message limits: at most six images, each no larger than 10 MiB.
- Its author, source channel, permalink, channel id, and message timestamp. An agent with Slack
  tooling of its own can use those to read the original thread for wider context.

Forward several messages at once and each is quoted separately, up to ten per request. Each shared
message's text is truncated at 4,000 characters. Link previews are skipped, since the message text
already carries the link.

### Target dropdowns

Target dropdowns are tied to the pending Slack thread, not to a personal GitHub repository list.
They show accessible repositories and environments plus **No repository**, which starts with an
empty sandbox. Open-Inspect keeps the original request for one hour; after a target is selected, the
session starts with that original request and thread context.

The planned model is rechecked before launch. If it was disabled while the request was pending, the
bot refuses to start a session rather than substituting another model. Send a new request with an
enabled model.

In shared channels, only the original requester can choose the target. If the dropdown has expired,
send the request again and name the repository, environment, or that no repository is needed.

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

### Session instructions

Administrators can define workspace-wide instructions for Slack-started sessions under **Settings →
Integrations → Slack → Session Instructions** in the web app. When set, the instructions are
appended to the first prompt of every new Slack-initiated session as an `## Additional Instructions`
section — use them for standing guidance such as coding standards, preferred tools, or PR
conventions. They apply to new sessions only (thread follow-ups continue with the session's existing
context), are limited to 10,000 characters, and mirror the Linear integration's **Issue Session
Instructions**.

### Default model and agent harness

Administrators set two workspace-wide defaults for new Slack sessions under **Settings >
Integrations > Slack**:

| Setting       | What it controls                                                                    |
| ------------- | ----------------------------------------------------------------------------------- |
| Default model | The model for users who have not chosen one in App Home; unset uses `DEFAULT_MODEL` |
| Agent harness | OpenCode (default) or Claude Agent for users who have not chosen one in App Home    |

A new session runs on the requester's App Home **Agent harness**, or on the workspace **Agent
harness** when the requester has not chosen one. Model selection for a new session uses this
priority, highest to lowest:

1. `!model` and `!reasoning` flags on the request that starts the session.
2. The requester's App Home model and reasoning effort.
3. The Slack **Default model**.
4. Deployment default model (`DEFAULT_MODEL`).

The effective model must be enabled under **Settings > Models**. If the App Home model, Slack
**Default model**, or deployment/system default used by the request is disabled, the bot refuses to
start a new session. It never substitutes a lower-priority default or the first enabled model.
Re-enable the model or update the applicable preference or default. An enabled App Home model or
leading `!model` override still works when a lower-priority default is disabled, provided the
session's harness can run it. Existing-thread follow-ups without `!model` keep the session's model,
even if it has since been disabled.

If the session's harness cannot run the resolved model, the bot starts no session. Claude Agent runs
Anthropic models only, so an OpenAI App Home model or `!model openai/gpt-5.4` is refused on Claude
Agent. After its "Starting work..." message, the bot replies in the thread:

> Model "openai/gpt-5.4" cannot run on the Claude Agent harness. Start your request with `!model`
> and a model Claude Agent can run, or change your model or agent harness in the Slack app's Home
> tab.

The settings form lists only models the selected harness can run and rejects saving a harness with a
model it cannot run. When the workspace **Agent harness** is Claude Agent, a **Default model** is
required: the form disables **Save** and says "Choose a default model Claude Agent can run." until
one is chosen, and the control plane rejects saving Claude Agent without one. "Use system default"
is not offered for Claude Agent, because the settings page cannot see the deployment default model,
which may be one Claude Agent cannot run.

A harness change applies to new sessions. Each thread keeps the harness its session started on. If
the bot cannot read the Slack settings, App Home may show OpenCode as the workspace-harness display
fallback without changing the user's saved App Home harness. This does not permit a new launch: new
session requests are refused until Slack settings are available.

Slack sessions are unattended, so on Claude Agent they follow the default Claude account's
**Automated authentication** policy and may use a connected Claude account. This applies when a user
picks Claude Agent in App Home too, even if the workspace harness is OpenCode. Set **Automated
authentication** to **No account (API key)** to keep Slack sessions on `ANTHROPIC_API_KEY`. The
session also loads the repository's `CLAUDE.md` and `.claude/` settings and hooks, and code the
agent runs inherits the Anthropic credential, so let Slack reach only repositories whose `.claude/`
configuration you trust. A repository's first Claude Agent sessions can start without its prebuilt
image if that image predates the Claude image floor. See
[Claude Agent](../CLAUDE_AGENT.md#slack-sessions).

---

## Threaded Conversations

A top-level Slack request starts a new Slack thread. Reply in that thread to send follow-up prompts
to the same Open-Inspect session. This applies in both channels and DMs: in a direct message, the
follow-up still needs to be a thread reply, not a fresh top-level DM.

Image attachments on interactive channel follow-ups must accompany an `@mention` of the bot. In a DM
thread, no mention is needed. Watched-channel automation threads are text-only, as described in
[Channel Message Triggers](#channel-message-triggers).

Open-Inspect keeps the Slack thread connected to the session for about 7 days. If you reply after
that mapping expires, or if you reply outside the thread, the bot may start target selection again
and create a new session.

An existing mapping is not replaced merely because a follow-up fails. If the session is missing or
no longer publishable in this channel, the bot reports that the thread is closed; start a new
request in a new thread. A follow-up 404 triggers a separate publication check: the mapping is
marked closed only when that check confirms denial. An actor-specific 403 leaves the mapping usable
by other authorized people, and an actor-concealed 404 does not close it for everyone when channel
publication is still allowed. Binding changes are checked on each mapped follow-up. A closed mapping
can reopen if its original team binding matches again and publication is allowed.

For follow-ups, Open-Inspect includes up to ten recent thread messages posted after the preceding
prompt and strictly before the new request. Replies that arrive while Slack history is being fetched
are not exposed to the earlier turn; they remain eligible for a later follow-up. Earlier messages
are encoded as untrusted JSON records with speaker and timestamp provenance; file-only messages keep
URL-free metadata, and supported images are forwarded as described above. Open-Inspect also adds an
eyes reaction while the follow-up is being processed, then removes it when the completion reply is
posted.

---

## What Gets Posted Back

When a request is accepted, Open-Inspect posts a working reply in the Slack thread and adds a **View
Session** button once the web session exists.

The web session is the best place to watch live output, inspect files, or take over.

When the agent finishes, Slack receives a completion reply with:

- The agent's final response, shortened if it is too long for Slack
- Created artifacts such as pull requests or branches
- A few key tool actions, such as edits or commands
- The final status, model, session target, and reasoning effort when available
- A **View Session** button

If the agent created a manual-PR branch and no PR artifact is already present, Slack may also show a
**Create PR** button. Detailed event logs stay in the web session. Generated media is attached only
when the operator enables media delivery; it always remains available through **View Session**.

---

## App Home Preferences

Open the Open-Inspect app in Slack and go to the **Home** tab to set your personal defaults for new
Slack sessions.

| Setting          | What it controls                                                             |
| ---------------- | ---------------------------------------------------------------------------- |
| Agent harness    | Workspace default, OpenCode, or Claude Agent for your new Slack sessions     |
| Model            | The model used when you start a new session from Slack                       |
| Reasoning effort | The reasoning depth, shown for models that support reasoning effort controls |
| Branch           | A global branch override for new Slack sessions                              |
| Branch by repo   | A branch override for one repository, shown when repositories are available  |

The selector uses models enabled in **Settings > Models** in the web app. If Slack cannot load that
list, Home shows a temporary-unavailability notice and preserves your configured model and reasoning
without treating the model as disabled. It lists only models your agent harness can run. If
compatible enabled models are available but your current model is disabled or incompatible, the
selector shows "Choose a model" with no selection and a refusal note. If no enabled model can run on
the selected harness, Home shows a message instead of a selector, asking you to choose another
harness or have an admin enable a compatible model. The "Currently using" summary names your model
and agent harness, or marks the model as needing replacement.

Branch preference priority is:

1. Repository-specific branch override
2. Global branch override
3. Repository default branch

These preferences are per Slack user. They affect new Slack sessions; follow-ups in an existing
Slack thread continue the existing session. A leading `!model` or `!reasoning` flag overrides the
corresponding setting for the session it starts, or for a single follow-up request, without changing
these preferences. Without an App Home model or agent harness, new sessions use the workspace
[default model and agent harness](#default-model-and-agent-harness).

---

## Optional Agent Notifications

Interactive Slack sessions (DMs and `@mentions`) get normal thread replies and completion messages
only while publication is allowed. Agent notifications are separate: they let an agent post an extra
message to a Slack channel when you explicitly ask for it:

```text
When you finish, post a short summary to #eng-updates.
```

To use this workflow:

1. Open the web app and go to **Settings > Integrations > Slack**.
2. Turn on **Enable agent notifications**.
3. Invite the Open-Inspect Slack bot to any channel where agents should be allowed to post.
4. Optional: add repository overrides to inherit, force on, or force off agent notifications for
   specific repositories.

Bot membership is necessary, but is not the only publication check. Private-session output is
refused, as is output to a channel bound to a different owning team, even for a workspace-visible
session. These checks also cover managed completions and generated media. They use current session
visibility and channel bindings, not just the binding at launch. An unbound destination is not
automatically a cross-team refusal; do not treat channel bindings as an outbound allowlist. Slack
may still reject missing, archived, inaccessible, or rate-limited targets.

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

Slack Message automations ingest triggering-message text only. A triggering message that carries an
attachment starts an automation on its text alone — the attachment itself is not forwarded, so an
image-only trigger starts nothing. Attachments on automation thread replies are likewise not sent as
bytes, and the body of a forwarded message is not read. When an earlier message selected for thread
context has files, URL-free file metadata is retained in that context so the message does not
disappear; supported images are explicitly marked as not forwarded by automations. Use an
interactive DM or `@mention` when the agent needs image bytes or a forwarded message.

When the triggering message is a **reply**, the agent also receives the thread it was posted in, so
it can read the reply in context rather than as an isolated sentence. The thread is read only once a
run has actually been admitted — never for messages that match no automation, for follow-ups that
continue an existing session, or for firings dropped as concurrent or duplicate — and once per
message however many automations match it. Top-level messages have no thread to read.

The context contains up to 20 messages posted strictly before the trigger; on long threads, the
opening message is preserved alongside the most recent replies. Each message is truncated to 1,024
characters, and its record includes the Slack timestamp plus a speaker identity for people, apps,
and the bot's own earlier turns without relying on a display name alone. It is passed as JSON and
labelled untrusted: Slack text is written by people who may not be asking the agent anything, so it
is presented as a record of the conversation rather than as instructions. If Slack cannot be read,
the run starts with no thread history rather than failing.

### Slack app setup

In addition to the standard event subscription the bot already uses, enable the bot to receive
ordinary channel messages:

- **Event subscriptions**: subscribe to `message.channels` (public channels). Add `message.groups`
  if you also want to watch private channels.
- **Bot token scopes**: `channels:history` (public) and, for private channels, `groups:history`.
- Invite the bot to every channel you intend to watch. The bot only sees messages in channels it is
  a member of.

Then, in the web app, create a **Slack Message** automation and add a **Slack Channel** condition
(pick channels by name; channel IDs also work as a fallback). Optionally add a **Message Text**
condition to filter by content. See
[Slack Message Triggers](../AUTOMATIONS.md#slack-message-triggers) for the full field reference.

### Run feedback

- A triggering message gets a 👀 reaction while its run is in flight.
- When the run finishes, the agent's final response is posted into the triggering message's thread
  (with links to any pull requests and the full session), and the reaction is cleared. A failed run
  posts a short failure notice instead.
- A run can **decline to reply**. If the agent's entire final message is `NO_REPLY` (or empty),
  nothing is posted and only the 👀 reaction is cleared. This lets an automation that watches a busy
  channel stay quiet on messages that turn out to need nothing from it — chatter between people, or
  a follow-up addressed to someone else — instead of posting its reasoning about why it has nothing
  to say. It applies to thread follow-ups as much as to the first trigger, which is where it matters
  most: every reply in the thread wakes the automation. Tell the agent about the sentinel in the
  automation's instructions; without an explicit instruction it will answer every message it is
  woken for. A run that opened a pull request or produced other artifacts always posts, and
  interactive `@mention` sessions never decline — a person is waiting on a visible answer there.
- Authorized replies in a thread continue the same session, during the run and after it finishes,
  for up to 7 days after the thread's first trigger, like replying in an `@mention` thread. The
  reply is routed to that session as a follow-up prompt (re-spawned from a snapshot if it had gone
  idle), gets its own 👀 reaction and in-thread response, and does **not** need to match the
  trigger's text condition — conditions gate new runs, not replies that continue a thread. A reply
  more than 7 days after the first trigger starts a fresh run.

The automation scheduler checks each reply author's session collaboration access; a rejected author
does not start a replacement run for that automation. This is separate from interactive
mapped-thread handling: if no steerable session exists or enqueueing fails, the scheduler may
re-evaluate the reply as a new trigger. Runs retain the automation's saved owning team, not the
channel's interactive routing choice. Publication still checks current visibility and channel
bindings, so admission does not guarantee a reply can be posted.

### Threat model

Channel triggers widen who can start a coding session, so weigh the following before configuring
them:

- **Any member of a watched channel can supply a matching trigger** unless conditions restrict them.
  Treat watched channels as sources of untrusted requests to the automation's executor. Execution
  membership and grant checks do not make the triggering message trustworthy.
- **Prefer an allowlist.** Add a **Slack User** condition (`include`) so only specific people can
  trigger the automation, and keep watched channels small and trusted.
- **Message text reaches the agent.** The triggering message becomes part of the prompt. Scope the
  automation's instructions defensively and rely on the deployment's repository access boundary —
  the same GitHub App installation limits used elsewhere apply here too.
- **Regex conditions run untimed.** Conditions are evaluated with the native regex engine and no
  per-match timeout; a pathological pattern is an operator-authored risk. Patterns are length-capped
  and validated at save time.

---

## Admin and Safety Notes

These notes are most useful for workspace admins deciding where the Slack bot should be available.

### Team Channel Bindings

A team lead or workspace administrator can bind a Slack channel in the team's **Channels** tab.
**Primary** marks the team's main Slack binding; **Source** adds another channel that routes new
interactive sessions to the same team. Both kinds determine ownership, not a repository or a default
notification destination. Each channel can belong to only one team, and each team can have only one
primary binding per provider. The bot must already be in the channel; externally shared Slack
Connect channels cannot be bound.

The Slack integration's `unboundChannels` policy is `workspace` by default: an unbound channel
starts workspace-owned sessions. With `reject`, new interactive requests in unbound channels are
refused until a binding is added. Unbound DMs remain workspace-scoped under either policy. A failed
binding lookup stops the request rather than silently falling back to workspace ownership.

Classification and target dropdowns use a live channel- and actor-scoped catalog. Bound-team
catalogs require team membership or workspace-admin access and are filtered by repository grants and
eligible environments. Starting a team-owned session checks the actor's actual team membership and
grants for the selected target; Slack channel membership alone does not enroll that person in the
Open-Inspect team. Picker submissions recheck the binding, so an old picker cannot transfer a
request to another team. Repository routing rules and channel associations select a target within
this scope; they do not grant access.

`TEAMS_ENFORCEMENT` still defaults to `shadow`, not `on`. Do not assume full team-read isolation in
that mode. Team creation checks, scoped catalogs, live Slack follow-up channel checks, private
access, and Slack publication gates are not a promise that every team read is enforced.

- Slack bot tokens stay server-side. They are not sent to sandboxes.
- Slack requests are verified before Open-Inspect acts on them.
- The source-control installation is the outer repository boundary, not a per-Slack-user GitHub
  permission list. Team bindings, memberships, and repository grants further constrain team work.
- Invite the bot only into trusted channels; identity linking does not itself grant team membership.
- Bot messages are ignored so the Slack bot does not respond to itself.
- Agent notifications require bot membership and the publication checks described above.
- Accepted notification text is sanitized and shortened to fit Slack block limits; extremely large
  raw inputs are rejected.

---

## Troubleshooting

### The bot does not respond in a channel

For an interactive request, check that the bot has been invited to the channel and that your message
mentions the bot. An ordinary channel message only starts a session when it matches a configured
Slack Message automation; verify its watched channel and conditions.

If setup was just changed, confirm the Slack app event subscriptions and interactivity URLs in
[Complete Slack Setup](../GETTING_STARTED.md#complete-slack-setup).

### DMs do not start sessions

The Slack app needs the direct message event subscription configured. Once that is set up, send the
bot a plain DM with your request. No `@mention` is required.

### Open-Inspect asks which target to use

Choose a repository, environment, or **No repository** from the dropdown, or resend the request with
the intended target included. The dropdown expires after one hour.

### A follow-up started a new session

Reply inside the same Slack thread as the original request. Thread-to-session mappings last about 7
days, so older threads may need a fresh request.

### An attached image did not reach the agent

Confirm the Slack app has the `files:read` bot scope and was reinstalled after that scope was added.
Use PNG, JPEG, WebP, or GIF images no larger than 10 MiB, with at most six images in one message.
For a channel request or interactive channel follow-up, `@mention` the bot; DMs do not need a
mention.

The bot may also need `channels:history` for public-channel messages or `groups:history` for
private-channel messages so it can recover file details that Slack omits from `app_mention` events.
If some images fail, check the warning posted in the thread. `files:write` does not grant inbound
image access; it is used only when Open-Inspect posts generated media back to Slack.

### A forwarded message did not reach the agent

The same `channels:history` / `groups:history` scopes let the bot recover a forwarded message's
content when Slack omits it from the `app_mention` event, and images inside a forwarded message need
`files:read` like any other inbound image.

### The wrong model or branch was used

Open the Slack app's **Home** tab and check your agent harness, model, reasoning effort, and branch
preferences. Repository-specific branch overrides take priority over the global branch override.
Without an App Home model or agent harness, sessions use the **Default model** and **Agent harness**
in **Settings > Integrations > Slack**, then the deployment default model. Preference changes apply
to new Slack sessions.

### Slack refused a request because of its model

Claude Agent runs Anthropic models only. When your agent harness is Claude Agent, a non-Anthropic
model from `!model`, App Home, or the defaults is refused with "Model ... cannot run on the Claude
Agent harness." and no session starts. Start the request with `!model` and an Anthropic model, or
change your model or agent harness in the Slack app's **Home** tab. Your harness is your App Home
choice, else the workspace **Agent harness**. In an existing thread, the session keeps the harness
it started on, so reply without `!model` or start a new thread.

### The agent could not post a Slack notification

Check **Settings > Integrations > Slack** and confirm agent notifications are enabled for the
repository. Also confirm the bot is in the target channel. If Slack rate-limits the post, the web
session may show retry timing when Slack provides it.

### The Slack completion looks short

Slack completion replies are shortened to fit Slack message limits. Open the full web session for
the complete transcript, tool output, screenshots, and artifacts.
