# Changelog

New features, integrations, and notable improvements to Open-Inspect — newest first.

## August 15, 2026

**Managed skills.** Create and edit reusable Agent Skills in Settings, assign them globally or to
specific repositories and environments, and organize personal profiles. When starting a session,
choose all applicable skills, none, or a profile; Open-Inspect pins and securely installs the exact
revisions before the agent starts, while the session sidebar records each skill's revision and
assignment source so existing sessions stay reproducible as the shared catalog changes.

**Multiple pull requests per session.** The `create-pull-request` tool now opens one PR per head
branch instead of one per repository: agents can create stacked PRs (each level passing the previous
branch as `baseBranch`), open a fresh PR after the previous one merges, and calling the tool again
from the same branch updates that branch's open PR with the latest commits instead of failing. Every
PR is tracked with full lifecycle state and listed in the session sidebar with its live status, and
stale artifacts heal when the provider reports a PR already merged. Sessions holding several PRs get
a Pull requests sidebar section with one sync control for all of them, and the View PR action
becomes a picker naming each PR by number and head branch.

**Claude Sonnet 5 and Grok 4.6.** Adds `anthropic/claude-sonnet-5` to the model picker and
integrations with adaptive thinking and reasoning efforts from low through max, and `xai/grok-4.6`
to the opt-in xAI / SuperGrok catalog with low, medium, and high efforts.

**Kimi K3 and GLM 5.3.** Adds `opencode/kimi-k3` to the opt-in OpenCode Zen catalog and
`zai-coding-plan/glm-5.3` to the opt-in Z.AI Coding Plan catalog.

**Cancel queued prompts.** Pending web prompts can now be removed before they start processing,
freeing queue capacity and restoring the removed text to an empty composer after server
confirmation.

## August 14, 2026

**OpenCode runtime upgraded to 1.18.18.** Newly built images across all sandbox providers now use a
release that fixes a message-ID wraparound which prevented older sessions from recognizing new
prompts after August 14. Sessions restored from pre-upgrade snapshots retain their existing runtime.

**Automatic abandoned-draft cleanup.** Warmed sessions that never receive a prompt are archived
after an eight-hour grace period, while sessions that have started work or contain messages or
queued prompts are left untouched.

**More adaptable session controls.** Desktop users can hide the session details sidebar, with the
preference preserved across visits. Mobile headers now show separate connection and sandbox states,
including lifecycle details and provider-dashboard access when available.

**Search and paginate automations.** The automation list now supports URL-backed name search and
stable cursor pagination, with responsive rows and distinct empty, no-results, and error states.

## August 13, 2026

**Cleaner, more responsive session timelines.** Completed turns collapse intermediate activity
behind a “Worked for” disclosure while keeping the prompt and final response visible. Long text and
expanded tool details now wrap or scroll within mobile layouts without widening the page.

## August 12, 2026

**Queue web follow-up prompts.** Submit up to ten follow-ups while a session is processing, with
durable FIFO ordering, state synchronized across tabs and reloads, and idempotent retries that avoid
duplicate work.

**Correct child-session attribution.** Child sessions and parent-to-child follow-ups now use the
active prompt author's identity and SCM credentials instead of always inheriting the parent session
owner, including prompts started from bot integrations.

## August 11, 2026

**Clear Slack speaker attribution.** Slack-started sessions and follow-ups now label the current
message with the sender's display name and stable Slack ID, preserving who gave an instruction in
multi-person threads and across repository clarification.

## August 9, 2026

**Browser-based sandbox desktops.** Opt in to a full VNC desktop for sessions, available from the
session sidebar through authenticated noVNC access. Desktop settings can be configured globally or
overridden per environment and repository, and work across supported sandbox providers.

**Follow up with child sessions.** Parent agents can queue additional instructions for direct child
sessions with `send-child-prompt`, including resuming completed or failed children while preserving
lineage, ownership, concurrency, and cancellation safeguards.

