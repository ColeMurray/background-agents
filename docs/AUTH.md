# Authentication and Authorization

Open-Inspect uses authentication to establish who you are and workspace authorization to decide what
you can do. This is the canonical guide to security, resource access, and credential boundaries;
other guides summarize these rules for their audiences.

> **Important:** Open-Inspect is designed for a single trusted organization. A deployment is one
> workspace. The GitHub App installation bounds GitHub repository reach; GitLab uses a deployment
> PAT. Roles control which Open-Inspect features a person can use; teams and session visibility
> further limit access to resources. Neither is a replacement for source-control repository
> permissions.

---

## Signing In

A deployment can offer GitHub sign-in, Google sign-in, or both. The sign-in page shows only the
providers configured by the deployment operator.

Signing in has two stages:

1. Your identity provider verifies your identity and email address.
2. The additive union of deployment and workspace-managed admission rules determines whether you may
   join the workspace.

Admission can be limited by:

- GitHub username
- Verified email address
- Verified email domain
- Active membership in an allowed GitHub organization

Any matching rule admits the identity. Email rules use verified provider evidence, including
verified secondary GitHub emails; an exact domain does not include its subdomains. GitHub usernames
and organizations apply only to GitHub sign-in, and GitHub still requires a verified email even when
one of those rules matches. An organization match requires active membership.

