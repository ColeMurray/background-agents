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
2. The deployment's admission rules determine whether you may join the workspace.

Depending on the deployment configuration, admission can be limited by:

- GitHub username
- Verified email address
- Verified email domain
- Active membership in an allowed GitHub organization

These rules are checked when you sign in. Removing someone from an allowlist or GitHub organization
does not end an existing browser session; an Administrator or Owner can suspend the member when
access must be revoked immediately.

Authentication does not make someone an Owner or Administrator. Every admitted user has exactly one
workspace role, and new users receive the Member role by default.

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

Only an Owner can assign or remove the Owner role or suspend and restore another Owner. The final
active Owner cannot be suspended or demoted.

### Initial Owner Setup

The first person who signs in receives the default Member role and is not promoted to Owner
automatically. On a new deployment, the intended Owner must sign in once, after which a deployment
operator runs the Owner bootstrap command using that person's Open-Inspect user ID. See
[Getting Started](GETTING_STARTED.md#step-9-bootstrap-the-workspace-owner) for the deployment steps.

## Related Guides

- [Getting Started](GETTING_STARTED.md)
- [Automations](AUTOMATIONS.md)
- [Secrets Management](SECRETS.md)
- [How Open-Inspect Works](HOW_IT_WORKS.md)