## August 8, 2026

**Context-aware Slack channel automations.** Runs triggered from Slack threads can now include the
root and recent earlier replies, with bounded, safely attributed context. Text-bearing file-share
messages can trigger runs too, while history failures fall back without blocking the automation.

**Clearer, more resilient session timelines.** Session pages now server-render from a canonical
snapshot, keep existing content visible through WebSocket reconnects, and show when OpenCode
compacts context to continue a long-running session.

## August 7, 2026

**Labels for session-created pull requests.** Configure a label for pull and merge requests, with a
global default and per-repository overrides. The policy applies to the actual target repository in
multi-repo sessions, supports GitHub and GitLab, and creates missing GitHub labels when permitted.

## August 5, 2026

**Draft pull request policy.** Configure session-created pull requests to open as drafts by default,
globally or per repository. The policy applies to the actual target repository in multi-repo
sessions and works across GitHub and GitLab deployments.

## August 3, 2026

**Unread session outcomes.** Per-user unread indicators now highlight sessions and child sessions
with new terminal results. Viewing meaningful output in an active tab marks it read automatically,
with an explicit Mark as read action also available.

## August 1, 2026

**Grok models with your SuperGrok subscription.** Use Grok 4.5 or Grok Build 0.1 through managed xAI
OAuth, with opt-in model controls and reasoning-effort settings for Grok 4.5. Refresh credentials
stay encrypted in the control plane while sandboxes receive only short-lived access tokens.

## July 31, 2026

**Automatic prebuild refresh.** Repository and environment images now rebuild automatically when
tracked branches move or the sandbox runtime changes, with provider-neutral scheduling and durable
finalization across Modal, Vercel, and OpenComputer.

**Configurable session lifetimes.** Set sandbox timeouts globally or per repository and environment;
the setting applies to fresh, restored, and resumed sandboxes, and child sessions inherit it.

**More control over child sessions.** Child-session tools now use consistent `spawn-child`,
`get-child-status`, and `cancel-child` names. Spawned children inherit the parent's model and
reasoning effort by default, with optional per-child overrides.

**Better Slack session guidance.** Workspace-wide instructions can now apply to every Slack-started
session. Watched-channel automations can also return `NO_REPLY` when no response is useful, while
failures and runs with artifacts still post normally.

## July 30, 2026

**Choose GitHub, Google, or both for sign-in.** Deployments can now enable either provider
independently, and the sign-in page shows only the methods actually configured. Terraform validates
the setup. The GitHub App remains required for repository access in Google-only deployments.

## July 26, 2026

**Better Auth browser authentication.** Browser sign-in now uses control-plane-owned Better Auth
sessions with GitHub and optional Google providers. The web app forwards an exact allowlist of
authentication routes through a signed proxy, and browser resource requests require both that signed
web-service channel and the browser session. Legacy browser tokens are retired during migration, so
existing users must sign in again after upgrading.

Note: GitHub sign-in requires the GitHub App `Email addresses: Read-only` account permission —
without it the callback fails with a misleading `state_mismatch` error.

## July 24, 2026

**Claude Opus 5.** Adds `claude-opus-5` to the model picker and integrations, with adaptive thinking
and reasoning efforts from low through max.

## July 23, 2026

**Slack image attachments.** Attach PNG, JPEG, WebP, and GIF images to Slack direct messages, app
mentions, DM thread follow-ups, and channel follow-ups that mention the bot, and Open-Inspect
forwards them to the agent with the prompt. Images also survive repository-selection clarification,
and image-only requests are supported. Requires adding the Slack bot `files:read` scope and
reinstalling the app.

## July 20, 2026

**Delegated commit signing.** Agent commits are now SSH-signed by a single deployment-wide
Open-Inspect identity while the requesting user is preserved as the Git author. The private key
stays in the control plane and signs commit buffers remotely, so it never enters sandboxes,
environments, process memory, or provider snapshots.

## July 18, 2026