These rules are checked when you sign in and on other operations that recheck eligibility, such as
internal GitHub account-info resolution. Removing someone from an allowlist or GitHub organization
does not end an ordinary existing browser session; an Administrator or Owner can suspend the member
when access must be revoked. See [Suspension](#suspension) for live-connection timing and
limitations.

Authentication does not make someone an Owner or Administrator. Every admitted user has exactly one
workspace role, and new users receive the Member role by default.

### Sign-In Allowlist

Active built-in Owners and Administrators manage rules at **Settings > Workspace access > Who can
sign in**. Custom roles, even with member-management permission, cannot read or edit this policy.
The policy covers browser sign-in and creation of new accounts through bot enrollment using the
evidence described below. The member directory, general bot invocation restrictions, integration
trigger restrictions, and resource authorization remain separate controls. Adding a rule itself
sends no invitation and creates no member.

The editor lists every rule as one plain-language line (for example, "Anyone with an @example.com
email"). Type an email, domain, or GitHub name into the single add field; the editor infers the rule
type and asks whether a bare name is a GitHub user or organization. Rules marked with a lock come
from the deployment; the lock tooltip names the source variable. Deployment rules come from
`ALLOWED_EMAILS`, `ALLOWED_EMAIL_DOMAINS`, `ALLOWED_USERS` (GitHub usernames), and
`ALLOWED_GITHUB_ORGS`, or the corresponding Terraform `allowed_*` inputs. They are read-only in the
UI. Settings rules are persisted in the global SQL store and survive deployments. Both sources are
combined with OR semantics: neither overwrites or subtracts from the other. Removing a settings copy
cannot narrow a deployment grant or negate an overlapping broad grant. Terraform changes cannot
remove a persisted settings grant.

Managed rules are normalized and deduplicated, with **50 total rules**, including at most **10
GitHub organizations**, and a **64-KiB** PUT request cap at both proxy and control plane. New
managed values use strict ASCII email, exact DNS domain (punycode for international domains), or
bare GitHub login syntax. Existing deployment syntax remains supported. The effective organization
growth check preserves large existing baselines and allows reductions/unrelated edits without adding
further over-limit fan-out. Saving performs syntax validation, not DNS or membership verification.

Review additions/removals before saving. Domain and organization rules admit matching people who are
not already members. The review warns about overlapping grants and existing sessions, but does not
enumerate all affected people or guarantee recovery-account reachability. Conflicts and unknown save
outcomes require an explicit reload and draft review, not automatic retry. Discard confirms; browser
unload warns about unsaved changes, but arbitrary in-app navigation is not blocked.

The deployment must still have a compatible baseline for every enabled provider; managed rules do
not satisfy Terraform's safety gates or rescue invalid runtime configuration. Keep an exact verified
recovery administrator email in `allowed_emails` / `ALLOWED_EMAILS`, with unsafe mode disabled.
Google requires email/domain rules; GitHub also supports username/organization rules. An empty
deployment baseline managed entirely through the UI is not supported.

`UNSAFE_ALLOW_ALL_USERS=true` only allows any otherwise valid identity when **all effective lists
are empty**. Nonempty managed or deployment rules keep it dormant. Whenever the flag is true, the
editor is read-only and the server rejects mutations. To enable secure editing, deploy a recovery
baseline and disable unsafe mode together, then verify that account's login/role.

Migration `0093_workspace_admission_policy.sql` seeds empty managed rules at revision zero. Owners
and Administrators can edit them as soon as the backend serves the settings routes. The frontend may
deploy independently first; missing backend routes show unavailable.

### Policy Safety and Audit

Management uses human-authorized `GET`/`PUT /settings/admission-policy` through the signed
`/api/settings/admission-policy` web proxy. PUT requires `If-Match` for the reviewed revision and
deployment fingerprint. Actor role/status and revision are checked in the mutation transaction;
required audit failure prevents the write. Applied writes advance revision; no-ops do not.
Environment fingerprints do not serialize concurrent deployment versions.

The new browser PUT route requires **exactly `Sec-Fetch-Site: same-origin`**. Missing, `same-site`,
`cross-site`, and `none` are rejected. It does not trust `Host` or forwarded-host headers and needs
no new environment variable. Responses are private/no-store.

The operation audit action is `workspace.admission_policy_updated`. Its metadata includes managed
`before`/`after`, `requested: { expectedRevision }`, current/result revision, and deployment hash,
not another full requested rule document. The 50-rule limit keeps normal before/after metadata under
30 KiB, about 3 MB for 100 such audit events before response overhead. Rule values include emails
and are visible to authorized `workspace.audit.read` holders.

Each admission evaluation reads the current SQL policy; cached auth runtimes do not cache managed
rules. An evaluation already holding an older snapshot may finish under it. A missing, malformed, or
unreadable policy fails admission closed even for a deployment-matching recovery account. There is
no environment-only or unsafe-mode fallback on database failure.

### Authentication Time Budgets

GitHub organization evaluation uses at most **four concurrent checks** under **one total 10-second
deadline**, including queued checks and response bodies. Any active membership can win without
waiting for earlier slow checks; four stalled requests can still occupy the pool until the deadline.
Earlier username/email/domain matches skip org calls. Adding org rules requests no new OAuth scopes
or `read:org`; the GitHub App flow uses App permissions and the user's token. Configure and approve
Organization Members read-only permission as needed; saving a rule does not validate those rights.

Browser OAuth callbacks have a **240-second** application proxy transport budget: GitHub verified
email pagination can consume roughly **200 seconds** (10 pages, up to two 10-second attempts per
page), plus organization checks, token exchange, and persistence. The Next.js auth route declares
**`maxDuration = 300` seconds**; ordinary resource/non-callback transport retains its **15-second**
default. Hosting platform/function and ingress caps still apply and can end requests earlier.
Provider token exchange currently has no explicit bound inside the auth library; the proxy bounds
its own wait, not guaranteed cancellation of provider work. These settings are not evidence of
successful real-provider or hosting validation; verify them in the target deployment.

### Bot enrollment

Creating a new user through a bot also requires admission against the effective union of deployment
and SQL-managed rules. Slack and Linear must provide an attested email matching an effective exact
email or domain rule: `ALLOWED_EMAILS` / `ALLOWED_EMAIL_DOMAINS` plus their settings-managed
counterparts. New-account admission reads the current managed policy; an unreadable or malformed
policy fails closed, not back to deployment-only rules. Unsafe allow-all applies only when all four
effective lists across both sources are empty. It does not waive Slack/Linear's attested-email
requirement.

Bots cannot prove GitHub username or organization rules; people admitted by those rules must sign in
on the web first and use the matching account email in Slack or Linear. GitHub bot profile emails
are not verified admission evidence and cannot be used to link an unknown actor by email. GitHub
actors must already be known unless unsafe allow-all is effective; a GitHub username or organization
rule cannot enroll an unknown GitHub bot actor.

Known actors and actors linking to an existing account by attested email keep that account's role
and suspension without repeating admission. A denied new enrollment creates no account or role.
Newly admitted users still receive Member. New Slack and Linear actors without an attested email
cannot enroll, including Slack Connect users whose emails the bot cannot read, even in unsafe mode.
Removing a rule does not revoke existing bot accounts or turn each bot invocation into a new
admission check. Suspension, role permissions, service operation limits, and integration ingress
restrictions still apply; linking to an existing account cannot bypass them.

Admission does not establish that two different emails belong to the same person. If both emails
pass admission, separate accounts can still be created; use the member merge tool to consolidate
them. Suspend each account when revoking access.

## Workspace Roles

Open-Inspect includes four built-in roles.

| Capability                                        | Owner | Administrator | Member | Viewer |
| ------------------------------------------------- | :---: | :-----------: | :----: | :----: |
| View repositories and environments                |  Yes  |      Yes      |  Yes   |  Yes   |
| Use repositories and environments in sessions     |  Yes  |      Yes      |  Yes   |   No   |
| Manage shared settings, integrations, and secrets |  Yes  |      Yes      |   No   |   No   |
| Create sessions                                   |  Yes  |      Yes      |  Yes   |   No   |
| View sessions allowed by visibility               |  Yes  |      Yes      |  Yes   |  Yes   |
| Collaborate in and manage permitted sessions      |  Yes  |      Yes      |  Yes   |   No   |
| View automations                                  |  Yes  |      Yes      |  Yes   |  Yes   |
| Create automations                                |  Yes  |      Yes      |  Yes   |   No   |
| Manage and trigger own automations                |  Yes  |      Yes      |  Yes   |   No   |
| Manage and trigger any automation                 |  Yes  |      Yes      |   No   |   No   |
| View workspace members                            |  Yes  |      Yes      |   No   |   No   |
| Manage workspace members                          |  Yes  |      Yes      |   No   |   No   |
| Merge duplicate member accounts                   |  Yes  |      Yes      |   No   |   No   |
| Transfer workspace ownership                      |  Yes  |      No       |   No   |   No   |
| View analytics                                    |  Yes  |      Yes      |  Yes   |  Yes   |
| View provider accounts                            |  Yes  |      Yes      |  Yes   |   No   |
| View image-build history                          |  Yes  |      Yes      |  Yes   |  Yes   |
| Manage personal skill profiles                    |  Yes  |      Yes      |  Yes   |   No   |

These are workspace feature permissions, not unconditional resource access. Team membership, lead
authority, ownership, and session visibility add the checks described below.

### Owner

Owners administer the workspace but do not automatically collaborate in other people's private
sessions. Only Owners can grant or remove the Owner role or suspend and restore another Owner.
Open-Inspect also prevents the final active Owner from being suspended or demoted, so the workspace
cannot accidentally lose all ownership.

### Administrator

Administrators can operate the workspace day to day. They can manage members, permitted sessions,
automations, repositories, environments, provider accounts, integrations, and secrets. They cannot
access another person's private session unless added as a collaborator. They cannot transfer
ownership, change who holds the Owner role, or suspend and restore an Owner.

### Member

Members can create and use sessions, collaborate in sessions they can access, use shared
repositories and environments, and create, manage, and manually trigger automations they execute.
Team leads can also manage their team's membership, grants, secrets, and automations; leading a team
does not grant workspace-wide configuration permissions. Members can view workspace analytics.

### Viewer

Viewers have read-only access to shared workspace resources. They can inspect sessions visible to
them, automations, analytics, repositories, environments, skills, and MCP servers. They cannot
create or prompt sessions, access sandboxes, manage personal skill profiles, trigger automations, or
change shared configuration.

## Teams and Session Visibility

Teams are optional. A team has members and leads, an open or invite-only join policy, and a default
session visibility (`team` or `workspace`). Owners and Administrators create teams in **Settings >
Teams**, and the creator becomes the first lead. Existing and teamless sessions stay workspace-owned
(`ownerTeamId: null`); creating a team does not move them. Team membership does not replace the
workspace role: a person still needs the relevant workspace permission.

Any active workspace user can join an open team; invite-only teams require a lead or workspace
Owner/Administrator to add members. Leads and workspace Owners/Administrators manage membership,
lead roles, team metadata, and archive/restore. Members can leave with **Remove** on their own
membership row. The last lead cannot leave, be removed, or be demoted.

### Team Directory and Pages

Every active workspace user can list active teams and their members. Archived teams are visible only
to their members and workspace Owners and Administrators. Email addresses in the team directory and
collaborator picker are shown only to viewers with `workspace.members.read`.

A team's session overview is available to its members and workspace Owners and Administrators, still
subject to session visibility. Team tabs appear according to the viewer's capabilities. Team
operations are recorded in the workspace audit log, which `workspace.audit.read` holders can filter
by any team. Sidebar team selections only narrow which readable sessions are listed. The new-session
composer's team and visibility, by contrast, set the created session's ownership and audience.

### Session Visibility

Each session stores a visibility independently of its owning team, so a team-owned session can be
team-visible, workspace-visible, or explicitly private.

| Visibility  | Who can read the session when team enforcement is on                                           |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `workspace` | Workspace users with session read permission, even if the session has a team.                  |
| `team`      | Members of the owning team, plus workspace Owners and Administrators. Requires an owning team. |
| `private`   | The session owner and explicit collaborators, plus audited Owner break-glass reads by ID.      |

All rows also require session read permission.

- **Private sessions are enforced in every mode.** An Owner's break-glass read is audited, does not
  list the session, and does not grant prompt or sandbox access unless the Owner becomes a
  collaborator. With the relevant permissions, the Owner can still manage the session's lifecycle,
  deletion, collaborators, and visibility (with owning-team membership if it is team-owned).
  Administrators have no break-glass exception, and actorless bot services cannot read private
  sessions.
- **Team-owned sessions require current team membership for every non-read action** in every mode,
  including for session owners, team leads, Owners, and Administrators. Visibility grants reads
  only. The one exception is a collaborator removing themselves, which needs only read access.
- **Collaborators** are a private-session access grant, not a team membership or role change. Only
  the session owner or a workspace Owner can add or remove other collaborators. On a team-owned
  session, collaborators must be current team members (others are rejected with `not_team_member`),
  and leaving the team ends their access.
- **Session owners and participants differ.** A session's owner is its creator, not its team, and
  can read it even when private (with session read permission). Runtime participants and the
  **Mine** filter are attribution and discovery only; they do not grant or limit access.

Each action also needs its own permission: prompting needs collaboration, sandbox use needs sandbox
access, and lifecycle operations need lifecycle permission. Deleting a team-owned session, or any
session when enforcement is `on`, also requires session ownership, owning-team lead status, or a
workspace Owner/Administrator role. Only the session owner or a workspace Owner can change private
visibility. Leading a team does not grant access to its private sessions.

### Personal Memory in Sessions

Session access and personal memory are separate. However many people can read or prompt a session,
its owner's personal memories serve only the owner's own prompts. On anyone else's prompt the agent
cannot search, read, or save them, and once anyone else has prompted the session, personal memory
search stays off there and in its children for good, because that prompt can leave something running
in the sandbox. The session's memory sidebar lists personal items only for the owner. New automation
runs, manual ones included, and new sessions started from Slack channels, Linear, or GitHub don't
include personal memory. Sessions started earlier keep what they pinned but no longer read it live.
Sessions also leave personal memory out while its owner lacks `memories.manage_own`.

Two things still reach beyond the owner's prompts. The personal directives and catalog pinned when
the session started shape every prompt, whoever wrote it, though they give no one else's prompt live
access to the personal store. Agent replies built from personal memory remain visible to everyone
who can read the session. Sandbox access is trusted like the session's other credentials: anyone who
can open its terminal, editor, or desktop can do what its agent can, including reaching the owner's
personal memories while the owner's prompts run. See
[Personal memory follows the owner's prompts](MEMORY.md#personal-memory-follows-the-owners-prompts).

### Team Defaults and Migration

A team's default visibility accepts only `team` or `workspace` and sets the audience of new
sessions, not their ownership. `private` remains an explicit per-session choice. Migration `0085`
changes existing private team defaults to `team` without changing existing sessions, and adds
triggers that reject private defaults. **Apply migration `0085` before deploying the matching
application code**; otherwise existing private defaults can fail validation.

### Creating Sessions

Creating a team session requires active membership in that team and a grant covering **every**
session repository; archived teams cannot be selected. Without an explicit visibility, sessions from
any launch source (including Slack, Linear, and automations) use the owning team's current default,
and teamless sessions use `workspace`. `team` visibility requires a team. Agent-spawned children of
a team-owned session require the active prompt author to still be a team member and fail with
`not_member` otherwise; they never borrow the parent owner's membership.

**Settings > Teams > Require a team for new sessions** (`requireTeamOnCreate`, off by default)
requires a team for new sessions, environments, and automations, including bot-created sessions.
Requests without one fail with `team_required`. Existing workspace-owned resources are unaffected,
and existing workspace-owned automations still run and create workspace-owned sessions.

Team leads and workspace Owners/Administrators manage repository grants in the team's Repositories
tab. A team has either installation-wide access or named grants by repository ID, and no grants by
default. Repository-backed team sessions without covering grants fail with
`target_team_missing_grant`; repository-less team sessions need no grants. Removing a grant narrows
future GitHub sandbox credentials but does not revoke issued tokens; GitLab's deployment PAT is
never narrowed.

Repository skills, secrets, and image builds remain workspace-level resources. Once any team grants
a repository, using them requires membership in an active granting team (lead for repository
secrets) or a workspace Owner/Administrator role, in every enforcement mode. An installation-wide
grant counts as granting every repository.

### Environment Access

Team-owned environments require owning-team membership or a workspace Owner/Administrator role to
read or use. Managing any environment, including its secrets, settings, and images, requires
`environments.manage` in addition to the specific feature permission, plus lead status or a
workspace Owner/Administrator role for team-owned environments. Manual image builds also require the
owning team's grants to cover every repository. Environment names are unique within their owning
team or the workspace.

A team environment can launch only into sessions owned by the same team. A team's session catalog
can also include workspace environments whose repositories its grants cover. These checks apply in
every `TEAMS_ENFORCEMENT` mode.

### Ownership and Discovery

Sessions, automations, and environments cannot move between teams or between a team and the
workspace. Changing a team session's visibility to `workspace` changes who can read it, not its
ownership or the membership required to act on it. Visibility changes that include child sessions
refuse the whole request if any child is inaccessible.

Session lists and filters (`ownerFilter`, `visibility`, `teamIds[]`, `scope`) only narrow the
sessions a user can already read. `scope=workspace` means teamless sessions, not workspace
visibility. `scope=all` is reserved for Owners and Administrators and does not list break-glass-only
private sessions.

### Enforcement and Access Paths

Operators set `TEAMS_ENFORCEMENT` to `off`, `shadow` (the default), or `on`. `off` keeps legacy read
access to non-private sessions and legacy actions on non-private workspace-owned sessions; `shadow`
does the same while auditing would-be denials; `on` enforces team visibility and action rules.
Terraform exposes this as `teams_enforcement`, resolved in CI from the repository variable, then the
same-named secret, then `shadow`. The AWS configuration sets `shadow` in its `config` map; change
`TEAMS_ENFORCEMENT` there instead. Deploying Teams alone does not enable `on`.

No mode relaxes private-session access, current membership for team-owned actions, checks on
visibility and collaborator changes, or environment, automation, repository-grant, and team-secret
checks.

Session access is enforced on four paths:

- **HTTP item routes** authorize against the stored session and return a non-enumerating `404` for
  hidden sessions.
- **Lists and aggregates**, including search, inbox, bulk export, and analytics, filter by
  visibility before returning results. Administrative analytics can include an unattributed total
  cost of private sessions without exposing the sessions.
- **Durable Object connections** recheck subscriptions and commands against the current session.
- **Sandbox access** is a separate action; being able to read a session does not grant its sandbox.

New HTTP requests reflect role, membership, collaborator, and visibility changes immediately. Live
browser connections are rechecked at least every five minutes, so one may remain open for up to five
minutes after access changes.

### Reviewing Shadow Denials

Before switching `TEAMS_ENFORCEMENT` from `shadow` to `on`, review the requests `on` would have
denied. Shadow records are observation only and are written only in `shadow` mode:

- HTTP item routes record `authorization.request_allowed` with `shadow_denied:<reason>`.
- Session lists, inbox reads, child lists, and bulk exports record one `shadow_denied:batch` row per
  request, with the hidden-row count in `metadata_json.shadowDenialCount`.
- WebSocket reads record `session.shadow_denied` at most once per connection, session, and reason.

Analytics aggregates are not observed, and audit writes are best effort. In the audit log, WebSocket
records show **Would deny**; HTTP records show **Allowed** with a `shadow_denied:*` reason. For
daily counts by path and reason, run this query against the D1 `authorization_audit_events` table,
replacing the start date with your shadow rollout date:

```sql
WITH shadow AS (
  SELECT id, date(occurred_at / 1000, 'unixepoch') AS day,
         CASE WHEN action = 'session.shadow_denied' THEN 'websocket'
              WHEN reason_code = 'shadow_denied:batch'
                   AND json_extract(metadata_json, '$.httpMethod') = 'GET'
                THEN 'http_list'
              ELSE 'http_item' END AS seam,
         reason_code, metadata_json
  FROM authorization_audit_events
  WHERE occurred_at >= unixepoch('2026-10-01') * 1000
    AND reason_code LIKE 'shadow_denied:%'
    AND action IN ('authorization.request_allowed', 'session.shadow_denied')
), reasons AS (
  SELECT id, day, seam, substr(reason_code, 15) AS reason
  FROM shadow WHERE reason_code != 'shadow_denied:batch'
  UNION
  SELECT id, day, seam, json_extract(metadata_json, '$.shadowDenialReason') AS reason
  FROM shadow
  WHERE reason_code = 'shadow_denied:batch'
    AND json_extract(metadata_json, '$.shadowDenialReason') IS NOT NULL
  UNION
  SELECT s.id, s.day, s.seam, json_extract(d.value, '$.reason') AS reason
  FROM shadow s, json_each(s.metadata_json, '$.shadowDenials') d
  WHERE s.reason_code = 'shadow_denied:batch'
  UNION
  SELECT id, day, 'http_item', json_extract(metadata_json, '$.shadowReason')
  FROM shadow
  WHERE reason_code = 'shadow_denied:batch'
    AND json_extract(metadata_json, '$.shadowReason') IS NOT NULL
)
SELECT day, seam, reason, COUNT(*) AS would_be_denied_requests
FROM reasons
GROUP BY day, seam, reason
ORDER BY day, seam, reason;
```

`not_member` results cover any viewer outside the owning team, including users who belong to no
team. Counts are affected requests or WebSocket connections, not hidden sessions or unique users.

## How Automation Access Works

Automations have a fixed owning team (or workspace ownership) and a separate executor, initially the
creator. Reading a team automation requires team membership or a workspace Owner/Administrator role
in every enforcement mode. Creating any automation requires both `automations.create` and
`sessions.create`.

- Executors and owning-team leads can manage and trigger eligible automations with the `own`
  permissions; `any` permissions extend this to all eligible automations.
- Administrators and Owners can manage and manually trigger any automation, but manually running a
  team automation still requires membership in its owning team.
- Viewers can inspect eligible automations but cannot create, change, or run them.

Team leads and workspace Owners/Administrators can reassign the executor to another authorized user;
reassignment is audited. See [executor reassignment](AUTOMATIONS.md#executor-reassignment). Reading
an automation does not grant access to its sessions, and run history redacts sessions the viewer
cannot read.

### Scheduled and Event Runs

Scheduled and event-driven runs execute under the executor's authority. At run time, the executor
must still be active and allowed to create sessions and use the selected targets. Team runs also
require current team membership and grants covering their repositories, and their sessions use the
team's default visibility; workspace automations create workspace-visible sessions. If authorization
fails, the run does not start.

### Manual Runs

A manual run executes under the authority of the person who clicked **Run**, even when an
Administrator or Owner triggers someone else's automation. The requester must be allowed both to
trigger that automation and to create the resulting session with its selected resources. Their
identity and linked source-control credentials are used for that run.

See [Automations](AUTOMATIONS.md) for trigger setup and run behavior.

## Bots and Integrations

Slack, GitHub, and Linear integrations act on behalf of a workspace user when they handle a user
request. Their effective access is limited by both:

- The acting user's current role
- The integration's fixed set of allowed operations

This means an integration cannot bypass a suspended user or perform workspace administration simply
because the acting user is an Owner. Calls that do not identify an acting user are denied unless a
specific integration route explicitly permits that operation.

Some integrations also apply their own ingress rules. For example, the GitHub integration may
require an allowed trigger user or sufficient repository collaborator access before it sends a
request to Open-Inspect.

### Slack and Linear Bindings

Team leads and workspace Owners/Administrators bind Slack channels and Linear teams in **Teams >
Channels**, so requests from them create sessions owned by that team. Each channel or Linear team
belongs to at most one Open-Inspect team. Bindings do not add members or grants, and changing one
does not reassign existing sessions. Each integration's `unboundChannels` setting in **Settings >
Integrations** either creates workspace sessions from unbound channels (`workspace`, the default) or
rejects them (`reject`).

In every enforcement mode, actorless bot reads scoped to an unbound channel or Linear team see only
workspace-owned, non-private sessions, so unbinding immediately revokes access to that team's
sessions. Slack never posts private sessions, even when the acting user can read them, or posts
team-owned sessions to a channel not bound to that team; confirmed publication denials close the
thread without session content, while a follow-up refused for one user does not close it for others.
Linear withholds completion results if the issue has moved to another Linear team. Its actorless
reads, including completion reads, otherwise follow `TEAMS_ENFORCEMENT`: full Team-visibility
isolation requires `on`. See [Slack](integrations/SLACK.md) and [Linear](integrations/LINEAR.md).

### GitHub Routing

GitHub routes by numeric repository ID rather than channel bindings. Event automations run as their
executor for their owning team, which must still hold a grant for the repository. Mentions use the
linked PR session's team, then a team of the sender that holds a grant (broken by their most recent
session when several qualify), then workspace ownership when neither resolves. Routing never
bypasses session-creation checks or the require-team policy. Deprecated auto-review-on-open remains
workspace-owned; use a team-owned GitHub Event automation instead. See
[GitHub](integrations/GITHUB.md), including
[upgrade steps](integrations/GITHUB.md#upgrading-to-repository-id-routing) for existing deployments.

## Suspension

Suspending a member disables their workspace access without deleting their account or historical
attribution.

After suspension:

- New browser and bot operations are denied.
- Existing browser sign-in sessions are invalidated.
- Live browser session connections close within five minutes.
- Scheduled and event-driven automations using the member as executor no longer pass run
  authorization.
- Existing session history and authorship remain intact.

Suspension does not automatically stop a sandbox that is already executing. A user with the required
session action access can manage it separately; Administrators and Owners still need owning-team
membership for team-owned session actions.

## Repository and Credential Boundaries

Open-Inspect uses a shared GitHub App installation for GitHub clone, fetch, and push operations. The
App should be installed only on repositories intended for the workspace. GitHub sandbox tokens cover
only the session's repositories, further limited to the owning team's grants for team-owned
sessions. Private submodules, dependencies, and sibling clones must be included in the session
before it starts. Unresolvable repositories fail closed rather than falling back to
installation-wide access.

Removing a grant does not revoke tokens already issued; they remain valid until expiry. GitLab uses
a deployment-wide PAT that is not scoped per session. Teams do not establish multi-tenant isolation.
See [Sandbox Repository Access](GETTING_STARTED.md#sandbox-repository-access).

### Credential Delivery and Snapshots

Sandboxes fetch git credentials on demand from the control plane through the `oi-git-credentials`
helper, rather than receiving a clone token at launch. The helper caches the credential on disk
(mode `0600`) until shortly before expiry, and a cached credential can be used without a new
authorization check.

Modal snapshots capture the full sandbox filesystem without clearing that cache, so a snapshot can
contain and restore cached tokens, along with any credentials written by setup scripts or the agent.
On GitLab the cached credential is the deployment-wide PAT, which stays valid beyond the cache
lifetime. Treat snapshots as sensitive artifacts.

Image builds receive `VCS_CLONE_TOKEN` instead, scoped on GitHub to the repository or the
environment's repositories (intersected with the owning team's grants); GitLab builds receive the
deployment PAT. Files written during a build can persist in prebuilt images; see
[Secrets and Prebuilt Images](SECRETS.md#secrets-and-prebuilt-images).

### User Credentials and Secrets

A user's role determines whether they may read or use workspace repositories, but Open-Inspect does
not compare that role with the user's personal GitHub access for each repository. Linked GitHub
credentials can be used for actions such as attributed pull-request creation; when no suitable user
credential is available, supported operations may use the shared App identity.

Secrets and provider credentials are not made visible through role-based read access. Administrative
permissions control who can configure them, and saved secret values are not returned to the browser.
See [Secrets Management](SECRETS.md) for details.

## Workspace Administration

Owners and Administrators can manage members from **Settings > Workspace access**. Depending on
their own role, they can:

- Review workspace members and assigned roles
- Change a member's role
- Suspend or restore a member
- Manage additive sign-in allowlist rules separately from existing members

Only an Owner can assign or remove the Owner role or suspend and restore another Owner. The final
active Owner cannot be suspended or demoted.

### Initial Owner Setup

The first person who signs in receives the default Member role and is not promoted to Owner
automatically. On a new deployment, the intended Owner must sign in once, after which a deployment
operator runs the Owner bootstrap command using that person's Open-Inspect user ID. See
[Getting Started](GETTING_STARTED.md#step-9-bootstrap-the-workspace-owner) for the deployment steps.

From a repository checkout with Node.js 24+, select exactly one database target. D1 commands use
remote Wrangler credentials (`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` or `wrangler login`).
SQLite commands require an existing global database file; they never create one. The canonical user
ID is 32 lowercase hexadecimal characters, not an email address or GitHub login.

```bash
# Remote D1: preview, execute after review, then verify no-op.
node scripts/bootstrap-workspace-owner.ts --database <D1-name> --user <canonical-user-id>
node scripts/bootstrap-workspace-owner.ts --database <D1-name> --user <canonical-user-id> --execute
node scripts/bootstrap-workspace-owner.ts --database <D1-name> --user <canonical-user-id>

# SQLite alternative: preview, then execute after review.
node scripts/bootstrap-workspace-owner.ts --sqlite /path/to/existing/global.db --user <canonical-user-id>
node scripts/bootstrap-workspace-owner.ts --sqlite /path/to/existing/global.db --user <canonical-user-id> --execute
```

Bootstrap refuses suspended/nonexistent targets or another active Owner. It does not bypass normal
ownership administration or suspension. Its result-bearing SQL runner uses
`wrangler d1 execute --remote --command ... --json` for remote D1 rather than file import; SQLite
writes use `BEGIN IMMEDIATE`. Mutation and audit proof are performed together.

### Rollback and Recovery

Rolling back to old code that ignores managed rules drops every managed grant. Before such a
rollback, stop concurrent deployments, baseline edits, and Settings policy edits, and
disable/control automated rollback. Nothing locks the editor or deployment configuration for you.

While still on new code, reload Settings, discard any unsaved draft, and copy the managed rules;
protect the copy as sensitive data. If Settings is unavailable, a signed-in Owner or Administrator
can open `/api/settings/admission-policy` on the web app for the same snapshot, or you can read the
rules from the database:

```bash
npx wrangler d1 execute <D1-name> --remote --json \
  --command "SELECT revision, rules_json FROM workspace_admission_policy WHERE id = 1"
```

Both direct reads report the policy `revision`; record it with the copy. The copy does not include
the deployment baseline: separately retrieve the actual serving baseline, normalize and union each
list with the managed rules, and deploy that complete union with unsafe mode false. Verify the
deployed union, provider compatibility, and intended login eligibility. Immediately before old-code
rollback, reload Settings (or repeat the direct read) and confirm the managed rules, any recorded
revision, and the deployed union are unchanged. Stop if anything drifted.

Only after those checks should old code serve traffic. Retain the policy table and audit history. A
frontend-only rollback leaves backend enforcement intact; restore a compatible editor to change
managed rules.

For a policy mistake, deploy a known valid recovery email in the baseline with unsafe mode false,
then verify login and active administrative role. A corrupted/unavailable policy needs database
repair or restore first. Do not delete the singleton or enable allow-all as recovery. Baseline
copies added for rollback remain until deliberately removed by a later reviewed deployment.

See [container operations](CONTROL_PLANE_CONTAINER.md#sign-in-allowlist-operations) for access to
the actual SQLite volume. These procedures are not claims that rollout or live-provider verification
has already been completed.

## Related Guides

- [Getting Started](GETTING_STARTED.md)
- [Automations](AUTOMATIONS.md)
- [Secrets Management](SECRETS.md)
- [How Open-Inspect Works](HOW_IT_WORKS.md)
