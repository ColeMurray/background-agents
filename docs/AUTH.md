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

Members can create and use sessions, collaborate in sessions visible to them (with current
owning-team membership for team-owned sessions, and private-session participation), use shared
repositories and environments, and create automations. They can manage and manually trigger
automations they execute and, as team leads, other automations owned by their team, subject to
workspace permissions. Team leads can also manage team membership, grants, and secrets; leading a
team does not grant workspace-wide configuration permissions. Members can view workspace analytics.

### Viewer

Viewers have read-only access to shared workspace resources. They can inspect sessions visible to
them, automations, analytics, repositories, environments, skills, and MCP servers. They cannot
create or prompt sessions, access sandboxes, manage personal skill profiles, trigger automations, or
change shared configuration.

## Teams and Session Visibility

Teams are optional within a workspace. Existing and teamless sessions remain workspace rows with
`ownerTeamId: null`; creating a team does not move them into it. A team has members and leads, a
join policy (open or invite-only), and a default session visibility. Owners and Administrators can
create teams in **Settings > Teams**; the creator becomes the first lead. Team membership does not
replace the workspace role: a person still needs the relevant session permission in addition to any
team access.

Open teams allow active workspace users to join; invite-only teams require a lead or workspace
Owner/Administrator to add members. Leads and workspace Owners/Administrators can manage membership,
lead/member roles, team metadata, and archive/restore. The last lead cannot leave, be removed, or be
demoted: appoint another lead first. Members can leave using **Remove** on their own membership row
in the team's Members tab or Settings detail, or through `DELETE /teams/:id/members/:userId` using
their own user ID, subject to the same last-lead restriction.

### Team Directory and Pages

Every active workspace user can list active teams and read their member lists, even without
membership in those teams. The team directory supports search and favorites, and team pages show
team metadata and members. Archived teams and their member lists are available only to their members
and workspace Owners and Administrators.

The team directory and the session collaborator picker identify people by display name and avatar.
Email addresses are included only for viewers with `workspace.members.read` (Owners and
Administrators in the built-in roles); all other viewers receive `email: null`, including team leads
and session owners. An unnamed user is labeled with a short user ID suffix instead of an email
address or full ID. This privacy rule applies in every team enforcement mode.

A team's session overview is available to its members and workspace Owners and Administrators, with
session visibility checks applied on the server. Team pages also expose Repositories, Environments,
Automations, Secrets, Channels, and Settings according to the viewer's capabilities and feature
permissions. Team pages do not expose an audit activity feed. Team operations are still recorded in
the workspace audit log behind `workspace.audit.read`; its team filter includes teams the reader
does not belong to.

The sidebar context defaults to **All my teams**, which leaves session lists unfiltered by team
while preserving server visibility checks. Users with at least one active team can choose Workspace
(teamless rows), a team, or All my teams; Owners and Administrators can also choose All teams. Users
without active teams have no selector and keep unfiltered lists. A stored Workspace or active-team
choice is retained; unknown or archived selections fall back to All my teams.

The new-session composer's team and visibility are independent of the sidebar and command-menu
recents. Explicit choices are saved in user-scoped localStorage and restored while the sidebar
context matches; changing sidebar context clears that saved choice. Without a matching saved draft,
the composer initializes from the sidebar context. If a team is required and the context does not
name one, it selects the user's first active team locally. Changing teams within the composer
preserves the selected audience when valid; it does not apply the new team's default automatically.

### Session Visibility

Each session stores a visibility independently of its owning team. Ownership and audience are
different: a team-owned session can be team-visible, workspace-visible, or explicitly private.