**Session diff viewer.** A new Changes panel in the session sidebar renders real Git patches —
committed, staged, unstaged, and untracked, including renames, binary files, and submodules — diffed
against each repository's immutable session-start commit, replacing the old inferred line-count
stats. Multi-repo sessions, unified and split views, and mobile are all supported, and the last
successful diff stays viewable after the sandbox stops.

## July 17, 2026

**E2B sandbox provider.** E2B joins Modal, Daytona, Vercel, and OpenComputer as a selectable sandbox
backend, with a resumable idle-pause lifecycle and a dedicated template-image build package.
Verified end-to-end including `*.e2b.app` preview URLs.

## July 16, 2026

**Image attachments in sessions.** Attach PNG, JPEG, WebP, and GIF images to a prompt by selecting,
pasting, or dragging them in, with inline preview and timeline rendering. Bytes are stored in R2 and
forwarded to the agent as prompt image parts.

**Generated media in Slack threads.** Slack completion replies now attach the agent's generated
images and MP4s directly to the thread, delivered through a durable Cloudflare Queue so posting is
no longer bound by the 30-second HTTP window. Requires adding the Slack bot `files:write` scope.

## July 14, 2026

**GitLab nested-namespace repositories.** Repositories with nested owner namespaces (GitLab group /
subgroup / project) now work end to end — repo selection, settings, secrets, bot configuration,
image builds, and control-plane routes — instead of being truncated at the first slash.

## July 13, 2026

**OpenCode runtime upgraded to 1.17.18.** The pinned OpenCode CLI and plugin move from 1.14.41 to
1.17.18 across every sandbox provider, clearing a long-standing pin that was held back by an
event-stream regression which could drop prompt events and leave sessions with no assistant output.
Newly built images run the current agent with reliable streaming.

## July 12, 2026

**Pull request outcome analytics.** A new pull-request analytics endpoint reports acceptance rate,
cost per merged PR, time-to-merge, open-PR inventory, and per-repository and per-source breakdowns —
the numbers you need to track a software factory's ROI.

**Linear improvements.** Starting an agent from a Linear issue now moves the issue into the team's
first "Started" workflow state once the prompt reaches a live sandbox (idempotent, and leaving
completed, canceled, and automation sessions untouched). Linear runtime calls also switch to 30-day
client-credentials tokens, so an installed Linear app no longer breaks and forces a reinstall when
its token expires.

## July 11, 2026

**Pull request lifecycle tracking.** Sessions now track the live status of their GitHub pull
requests — open, draft, merged, or closed — via webhooks plus read-through refresh. The sidebar and
session detail render GitHub-style colored PR-state icons and summaries such as "PR merged" or "3
PRs · 1 open", with a manual sync button and repo-aware "View PR" links.

## July 10, 2026

**Prebuilt sandbox images.** Open-Inspect can now prebuild and cache sandbox images per repository,
not just per environment, with every image build unified behind a single Modal endpoint, worker, and
rebuild cron across both scopes. The new-session picker annotates each target with its prebuild
state — prebuilt, building, failed, or off — so a warm image is visible right where sessions launch.

## July 9, 2026

**Environments.** Group repositories into named, reusable environments, each with its own scoped
secrets and integration settings. A new Settings › Environments tab manages them, and the unified
session picker lets you launch against a whole environment instead of a single repo. Slack, Linear,
the GitHub bot, and scheduled automations can all target an environment as a launch destination.

**GPT-5.6.** Adds GPT-5.6 Luna, Terra, and Sol to the model registry, picker, and Linear label
routing, and retires the older GPT-5.2 models.

## July 8, 2026

**Multi-repo sessions.** A single session can now span multiple repositories inside one sandbox:
every repo clones into a shared workspace, git identity and setup/start hooks run per repo, and the
agent can open one pull request per repository. Single-repo sessions are unchanged.

## July 4, 2026

