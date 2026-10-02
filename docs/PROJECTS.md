# Projects

Projects are durable context hubs for related sessions and pull requests. They do not replace
repository/environment targets or grant access to sessions. This implements Projects v1; generated
status updates, source fetching, Memory and Agent Profile integration remain deferred.

## Using a project

1. Open **Projects → New project**, choose its owning team (or workspace when permitted), and a name
   and URL short name.
2. In **Settings**, curate the brief, optional default environment **or** repository, Linear project
   link, and primary Slack channel ID. Defaults are suggestions, not target restrictions.
3. Add dated decisions, links, or session artifacts in **Overview**. Add references in **Sources**.
   `page_only` references stay out of agent context. External references are not fetched by the
   control plane; refresh policy is reserved metadata in v1.
4. Choose **Start session**. The composer applies the project team and target defaults and shows the
   creation-context size. You can override the target, including choosing No repository.
5. Use **Sessions** to associate existing work, including descendants by default. Moving or removing
   a project never rewrites a session's original context or changes its sandbox, branch, status,
   team, or visibility. Cross-team moves are rejected.

The Overview board derives five lanes from visible lineage pull requests: no PR, draft, open,
merged, and closed. Session buckets reuse the inbox predicates; the full sessions page supports
project/unassigned filters. Pull requests and analytics include only work visible to the viewer.
Inaccessible pinned artifacts appear as unavailable, without their original title or metadata.

Type `#` in a prompt to select a readable session. At most three distinct references are resolved
when the prompt is accepted. Each includes metadata and the latest completed turn's final assistant
excerpt (at most 2,000 characters), never user prompts, tool output, or a transcript. Each
serialized summary is bounded to 4,000 characters. Resolution uses the prompt author's canonical
identity, including in multiplayer sessions, not the session owner's identity. Expansion also
requires a compatible destination audience: workspace-visible references or references between
team-visible sessions owned by the same team. Private cross-session references and unavailable
lookups remain unexpanded markers; embedded summaries omit project metadata.

## Context contract

| Channel                | Content                                                                       | Bound                                                  |
| ---------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------ |
| Creation snapshot      | Brief, recent decision first lines, source counts                             | 12,000 UTF-8 bytes total; brief 8,000; decisions 2,000 |
| `read_project_context` | Live brief, decisions, links, source references, visible session/PR summaries | 65,536 UTF-8 bytes of JSON; at most 20 sessions        |

The snapshot and its manifest are committed in the same database batch as the session. The manifest
records a brief hash, included decision/source IDs, and truncation. Edits and reassociation do not
change it. Children inherit association but do not receive another creation injection.

Both OpenCode and Claude receive the snapshot as explicitly untrusted context. Boot uses the exact
session-bound sandbox token to fetch it; failed or oversized responses fail explicitly and clear
stale restore files. The live tool is installed only when a project is associated. Restoring a
session after removing its project preserves the original snapshot but disables the live tool.
Associating a running session does not mutate its harness; tool installation changes at next boot.

The live tool resolves current project access for the session owner on every read. Shared sessions
exclude private sibling summaries. Source fetching is described honestly: repository documents are
available in the workspace only when that repository is a session target; URLs may be agent-fetched;
Linear/Slack sources are references only in v1. No credentials or conversation bodies are included.
Each successful live read records `project_context.read` with bytes and truncation, not contents.

## Ownership and authorization

- `projects.read`, `projects.create`, `projects.manage.own`, and `projects.manage.any` are explicit
  permissions. Read permission alone does not grant `sessions.read`.
- Team membership controls team project visibility; workspace owners/administrators retain their
  existing administrative visibility. A creator or team lead with manage-own can curate; manage-any
  supports administrators. There is no project membership table or separate project ACL.
- Session association requires current session lifecycle access to every affected descendant,
  including terminal children. Commit-time guards reject stale grants, team mismatches, and a
  concurrent root association change. No partial subtree update is committed.
- Project writes emit operation audit records in the same batch. Hidden projects are not exposed
  through list, board, PR, source, analytics, or reference projections.
- `requireTeamOnCreate` is honored; no synthetic default team is created. Team moves are not exposed
  by the current baseline, and Projects does not add one.

## Automations and notifications

Subscribe existing automations from the project's Automations tab or select a project in the normal
automation form. This affects future runs only. An automation retains its own target and schedule;
the project does not silently replace them. The actual executor is reauthorized at launch, and each
new run gets a fresh immutable project snapshot. A project subscription change and its
audit/authorization receipt commit with the automation and target changes, or roll back.

The primary Slack channel is a fallback for explicitly requested agent notifications and completion
notices when Slack agent notifications are enabled. Originating Slack conversations retain their
destination. Automatic project completion notices omit private sessions and contain only fixed
completion status plus a session link, not titles or transcripts. Delivery is best effort with at
most one attempt per message; failed Slack delivery does not roll back completed work.

## Interfaces and storage

- Human APIs: `/projects`, `/projects/by-slug/:slug`, `/projects/:id`, status actions,
  `status-summary`, `sources`, `pins`, `sessions`, `pull-requests`, and `context/preview`.
- Session APIs: `PUT /sessions/:id/project`, `GET /sessions/:id/project-snapshot`, and
  `GET /sessions/:id/reference-summary`. Prompt APIs also accept explicit reference IDs.
- Sandbox-only API: `GET /sessions/:id/project-context?part=injection|tool`.
- List/inbox filters: `projectId` or `hasProject=false`. Create-session and automation APIs accept
  `projectId`. The web proxy forwards these fields.
- Migration `0086_projects.sql` creates `projects`, `project_context_sources`, `project_pins`, and
  `session_project_snapshots`; adds `automations.project_id` and indexes. It reuses the session
  project column already introduced by Teams migration 0083. There is no backfill.

Current bounded projections: project index up to 200 entries, sources/pins up to 200 per project,
project PR list up to 500, and recent/board up to 50 roots per inbox category. The session view
links to full history when more exists; category APIs accept inbox cursors. Automation selection
displays up to 100 entries. These bounds prevent unbounded reads; cursor-based project/PR catalogs
can be added when workspace scale requires them.

## Deployment

Deploy the updated sandbox runtime/image before enabling project-bearing control-plane launches;
apply migration 0086 before the new control-plane code and deploy web with matching shared schemas.
Old runtimes ignore project configuration, so runtime/control-plane version ordering matters.

Validate deployment by creating a project session on each harness, inspecting its original snapshot,
calling the live tool, restoring the session, and triggering an automation.