| Visibility  | Who can read the session when team enforcement is on                                                                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace` | Workspace users with session read permission, even if the session has a team.                                                                                                                                                                                    |
| `team`      | Members of the owning team, plus workspace Owners and Administrators, with session read permission. Requires an owning team.                                                                                                                                     |
| `private`   | The session owner and explicit collaborators (who must be current owning-team members on team-owned sessions) with session read permission. A workspace Owner can also open it by ID under audited break-glass access; Administrators do not get this exception. |

Private visibility is enforced in every enforcement mode. An Owner's break-glass read is audited,
does not cause the session to appear in their lists, and does not grant prompt or sandbox access. An
Owner with the required lifecycle or delete permission can manage a private session they opened by
ID, but must also be a current member of the owning team if the session is team-owned; being an
Administrator alone does not grant access. Actorless bot services cannot read private sessions;
user-backed integration requests still depend on the acting user's access.

For a team-owned session, **every non-read action requires current membership in the owning team**
in `off`, `shadow`, and `on` modes. Session owners, team leads, workspace Owners, and Administrators
are not exempt. This includes prompting, sandbox access, lifecycle operations, deletion, visibility
changes, and collaborator management, in addition to the relevant workspace permissions and
action-specific rules. Visibility still controls read access: a readable workspace-visible session
or an explicit private-session collaborator grant does not grant team membership or authorize
non-read actions. The sole exception is a collaborator removing themselves, which requires only
session read access.

Owners and Administrators must join the owning team before acting on its sessions; team membership
changes are audited.

The **Mine** filter helps find sessions you created but does not define who may access them. A
session's owner is its creating workspace user, not its team. Explicit collaborators are an access
grant for private sessions; they still need the relevant workspace permission to read, prompt, or
use the sandbox. Runtime participants record who connected or contributed and may carry runtime
credentials; being a participant alone is not a visibility grant. Conversely, making someone a
collaborator does not turn them into a runtime participant. Removing a collaborator revokes their
private-session access on subsequent authorization checks. Adding collaborators or removing someone
else requires `manageCollaborators`: after the session read check, only the session owner or a
workspace Owner may do so, with current owning-team membership for team-owned sessions. A
collaborator may remove themselves with session read access alone; team membership, collaboration,
or lifecycle permission is not required for self-removal.

The collaborator picker is available to session owners and workspace Owners after the session read
and collaborator-management checks. For a workspace-owned session it lists every active workspace
user; for a team-owned session it lists only active members of the owning team, and adding anyone
else is rejected with `not_team_member`. Selecting a collaborator is an explicit private-session
access grant, not a team membership or workspace role change. On a team-owned session the grant is
honored only while the collaborator remains a current member of the owning team: leaving or being
removed from the team ends their collaborator access on the next authorization check, even though
the collaborator record itself is kept.

Session actions have additional rules after visibility: prompting requires collaboration permission,
sandbox use requires sandbox permission, and lifecycle operations require lifecycle permission. With
team enforcement on, or for team-owned sessions in any mode, deletion requires delete permission
**and** session ownership, a lead role in the owning team, or a workspace Owner/Administrator role.
Team leads do not gain access to private sessions simply by leading the team. Changing private
visibility is reserved for the session owner or a workspace Owner. These role and ownership rules
never bypass the current-membership requirement for team-owned actions. Private-session action rules
apply even while team enforcement is off or in shadow mode.

### Team Defaults and Migration

A team's `defaultVisibility` (stored as `teams.default_visibility`) accepts only `team` or
`workspace`. It sets the audience of new sessions, not their ownership. `private` remains an
explicit per-session choice, including for team-owned sessions with a workspace user owner. The
owner and owning-team membership requirements for private sessions are unchanged.

Migration `terraform/d1/migrations/0085_team_default_visibility.sql` changes existing private team
defaults with `UPDATE teams SET default_visibility = 'team' WHERE default_visibility = 'private'`,
including archived teams. It does not change existing sessions, their visibility, or collaborator
records. The same atomic migration installs insert and update triggers that reject private team
defaults, including writes from the previous Worker between migration commit and deployment. These
triggers fence the rollout without rebuilding the referenced teams table; the SQL portability
baseline documents this exception. Shared schemas and runtime `TeamStore` validators also enforce
the allowed defaults. D1 and Node SQLite use the same global migration series in
`terraform/d1/migrations/`.

**Rollout prerequisite:** apply migration `0085` to the global database before deploying application
code with the narrowed team-default schema. Otherwise, existing private defaults can fail team row
and response validation. The database rejects private-default edits through older application
versions during rollout; the new APIs return the normal validation response. Explicit Private
options in session creation and visibility controls remain available.

### Creating Sessions

Session creation checks the selected repository or environment as well as the creator's workspace
permission. Supplying a team requires active membership in that team and a grant covering **every**
repository used by the session; archived teams cannot be selected. Without an explicit session
visibility, normal creation, Slack and Linear launchers, and automation runs inherit the owning
team's current default; teamless sessions default to `workspace`. The launch source does not
override that default. `team` visibility requires a team; explicit `private` visibility requires a
workspace user owner. A teamless session may still be private.

For an agent-spawned child of a team-owned session, the active prompt author's canonical identity
must resolve and still belong to the owning team. The child cannot borrow its parent owner's
membership when that author is missing or no longer a member; creation fails with `not_member` in
every enforcement mode. Child actions also check the active author's current access.

Owners and Administrators can configure **Settings > Teams > Require a team for new sessions**
(`requireTeamOnCreate`). It is off by default. Despite the setting's session-oriented label, it
requires a team for new sessions, environment definitions, and automation definitions; creation
requests without one fail with `team_required`. Teamless bot session creation requests are also
refused. Existing workspace-owned automations can still run under their runtime authorization
checks. The setting does not migrate or hide existing `ownerTeamId: null` workspace rows.

Team leads and workspace Owners/Administrators manage repository grants in the team's Repositories
tab or through `/teams/:id/repository-grants`. Team members and workspace Owners/Administrators can
read the grants. A team can have either installation-wide access or named grants by SCM repository
ID, but not both. Creating a team does not grant repository access. Repository-backed team sessions
without covering grants are refused with `target_team_missing_grant`. Repository-less team sessions
do not need grants. Removing a grant advances the team's grant version and leaves existing
repository references intact. Current grants narrow subsequent GitHub sandbox credential resolution
to covered session repositories, but do not immediately revoke already-issued tokens.

Repository skills, repository secrets, and repository image builds remain workspace-level resources;
grants do not assign them to an owning team. They keep their existing permission checks when no team
grants the repository. Once any team grants it, callers must be current members of an active
granting team (leads for repository secrets), or be a workspace Owner or Administrator. Installation
grants count for every repository. Importing repository secrets into an environment checks the
source repository's workspace-level grant access as well as the destination owning team's coverage,
if the environment has an owning team. These checks apply in every `TEAMS_ENFORCEMENT` mode.

### Environment Access

Workspace environments are readable and usable with the relevant workspace permissions. Team-owned
environments additionally require owning-team membership or a workspace Owner/Administrator role.
Managing a team environment requires a team lead or workspace Owner/Administrator **and**
`environments.manage`; workspace environments require that permission without the team-role check.
Environment names are unique within their owning team or workspace, not across the deployment.

Changing environment secrets, settings, or images requires environment management access in addition
to the corresponding feature permission. This includes workspace environments: custom roles with
only a secrets/settings/images permission do not thereby gain management access. Manual image builds
also require the active owning team's grants to cover every current repository. Membership or grants
in another team cannot replace that coverage, even for Owners and Administrators.

A team environment can launch only into a session owned by that same team. A team's session catalog
can also include readable workspace environments whose repositories its grants cover. Unbound bot
catalog reads conceal team environments. These resource checks apply in every `TEAMS_ENFORCEMENT`
mode.

### Ownership and Discovery

Sessions, automations, and environments cannot move between teams or between a team and the
workspace. A session's owning team is fixed at creation: a team-owned session never becomes
workspace-owned. Changing its visibility to `workspace` changes who may read it, not its ownership
or the team membership required for non-read actions.

Visibility changes can include descendants. A cascading visibility change refuses the entire request
if any included descendant is inaccessible or denies the requested action, including the
current-membership check for each team-owned descendant; it does not silently skip that descendant.
The web visibility control autosaves selection changes. **Include child sessions** starts checked;
unchecking it only scopes future changes to the parent, while checking it applies the current
visibility to children even if the parent selection has not changed. Team changes and non-private
child cascades ask for confirmation, since they can restrict collaborators or widen private-child
access. Grant changes constrain subsequent credential resolution, not the token already available to
a running sandbox.

Session discovery and inbox filters compose on the server: `ownerFilter=started` matches the
creator, `participating` also includes explicit collaborators and users with persisted read state,
and `anyone` adds no ownership filter. `visibility=team|workspace|private` and repeated `teamIds[]`
narrow the readable rows. `scope=workspace` means teamless sessions, not workspace visibility;
`scope=all` is reserved for workspace Owners and Administrators and does not bypass visibility or
enumerate break-glass-only private sessions. Inbox `mine=true` remains creator-only and excludes
direct automation and GitHub-bot sessions, but retains eligible agent descendants.

### Enforcement and Access Paths

Operators set `TEAMS_ENFORCEMENT` to `off`, `shadow` (the default), or `on`:

- `off`: legacy read visibility for non-private sessions and legacy actions for non-private
  workspace-owned sessions. Private access and the full action resolver for team-owned sessions
  remain enforced.
- `shadow`: continue those legacy reads and workspace-owned actions while auditing would-be denials.
  Private access and the full action resolver for team-owned sessions remain enforced.
- `on`: enforce visibility, team membership, and action/ownership rules for sessions.

Production Terraform exposes this as `teams_enforcement` and passes it to the control-plane Worker.
The Terraform CI workflow's plan and apply resolve `TEAMS_ENFORCEMENT` from the repository variable,
then the same-named secret, then `shadow`. The AWS configuration also explicitly sets `shadow`. Set
`on` to enforce non-private Team-visibility read isolation; deploying Teams alone does not enable
it. Environment/automation ownership, repository grant, and team-secret checks are not disabled by
this session rollout setting.

No mode relaxes current owning-team membership for non-read actions, including for workspace Owners
and Administrators. The visibility and collaborator mutation routes always enforce the session
access resolver, including in `off` and `shadow` modes. Those modes do not relax these mutation
checks or the checks on descendants included in a cascading operation. Collaborator self-removal
remains read-only-authorized in every mode.

Actorless Slack and Linear reads scoped to an unbound integration coordinate can read only
workspace-owned, non-private sessions in every mode. Unbinding immediately revokes scoped reads of
team-owned sessions, even when their visibility is `workspace`; channel-less service reads keep
their existing semantics. Slack publication, including `purpose=slack-post` reads, also requires a
current matching channel binding for team-owned sessions in every mode. Private sessions cannot
publish to Slack. Unbound DMs and never-bound channels have no team-session exception. Refused
callbacks send only a coordinate-only thread closure, not session content. Queued completions
recheck publication access immediately before posting text and sharing staged media. Once closure
delivery starts, retries continue closing the thread even if the channel is rebound; rebinding does
not resume that completion.

The session boundary covers four paths, not just the session page:

- **HTTP item routes** authorize by the persisted session row before serving snapshots, actions,
  children, exports, or other session-specific data. A session hidden by visibility responds with a
  non-enumerating `404` rather than confirming that its ID exists.
- **Lists and aggregates** filter by visibility before returning sessions in search, inbox, child
  lists, bulk export, and analytics. Private sessions do not appear in an Owner's lists solely
  because of break-glass access; administrative analytics can include a scope-filtered, unattributed
  private cost total without exposing those sessions.
- **Durable Object connections** recheck subscription and commands against the current session row,
  so a stale browser tab does not turn a previous grant into lasting access. A private break-glass
  subscription requires an audit write.
- **Sandbox access** is a separate session action. Snapshot sandbox URLs and supported sandbox tools
  are not granted just because a session can be read; a break-glass Owner cannot use another
  person's private sandbox without becoming a collaborator. Session-bound sandbox credentials are
  not general user visibility grants.

New HTTP requests reflect role, membership, collaborator, and visibility changes on the next check.
Live browser connections are rechecked at least every five minutes, so an existing connection may
remain open for up to five minutes after access changes. Recreating the session is not required.

### Reviewing Shadow Denials

Before switching `TEAMS_ENFORCEMENT` from `shadow` to `on`, review would-be denied requests per UTC
day across all reader seams. These records are observation only: requests and subscriptions still
use the current mode's authorization rules. `off` and `on` do not emit shadow records.

- HTTP item routes use `authorization.request_allowed` with `shadow_denied:<reason>`.
- Session lists, inbox snapshots/pages (including descendants), child lists, and bulk exports use
  one `shadow_denied:batch` row per request that returns would-be-hidden rows.
  `metadata_json.shadowDenialCount` counts all would-be-hidden rows in the returned page, not the
  lookahead row; `shadowDenialReason` is `not_member`. No returned-session ID samples are collected
  or stored. Run exports count rows hidden by either their own or their root's enforced visibility.
- Team session pages have no shadow delta: admission requires target-team membership or workspace
  admin status in every mode, and every returned row belongs to that same team. Those readers
  already pass the enforced team visibility clause, so no observation hook is needed.
- WebSocket subscribe and subsequent read checks use `session.shadow_denied` with `channel: "ws"`
  and `shadow_denied:<reason>`, at most once per connection/session/reason during the authorization
  lease, including after hibernation. Repeated presence, history, or typing checks do not add rows
  for an already-observed reason. A new connection can add a new record. These best-effort writes
  run in the background without delaying subscription completion or commands.
- Analytics totals, breakdowns, grouped run analytics, and other aggregate counts are deliberately
  not observed: attributing their difference would require additional SQL. There is no second
  aggregate query or per-session lookup for shadow auditing.

The workspace audit viewer labels WebSocket records as **Session read shadow observation**, uses a
**Would deny** observation badge rather than **Denied**, and exposes the reason and metadata. For
daily counts split by seam and reason, run this query against the existing D1
`authorization_audit_events` table, replacing the start date with the start of the shadow release:

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

For cross-team denial volume, select the `not_member` results. Counts are affected HTTP requests or
WebSocket leases, not hidden session rows, unique users, or messages. Current collection records
store only the count and reason. The query also reads per-session reasons from older batch records
and existing explicit body-ID mutation audits; `UNION` deduplicates request/reason pairs. A children
request can appear in both item and list seams if its parent and returned children would both be
hidden. Audit persistence is best effort; write failures are logged without changing access. Account
for these failures and the aggregate gap when interpreting the release.

## How Automation Access Works

Automations have an immutable owning team (or workspace ownership) and a separate executor account,
initially the creator. Workspace definitions and run history are readable with automation read
permission; team definitions additionally require team membership or a workspace Owner/Administrator
role. These checks apply in every session enforcement mode.

Creating either workspace-owned or team-owned automations requires both `automations.create` and
`sessions.create`, as well as target access and any applicable team membership.

- Executors and owning-team leads can manage/trigger eligible automations with the corresponding
  `own` permissions; `any` permissions allow those actions across eligible automations.
- Built-in Administrators and Owners can manage and manually trigger any automation. A manual run of
  a team automation still requires the requester to be a member of its active owning team.
- Viewers can inspect eligible automations but cannot create, change, or run them.

A team lead or workspace Owner/Administrator with automation management access can reassign the
executor to an active, authorized user (a member of the active owning team for team automations).
Reassignment is audited and does not change team ownership. Being the executor alone does not grant
reassignment authority. See [executor reassignment](AUTOMATIONS.md#executor-reassignment).

Reading an automation does not grant access to its sessions. Run history redacts linked session IDs,
titles, and artifact summaries when the viewer cannot read those sessions.

### Scheduled and Event Runs

Scheduled and event-driven runs execute under the executor's authority. At run time, the executor
must still be active and allowed to create sessions and use the selected targets. Team runs also
require current membership in the active owning team and current grants covering the repositories
that will run. Generated sessions inherit the automation's team and its default visibility;
workspace automations generate workspace-owned, workspace-visible sessions. If authorization fails,
the run does not start.

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

Private sessions cannot be published to Slack, even when the acting user can read the session.
Changing a team's default does not relax this restriction.

### Slack and Linear Bindings

Team leads and workspace Owners/Administrators manage Slack channel and Linear team bindings in
**Teams > Channels**. Each external coordinate belongs to at most one Open-Inspect team; each team
has at most one primary binding per provider, with additional source bindings. Both kinds route
creation to that team. Bindings do not add members or repository grants, and changing a binding does
not reassign existing sessions. Slack binding validation requires the bot to have joined the channel
and rejects externally shared channels.

Slack and Linear each have a separate `unboundChannels` integration setting in their respective
**Settings > Integrations** page. `workspace` (default) permits unbound creation into workspace
ownership; `reject` requires a binding. `requireTeamOnCreate` can still refuse workspace fallback.
Binding lookup failures stop launch rather than silently falling back. Scoped classification and
target mappings do not bypass membership, repository grants, or environment ownership.

Slack interactive follow-ups never replace an unavailable session with a new one on `404`. Confirmed
publication denial closes the thread; a later reply may reopen it only when posting is allowed
again. An actor-specific forbidden follow-up is refused without closing the thread for other
authorized users. Session publication, including queued media and `slack-notify`, refuses private
sessions and destinations bound to a different team independently of session enforcement mode.
Unbound destinations are not an outbound allowlist. Slack automation steering has its own scheduler
path; see [Slack follow-ups](integrations/SLACK.md).

Linear uses the external Linear team coordinate for ownership and scoped catalog/completion reads.
Legacy KV repository/environment mappings select targets, not team ownership, and are not migrated
into bindings automatically. The bot verifies the issue's current team before posting completion; if
it changed from the launch team or a protected read fails, it withholds results. Unlike Slack's
publication gate, Linear's actorless session reads retain the `off`/`shadow`/`on` session-read
semantics: full Team read isolation still requires `on`. See [Linear](integrations/LINEAR.md).

### GitHub Routing

GitHub uses numeric repository IDs rather than channel bindings. Event automations match the
repository and their owning team's grants, and run as their configured executor. A matching team
automation denied its trigger-repository grant can record an `unauthorized` history entry with
`repo_not_granted`, without a session or failure strike; other runtime authorization denials keep
their existing skip behavior. This is distinct from the general event-denial path described in
[Automations](AUTOMATIONS.md#managing-automations).

Mentions use the linked PR session's owning team first, then an eligible sender team with a grant.
Multiple eligible teams use the sender's most recent session in the repository to break the tie;
unresolved identity or ambiguity falls back to workspace ownership. Routing is not permission to
read the linked session and does not bypass session-creation checks or the require-team policy.
Autofix continues in the PR's existing session. Deprecated auto-review-on-open remains
workspace-owned; use a team-owned GitHub Event automation for team-owned reviews. See
[GitHub](integrations/GITHUB.md).

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
App should be installed only on repositories intended for the workspace. GitHub sandbox tokens are
restricted to the persisted session repository set, intersected with current grants for team-owned
sessions. Workspace-owned sessions have no team-grant intersection. Installation-wide team grants do
not expand the session repository set. Editing an environment does not expand an existing session's
copied repositories; private submodules, dependencies, and sibling clones need their repositories
included before session creation and, for team-owned sessions, covered by the owning team's grants.
Unresolvable or invalid repository IDs and empty scopes fail closed rather than falling back to
installation-wide GitHub credentials.

Grant removal affects subsequent credential resolution, not immediate revocation of issued tokens;
those can remain valid until expiry. Installation-wide metadata/catalog operations remain separate.
GitLab uses a deployment-wide PAT and ignores per-call credential scope; the helper's reported
refresh time is a cache lifetime, not the PAT's expiry or revocation. Teams do not establish
multi-tenant isolation. See
[Sandbox Repository Access](GETTING_STARTED.md#sandbox-repository-access).

### Credential Delivery and Snapshots

Session git operations use `oi-git-credentials`, which authenticates to
`POST /sessions/:id/scm-credentials` with the session's sandbox auth token. Git requests must use
HTTPS and the configured `VCS_HOST`; GitHub repository restrictions are enforced by the issued
token, not by a repository-path check in the helper. The normal session launch path brokers
credentials instead of injecting a system clone token into the environment or remote URL. This is
not a guarantee that credentials are absent from sandbox processes, files, or snapshots.

The helper caches the successful response, including its `password` token, in `scm-creds.json` on
disk with mode `0600`. The directory is selected by `OI_SCM_CRED_CACHE_DIR`: packaged images set it
to `$HOME/.cache/openinspect/scm`, while the helper's fallback is `/run/oi`. It reuses the cache
until five minutes before the reported expiry, serializes refreshes with a lock, and does not fall
back to stale credentials when a refresh fails. A still-valid cached credential can be used without
a new control-plane authorization check.

Modal's snapshot path captures the full sandbox filesystem, not only `/workspace`, and does not
clear the helper cache before capture. A snapshot can therefore contain and restore cached SCM
tokens, as well as credentials written by setup scripts or agent-run code. Moving a file outside a
repository does not exclude it from that snapshot. Short-lived GitHub tokens limit their usable
lifetime, not their persistence; GitLab's cached PAT can outlive the helper's cache lifetime. Treat
snapshots as sensitive artifacts, not credential-free backups.

Image builds have no session credential broker and receive `VCS_CLONE_TOKEN` instead. For GitHub,
repository builds are scoped to that repository; environment builds use the planned repositories,
intersected with current owning-team grants when the environment is team-owned. For GitLab, the
build credential is still the deployment PAT. This build-time delivery is not a single-use or
snapshot-exclusion guarantee. Files written during a build can persist in prebuilt images; see
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