**Multi-repo automations.** An automation can target up to 10 repositories, fanning out into one
session per repo — each with its own branch and pull request — on every firing. Invocation status
rolls up from the children, and a new invocation-history view shows past runs. The scheduler
launches the per-repo children through a bounded concurrent worker pool.

## July 2, 2026

**Repo-less sessions.** Start a session with no repository at all — a "No repository" option in the
composer (auto-selected when you have no accessible repos) plus backend support for repo-less child
sessions and nullable repository context through automations and the sandbox runtime.

**Custom domain for the web app.** Cloudflare web deployments can serve on a custom domain such as
`app.example.com` instead of the default `workers.dev` URL, via a new optional Terraform variable
that provisions the DNS record and edge certificate.

**Z.AI GLM 5.2.** Adds `zai-coding-plan/glm-5.2` as a selectable model; enable it by setting
`ZHIPU_API_KEY` under Settings › Secrets.

## June 27, 2026

**OpenComputer sandbox provider.** A new sandbox backend with a full REST-backed lifecycle (create,
fork, restore, resume, stop), a Terraform-built base snapshot, and a template image bundling
agent-browser, `gh`, `ttyd`, and `bun`, selectable from the web UI.

## June 26, 2026

**Slack watched-channel automations.** A new automation event source: messages posted in watched
Slack channels can auto-trigger coding sessions, with text-match, channel, and actor conditions,
per-automation hourly rate limits, per-thread concurrency guards, and results posted back into the
originating thread. Opt-in behind `SLACK_TRIGGERS_ENABLED`.

**Multi-email allowlist sign-in.** GitHub sign-in now checks all of a user's verified emails against
the configured email allowlists instead of only the primary one, unblocking users with private
(noreply) or multiple addresses. Operators must add the GitHub App "Email addresses: Read-only"
permission.

## June 21, 2026

**Automation templates gallery.** A new templates gallery lets you start an automation from eight
pre-built ideas — find bugs, add test coverage, review new PRs, investigate Sentry issues, weekly
dependency digests, triage failed CI, and more — instead of a blank form. Picking one pre-fills the
Create Automation form with its trigger, schedule or event, instructions, and model.

**GitHub organization sign-in.** A third access-control allowlist, `ALLOWED_GITHUB_ORGS`, lets
anyone with active membership in a configured GitHub org sign in, alongside the existing username
and email-domain allowlists. Requires the GitHub App `Members: Read-only` permission and the
`read:org` OAuth scope.

**Slack keyword routing rules.** Admins can configure keyword-to-repository routing rules in Slack
integration settings; a whole-word keyword match deterministically routes a message to that
repository before the LLM classifier ever runs. Fails open, so behavior is unchanged when no rules
are set.

## June 18, 2026

**Pre-built images for any default branch.** Repository image builds and the rebuild scheduler now
use each repository's actual default branch resolved from GitHub, instead of a hardcoded `main`, so
repos on `master` or any other branch finally get pre-built images and commit-based rebuild
detection.

**Configurable code-server and terminal ports.** Sandbox settings gain configurable code-server and
web-terminal ports (code-server across Modal, Vercel, and Daytona), and fix a bug that silently
dropped a user's own service running on the default port from the tunnel URL list.

**Configurable image-build timeout.** Repositories with long install or build steps can raise the
image-build ceiling with a per-repo timeout setting — up to an hour — instead of hitting a fixed
30-minute limit.

**Searchable Slack repository picker.** The Slack "which repository?" clarification now offers a
searchable picker over all repositories — previously capped at five, leaving the rest unreachable —
plus one-click ranked quick-picks from the classifier's top guesses.

## June 15, 2026

**Exact-email allowlist and provider-agnostic identity.** A new `ALLOWED_EMAILS` allowlist admits
named individuals by email — handy for letting specific people on a shared domain like gmail.com
sign in without opening the whole domain. Sign-in identity is also decoupled from source-control
credentials, so Google users are governed by the same verified-email access checks as everyone else.

