# Authentication and Authorization

Open-Inspect uses authentication to establish who you are and workspace authorization to decide what
you can do. This guide explains the behavior users and workspace administrators will see.

> **Important:** Open-Inspect is designed for a single trusted organization. A deployment is one
> workspace, and the source-control App installation defines the repositories available to that
> workspace. Roles control which Open-Inspect features a person can use; they are not per-repository
> access lists.

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
| View every session                                |  Yes  |      Yes      |  Yes   |  Yes   |
| Collaborate in and manage sessions                |  Yes  |      Yes      |  Yes   |   No   |
| View automations                                  |  Yes  |      Yes      |  Yes   |  Yes   |
| Create automations                                |  Yes  |      Yes      |  Yes   |   No   |
| Manage and trigger own automations                |  Yes  |      Yes      |  Yes   |   No   |
| Manage and trigger any automation                 |  Yes  |      Yes      |   No   |   No   |
| View and manage workspace members                 |  Yes  |      Yes      |   No   |   No   |
| Transfer workspace ownership                      |  Yes  |      No       |   No   |   No   |
| View analytics                                    |  Yes  |      Yes      |  Yes   |  Yes   |
| View provider accounts                            |  Yes  |      Yes      |  Yes   |   No   |
| View image-build history                          |  Yes  |      Yes      |  Yes   |  Yes   |
| Manage personal skill profiles                    |  Yes  |      Yes      |  Yes   |   No   |

### Owner

Owners have full access to the workspace. Only Owners can grant or remove the Owner role or suspend
and restore another Owner. Open-Inspect also prevents the final active Owner from being suspended or
demoted, so the workspace cannot accidentally lose all ownership.

### Administrator

Administrators can operate the workspace day to day. They can manage members, sessions, automations,
repositories, environments, provider accounts, integrations, and secrets. They cannot transfer
ownership, change who holds the Owner role, or suspend and restore an Owner.

### Member

Members can create and use sessions, collaborate in existing sessions, use shared repositories and
environments, and create automations. They can manage and manually trigger automations they own but
cannot modify another person's automation or administer shared configuration. They can view
workspace analytics.

### Viewer

Viewers have read-only access to shared workspace resources. They can inspect sessions, automations,
analytics, repositories, environments, skills, and MCP servers. They cannot create or prompt
sessions, access sandboxes, manage personal skill profiles, trigger automations, or change shared
configuration.

## How Session Access Works

Sessions are workspace resources rather than private resources owned by their creator.

- Anyone with session read access can view every session in the workspace.
- Anyone with collaboration access can prompt and contribute to every session.
- Anyone with lifecycle access can stop, retry, archive, unarchive, and otherwise manage every
  session.
- Anyone with sandbox access can use supported sandbox tools for every session.
- Anyone with delete access can delete every session.

The creator shown on a session records attribution; it is not an access list. Likewise, participant
labels identify who contributed to a session but do not grant or remove workspace permissions. The
**Mine** filter is a convenience for finding sessions you created, not a security boundary.

Creating a session also requires permission to use its selected repository or environment. A role
may therefore be able to view an existing session without being allowed to create a new one.

New HTTP requests reflect role changes and suspension immediately. Live browser connections to a
session are rechecked at least every five minutes, so a connection may remain open for up to five
minutes after access changes. Recreating the session is not required.

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
The App should be installed only on repositories intended for the workspace.

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
[Getting Started](GETTING_STARTED.md#step-7a-bootstrap-the-workspace-owner) for the deployment
steps.

## Related Guides

- [Getting Started](GETTING_STARTED.md)
- [Automations](AUTOMATIONS.md)
- [Secrets Management](SECRETS.md)
- [How Open-Inspect Works](HOW_IT_WORKS.md)
