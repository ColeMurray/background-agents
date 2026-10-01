# Authentication and Authorization

Open-Inspect uses authentication to establish who you are and workspace authorization to decide what
you can do. This guide explains the behavior users and workspace administrators will see.

> **Important:** Open-Inspect is designed for a single trusted organization. A deployment is one
> workspace, and the source-control App installation defines the repositories available to that
> workspace. Roles control which Open-Inspect features a person can use; teams and session
> visibility further limit access to sessions. Neither is a replacement for source-control
> repository permissions.

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

Members can create and use sessions, collaborate in sessions visible to them (except private
sessions where they are not collaborators), use shared repositories and environments, and create
automations. They can manage and manually trigger automations they own but cannot modify another
person's automation or administer shared configuration. They can view workspace analytics.

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

### Team Directory and Pages

Every active workspace user can list active teams and read their member lists, even without
membership in those teams. The team directory supports search and favorites, and team pages show
team metadata and members. Archived teams and their member lists are available only to their members
and workspace Owners and Administrators.

A team's session overview and **Activity** are available to its members and workspace Owners and
Administrators. Activity contains domain events, not HTTP authorization decisions. Session events
are filtered by the viewer's current session visibility, so membership in the team alone does not
expose another user's private-session events. The workspace audit log remains behind
`workspace.audit.read`; its team filter includes teams the reader does not belong to.

The sidebar context defaults to **All my teams**, which leaves session lists unfiltered by team
while preserving server visibility checks. Users with at least one active team can choose Workspace
(teamless rows), a team, or All my teams; Owners and Administrators can also choose All teams. Users
without active teams have no selector and keep unfiltered lists. A stored Workspace or active-team
choice is retained; unknown or archived selections fall back to All my teams.

The new-session composer's team and visibility are draft-local choices initialized from the sidebar
context. Changing them does not change the sidebar or command-menu recents. If a team is required
and the context does not name one, the composer selects the user's first active team locally.

### Session Visibility

Each session stores a visibility independently of its team:

| Visibility  | Who can read the session when team enforcement is on                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace` | Workspace users with session read permission, even if the session has a team.                                                                                                                   |
| `team`      | Members of the owning team, plus workspace Owners and Administrators, with session read permission. Requires an owning team.                                                                    |
| `private`   | The session owner and explicit collaborators with session read permission. A workspace Owner can also open it by ID under audited break-glass access; Administrators do not get this exception. |

Private visibility is enforced in every enforcement mode. An Owner's break-glass read is audited,
does not cause the session to appear in their lists, and does not grant prompt or sandbox access. An
Owner with the required lifecycle or delete permission can manage a private session they opened by
ID; being an Administrator alone does not grant access. Actorless bot services cannot read private
sessions; user-backed integration requests still depend on the acting user's access.

The **Mine** filter helps find sessions you created but does not define who may access them. A
session's owner is its creating workspace user, not its team. Explicit collaborators are an access
grant for private sessions; they still need the relevant workspace permission to read, prompt, or
use the sandbox. Runtime participants record who connected or contributed and may carry runtime
credentials; being a participant alone is not a visibility grant. Conversely, making someone a
collaborator does not turn them into a runtime participant. Removing a collaborator revokes their
private-session access on subsequent authorization checks. Adding collaborators or removing someone
else requires `manageCollaborators`: after the session read check, only the session owner or a
workspace Owner may do so. A collaborator may remove themselves with session read access alone;
collaboration or lifecycle permission is not required for self-removal.

The collaborator picker is available to session owners and workspace Owners after the session read
check and lists every active workspace user, including users outside the owning team. Selecting a
collaborator is an explicit private-session access grant, not a team membership or workspace role
change.

Session actions have additional rules after visibility: prompting requires collaboration permission,
sandbox use requires sandbox permission, and lifecycle operations require lifecycle permission. With
team enforcement on, deletion requires delete permission **and** session ownership, a lead role in
the owning team, or a workspace Owner/Administrator role. Team leads do not gain access to private
sessions simply by leading the team. Changes to team ownership require the session owner, an
owning-team lead, or a workspace Owner/Administrator, as well as lifecycle permission; changing
private visibility is reserved for the session owner or a workspace Owner. Private-session action
rules apply even while team enforcement is off or in shadow mode.

### Creating and Moving Sessions

Session creation checks the selected repository or environment as well as the creator's workspace
permission. Supplying a team requires active membership in that team and a grant covering **every**
repository used by the session; archived teams cannot be selected. Without an explicit visibility,
team sessions use the team's default and teamless sessions default to `workspace`. `team` visibility
requires a team; `private` requires a workspace user owner. A teamless session may still be private.

Owners and Administrators can configure **Settings > Teams > Require a team for new sessions**
(`requireTeamOnCreate`). It is off by default. When enabled, new sessions must select a team; it
refuses session creation API requests without a team with `team_required`. The web app supports team
selection; team selection in bots is a later phase, so their teamless creation API requests are also
refused when the setting is enabled. Automation runs are exempt until automation team ownership is
supported. The setting does not migrate or hide existing `ownerTeamId: null` workspace rows.

There is no repository-grant creation API or UI yet. Repository-backed team sessions and moves
without existing grants are refused with `target_team_missing_grant`; creating a team does not grant
it repository access. Repository-less team sessions do not need repository grants.

Moving a session to a team checks active membership in the destination (or an explicit join to an
open team) and repository grants for every repository in the session and included descendants. A
missing grant blocks the move. Moving to no team sets `ownerTeamId` to `null` and turns `team`
visibility into `workspace`. Moving or changing visibility can include descendants. Team grants
constrain selection and moves, not the source-control App token already available to a running
sandbox. A cascading move or visibility change refuses the entire request if any included descendant
is inaccessible or denies the requested action; it does not silently skip that descendant. The web
visibility control requires a changed selection and asks for confirmation when applying non-private
visibility to child sessions, since private descendants will receive that visibility too.

Session discovery and inbox filters compose on the server: `ownerFilter=started` matches the
creator, `participating` also includes explicit collaborators and users with persisted read state,
and `anyone` adds no ownership filter. `visibility=team|workspace|private` and repeated `teamIds[]`
narrow the readable rows. `scope=workspace` means teamless sessions, not workspace visibility;
`scope=all` is reserved for workspace Owners and Administrators and does not bypass visibility or
enumerate break-glass-only private sessions. Inbox `mine=true` remains creator-only and excludes
direct automation and GitHub-bot sessions, but retains eligible agent descendants.

### Enforcement and Access Paths

Operators set `TEAMS_ENFORCEMENT` to `off`, `shadow` (the default), or `on`:

- `off`: legacy workspace-wide session authorization for non-private sessions; private sessions
  remain restricted.
- `shadow`: continue legacy access for non-private sessions while recording where team or ownership
  rules would deny access; private restrictions still take effect.
- `on`: enforce visibility, team membership, and action/ownership rules for sessions.

The visibility, scope, and collaborator mutation routes always enforce the session access resolver,
including in `off` and `shadow` modes. Those modes do not relax these mutation checks or the checks
on descendants included in a cascading operation.

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

## How Automation Access Works

Automation definitions and run history are visible workspace-wide to roles with automation read
access. Creating, changing, and manually triggering automations use ownership rules.

- Members can manage and manually trigger automations they own.
- Administrators and Owners can manage and manually trigger any automation.
- Viewers can inspect automations but cannot create, change, or run them.

Automation ownership follows the signed-in account that created it, not a display name or external
provider username.

### Scheduled and Event Runs

Scheduled and event-driven runs execute under the automation owner's authority. At run time, the
owner must still be active and allowed to create sessions and use every selected repository or
environment. If those permissions have been removed, the run does not start.

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

## Suspension

Suspending a member disables their workspace access without deleting their account or historical
attribution.

After suspension:

- New browser and bot operations are denied.
- Existing browser sign-in sessions are invalidated.
- Live browser session connections close within five minutes.
- Scheduled and event-driven automations owned by the member no longer pass run authorization.
- Existing session history and authorship remain intact.

Suspension does not automatically stop a sandbox that is already executing. An Administrator or
Owner can manage that session separately.

## Repository and Credential Boundaries

Open-Inspect uses a shared source-control App installation for clone, fetch, and push operations.
The App should be installed only on repositories intended for the workspace. Team repository grants
check which repositories may be chosen for a team session or move; they do **not** narrow the shared
installation token delivered to a sandbox. Token narrowing is a future phase, not a protection
provided by team visibility today.

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