## June 14, 2026

**New models.** Adds Claude Fable 5 (a new tier above Opus, with adaptive thinking), DeepSeek V4
Flash and V4 Pro, and the OpenCode Zen models GLM 5.1, Kimi K2.6, and Qwen3.7 Max. Each is opt-in
via the model picker and its provider API key.

## June 9, 2026

**Configurable sandbox CPU and memory.** Operators can reserve CPU cores and memory per sandbox —
globally or per repository — for heavier install, build, and test workloads, honored on both Modal
and Vercel.

**Self-healing for stuck sessions.** Sessions whose sandbox spawn is interrupted by a provider crash
or a mid-spawn redeploy no longer wedge permanently in "spawning" or "connecting"; a stale spawn is
treated as dead and re-triggering the session recovers it.

## June 7, 2026

**Vercel sandbox provider.** Vercel Sandbox joins the list of selectable sandbox backends, with
Terraform-managed base snapshots, provider-scoped repository images, and secured per-build callback
tokens.

**Claude Opus 4.8.** Adds `claude-opus-4-8` to the picker (enabled by default) and unlocks the
`xhigh` reasoning-effort level for both Opus 4.7 and 4.8 for long-horizon agentic work.

## June 1, 2026

**Child session introspection.** A parent agent can now read a child session's final result and its
paginated event trajectory through `get-task-status`, so it can act on what the child actually did.

## May 30, 2026

**Filter sessions by creator.** A new All / Mine toggle in the sidebar filters the session list to
just your own sessions, backed by a canonical provider-identity resolution API.

**Non-`main` Modal deployment environments.** Operators can deploy the Modal data plane into a
selectable, non-`main` Modal environment, with separate environment and endpoint wiring through
Terraform.

## May 28, 2026

**Brokered SCM git credentials.** Sandboxes now request short-lived git credentials on demand from a
control-plane broker instead of embedding a static token at spawn time. This fixes long-running and
revisited sessions that previously failed `git fetch` or `push` after the GitHub App token expired
(~1 hour), and stops baking clone tokens into fresh sandboxes.

**Auto-generated session titles.** Sessions are automatically named from the agent's generated title
after the first turn (unless you've named them manually), streamed live to the UI and extended to
Slack-created sessions.

**Provider dashboard links.** The session UI shows a clickable link to the underlying sandbox's
provider dashboard (for example, Modal), making stuck, slow, or failed sandboxes easier to debug.

## May 22, 2026

**Sandbox tunnel URLs.** Extra tunnel ports now expose their public URLs to processes inside the
sandbox via a `/workspace/.tunnels.env` file, so dev servers can self-discover their public URL for
CORS, base-URL, and OAuth-callback configuration. The entrypoint guarantees fresh, never-stale URLs
across snapshot restores.

**Target-branch automation condition.** GitHub event automations can be scoped to pull requests
targeting a specific branch — for example, running only on release-branch PRs — and the automation
form gains per-field descriptions.

**Child session limits.** Operators can cap how many child sessions an agent spawns — both
concurrent and total — globally or per repository.

## May 17, 2026

**Browser video recording.** Sandbox agents can record browser sessions to MP4 and upload them as
session media alongside screenshots, with in-app playback via cards, sidebar, and a lightbox, and
HTTP range streaming. `ffmpeg` is now bundled in the sandbox images.

**Live Slack activity status.** The Slack bot posts real-time agent activity into the thread — a
starting status and per-tool-call updates — so Slack users can see the agent is working.

## May 10, 2026

**Agent Slack notifications.** Agents can proactively post notifications to a Slack channel from
inside a sandbox through a new gated `slack-notify` tool, with an operator settings UI (global
master switch, mentions policy, per-repo override), spawn-time opt-in, and transcript rendering. Off
by default; channel access is delegated to the Slack bot's membership.

## May 7, 2026

**Whitelabel app name and icon.** Forks and self-hosters can rebrand the entire deployment through
Terraform variables, threading a custom name, logo, and favicon through the web UI, both bots, PR
footers, OAuth pages, and outbound User-Agent headers. Defaults preserve the existing Open-Inspect
branding.

## May 2, 2026

**GitHub-triggered automations.** A new GitHub trigger lets automations fire on pull requests,
issues, comments, and check suites, with an event-type selector and richer condition types — branch,
label, path pattern, actor, and check conclusion. Ships alongside a session archiving UI and sidebar
archive flow.

## April 29, 2026

**Archive sessions from the sidebar.** Archive any session directly from the sidebar with a
confirmation dialog (long-press on mobile); archived rows disappear immediately, and failures raise
an error toast.

**Claude Opus 4.7.** Adds Claude Opus 4.7 as a selectable model across the product.

## April 24, 2026

**Unified user model and cross-provider identity.** Canonical user accounts now link a person's
GitHub, Slack, and Linear identities by verified email. User IDs are threaded through session
creation, child spawns, automations, the scheduler, and token storage, powering per-user analytics
and display names and avatars in the UI.

**GPT-5.5.** Adds `openai/gpt-5.5` to the model registry, enabled by default, with configurable
reasoning effort.

## April 20, 2026

**Design system refresh.** A cross-app visual overhaul: semantic color tokens for warning, info, and
destructive states, a warmer brand palette, consistent typography and spacing, a shared error
banner, dark-mode fixes, and accessibility improvements.

**Access-control default hardening.** Sign-in now defaults to deny when both the user and email
allowlists are empty. Operators must set an allowlist or explicitly opt into an unsafe "allow all
users" flag, and production deploys hard-fail validation otherwise.

## April 18, 2026

**Analytics dashboard.** A new analytics page with a 7 / 14 / 30 / 90-day range selector, summary
metric cards, a sessions-over-time chart, a repository breakdown, and a sortable per-user usage
table, backed by new analytics API routes.

**MCP server management.** Configure Model Context Protocol servers — local (stdio/npx) or remote
HTTP — from Settings, scoped per repository or globally. Credentials are encrypted at rest in D1,
never returned by the API, and injected into agent sandboxes at spawn time.

## April 13, 2026

**Daytona sandbox backend.** Daytona is available as an alternative sandbox provider, with a direct
REST API integration and automated snapshot builds managed through Terraform.

**Browser-based web terminal.** Sandbox sessions now include a `ttyd`-powered terminal you can open
directly in the browser.

**Screenshot media pipeline.** Sandboxes can capture screenshots, streamed to the browser through
the worker over R2, with each session's cost shown in the web sidebar.

## March 28, 2026

**Trigger automations.** Automations can now be started by Sentry alerts or inbound webhooks — each
with its own secrets, encrypted at rest — not just on a schedule.

**GitLab provider.** GitLab repositories are supported alongside GitHub, with personal-access-token
authentication, clone-token support, and provider-aware SCM URLs.

**Google sign-in.** Google is available as an alternative sign-in provider alongside GitHub OAuth,
with the user and email-domain allowlists applied to it as well.

**Slack direct messages.** The Slack bot now handles direct messages, not just channel threads.

_Also:_ syntax highlighting with selectable code themes, the full IANA timezone list and
reasoning-effort controls for automations, and security hardening around untrusted content in
prompts and external artifact URLs.

## March 17, 2026

**VS Code in the browser.** Opt-in code-server integration brings a full VS Code editor into sandbox
sessions, with encrypted credentials and a settings UI.

**shadcn/ui component library.** The UI adopts shadcn/ui and Radix primitives across selects,
switches, inputs, buttons, and badges — the foundation for later design work.

**Global command palette.** A `Cmd+K` command palette with keyboard shortcuts lands across the app.

_Also:_ session rename from the header and sidebar, sidebar pagination for large session lists,
GitHub Enterprise Server support, and graceful PR-token fallback to the App token.

## March 6, 2026

**Automation engine.** Schedule background coding-agent runs with cron expressions and full IANA
timezone support, managed from a new web UI — the foundation the later trigger, template, and
multi-repo automation work builds on.

**GPT 5.4.** GPT 5.4 joins the supported model list.

_Also:_ GitHub webhook delivery deduplication, secrets propagation to the prebuild step, and a large
internal modularization of the session Durable Object.

## February 26, 2026

**Pre-built image registry.** Build and reuse per-repo sandbox images: a D1-backed registry, an
async Modal builder, a build-scheduler cron, and a web settings UI for managing images per
repository.

**Agent-spawned sub-sessions.** Agents can spawn child sessions, with status streamed back through
the bridge as they run.

**Branch selection.** Choose the target branch when creating a session; base and working branches
are shown separately in the session detail.

**Files Changed sidebar.** A live Files Changed panel, populated from tool-call events with
`apply_patch` support and per-file diff stats.

**Cloudflare Workers web deploy.** The web app can be deployed to Cloudflare Workers via OpenNext as
an alternative to Vercel.

**Microsoft Teams bot.** Initial Teams channel-thread support arrives as a community contribution.

## February 19, 2026

**GitHub bot.** Automated PR reviews on open, comment-driven actions, customizable review and action
prompts, caller gating, and `gh` CLI support inside the sandbox.

**Linear bot.** Turn Linear issues into coding sessions, with multi-repo label-based routing,
repository classification, and activity callbacks.

**Mobile responsive layout.** A sidebar overlay drawer, list/detail settings navigation, and iOS
Safari viewport fixes make the app usable on phones.

**New models.** Claude Opus 4.6 with adaptive thinking, the GPT 5.3 Codex Spark model, and OpenCode
Zen models with global enable/disable settings.

_Also:_ SWR data fetching with caching across the web client, batched WebSocket event replay, and
GitHub App installation-token caching.

## February 10, 2026

**Multi-provider models and reasoning effort.** Low / medium / high reasoning-effort controls land
across shared types, the control plane, the web UI, and the Slack bot.

**OpenAI models.** GPT 5.2, GPT 5.2 Codex, and GPT 5.3 Codex are supported, with a standardized
`anthropic/` prefix and backward-compatible normalization for all model IDs.

**Global secrets.** Define secrets once and have them merged into every sandbox at spawn time —
backend storage, API, and web UI.

_Also:_ LLM API keys configurable as repo secrets, centralized OpenAI Codex token refresh, and a
manual Create-PR fallback when auto-PR fails.

## February 3, 2026

**Repo-scoped secrets.** Store per-repository secrets in D1 with AES-256-GCM encryption, manage them
from a dedicated settings page, and have them injected into the sandbox environment at spawn time.

**Structured JSON logging.** Wide events and correlation IDs across the control plane, Modal
infrastructure, and Slack bot.

**D1 migration system.** A proper migration system replaces the single `schema.sql`, with session
index and repository metadata storage moved from KV to D1.

_Also:_ `.openinspect/setup.sh` repository setup support, an archived-chats section in settings, and
bridge-timeout hardening with an inactivity-based SSE timeout.

## January 20, 2026

**Initial release.** The first public release of Open-Inspect — a background coding-agent platform
built on three tiers:

- **Control plane** on Cloudflare Workers with Durable Objects, SQLite-backed session state,
  WebSocket streaming, and GitHub webhook signature verification.
- **Data plane** on Modal — sandboxed environments running OpenCode with snapshot-based hibernation
  and restore.
- **Web client** — a Next.js app with GitHub OAuth, real-time session streaming, a collapsible
  session sidebar, markdown rendering, and dark mode.

Also included: Terraform infrastructure-as-code, GitHub Actions CI/CD with automated deploys, a
Slack bot for creating sessions from chat, per-message model switching, PR creation with GitHub App
attribution, and sandbox lifecycle management with spawn deduplication.
