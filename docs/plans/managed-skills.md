# Managed Skills

## Status

Proposed design for V1. This document intentionally distinguishes product-visible version control,
which is deferred, from immutable internal revisions, which are required for reproducible sessions.

## Summary

Open-Inspect should let admitted users create and edit reusable agent skills in the web application,
associate them with the installation, environments, and repositories, and choose a personal skill
profile when creating a session. The control plane resolves those inputs once, pins the exact skill
revisions to the session, and makes a content-addressed manifest available only to that session's
sandbox. The sandbox validates and atomically installs the manifest before OpenCode starts.

V1 introduces four separate concepts:

- **Skill**: a shared, installation-wide Agent Skills package and its current content.
- **Assignment**: a rule that makes a skill applicable globally or to a repository or environment.
- **Profile**: a user's reusable selection from the skills applicable to a session target.
- **Session manifest**: the immutable revisions actually selected for one session, including why
  each skill applied.

The separation matters. Editing a skill does not mutate running or already-created sessions;
assignments do not duplicate content; and profiles express user preference without changing the
team's shared catalog.

Open-Inspect is currently a single-tenant product. It has canonical users but no internal team,
workspace, membership, role, or tenant authorization model. In V1, "team-managed" therefore means
shared by everyone admitted to one Open-Inspect installation. Adding a cosmetic `team_id` only to
skills would imply an isolation boundary that does not exist. A future multi-tenant design must add
tenancy consistently across repositories, environments, sessions, secrets, integrations, and skills.

## Decisions

| Area             | V1 decision                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------- |
| Format           | Adopt the portable Agent Skills directory format with a required `SKILL.md`.             |
| Ownership        | Skills are installation-wide; `created_by` and `updated_by` reference canonical users.   |
| Authoring        | Web editor for `SKILL.md` and supporting UTF-8 text files.                               |
| Scope            | Explicit global, repository, and environment assignments.                                |
| User choice      | Built-in All and None choices plus personal named profiles.                              |
| Resolution       | Union applicable assignments, then apply the chosen profile as a selection filter.       |
| Session behavior | Resolve and pin exact internal revisions when the session is created.                    |
| Storage          | D1 metadata, revisions, and text files for V1; design permits later R2 packages.         |
| Delivery         | Sandbox-authenticated manifest endpoint; no skill content in environment variables.      |
| Installation     | Atomically materialize into OpenCode's global skills directory before startup.           |
| Conflicts        | Reject duplicate discovered skill names; do not depend on undocumented precedence.       |
| Failure policy   | Fail sandbox startup if a selected manifest cannot be authenticated or installed.        |
| Versioning       | Keep immutable revisions internally; defer history, diffs, tags, rollback, and Git sync. |
| Access control   | All admitted users can read and modify skills in V1; preserve clear future ACL seams.    |

## Motivation

Repositories can already carry `.opencode/skills`, and the sandbox runtime bundles several system
skills. Those approaches are useful but do not solve central management:

- A shared workflow must be copied into every repository and updated independently.
- Repository skills cannot easily be associated with an environment containing multiple repos.
- Users cannot opt out of irrelevant shared skills without modifying repository content.
- The platform cannot show who created or last changed a skill.
- There is no session record of the centrally managed content an agent received.
- Bots and repository-less sessions have no repository in which to store a shared skill.

Skills are also more than prompt snippets. A standard skill can include scripts, references, and
assets. Installing one changes the instructions and executable content available to the agent, so
the feature needs integrity checks, deterministic resolution, startup ordering, and provenance.

## Current Architecture

### Identity and tenancy

Canonical people are stored in `users` and `user_identities`; browser and integration principals
resolve to a canonical user ID. Sessions store that ID. The product's admission policy controls who
may enter the installation, but admitted users are trusted members of one organization. There are no
team membership or role checks.

This design uses canonical user IDs for authorship. Authorship is audit metadata, not ownership or
authorization. V1 must not implement "only the creator may edit" because that would be an accidental
and inadequate ACL model.

### Environments and repositories

An environment is a globally named, ordered set of repositories. Creating a session from an
environment snapshots its repositories into `session_repositories` and retains `environment_id` as
provenance. This is the precedent for resolving skills: mutable configuration is converted into an
immutable session input at session creation.

Repository owners can contain `/`; repository names cannot. Any skill schema and API that stores a
repository target must use separate `repo_owner` and `repo_name` columns and the shared repository
identity helpers.

### Existing skills and startup

The runtime currently:

1. Boots and synchronizes repositories.
2. For multi-repository sessions, merges member `.opencode` trees into `/workspace/.opencode` in
   repository order.
3. Calls `OpenCodeServer._prepare_opencode_filesystem()`.
4. Copies bundled runtime skills to the active worktree's `.opencode/skills` directory.
5. Starts `opencode serve`.

The safe insertion point for managed skills is step 3, after repository boot but before the OpenCode
process launches. There is no reliable paused interval after `modal.Sandbox.create()` in which the
control plane can copy files; the runtime itself must fetch and install them.

Snapshots preserve the full filesystem. Installation must therefore reconcile stale files on every
fresh boot and restore, not just copy new files with `dirs_exist_ok=True`.

## Goals

- Let users create, view, edit, disable, and soft-delete shared skills in the platform.
- Track the canonical user who created the skill and who created each internal revision.
- Support a complete portable skill directory, within explicit V1 size and file-type limits.
- Associate skills globally and with one or more repositories or environments.
- Let each user select All, None, or a personal named profile when starting a session.
- Give bot-created and automated sessions deterministic default behavior.
- Pin exact skill content to a session before sandbox startup.
- Materialize skills before OpenCode discovers them.
- Make the effective skill set and its provenance inspectable from the session.
- Preserve a clean path to user-facing version history, approval flows, Git import, and ACLs.

## Non-Goals

- Internal multi-team tenancy or role-based access control.
- Public or cross-installation skill marketplaces.
- Git-backed import, export, or bidirectional synchronization.
- User-facing version history, diffs, branches, tags, promotion channels, or rollback.
- Binary assets or arbitrary archive upload.
- Skill dependencies, package managers, hooks, MCP server creation, or secret declarations.
- Treating skill instructions as security policy.
- Updating skills during a running session.
- Automatically importing skills already committed in repositories.
- Evals, approvals, canary rollout, or usage-based quality scoring.
- Supporting agent hosts other than OpenCode in V1.

## Terminology

### Skill

A stable catalog entry with a globally unique Agent Skills `name`, display metadata, lifecycle
state, assignments, and a pointer to its current immutable revision.

### Revision

An immutable, content-addressed set of files produced on every successful content save. Revisions
are an implementation detail in V1, but session manifests reference them. Metadata-only edits such
as assignment changes do not create a content revision.

### Assignment

A statement that a skill applies to one target:

- `global`: every session, including repository-less sessions.
- `repository`: any session containing the exact repository.
- `environment`: only a session launched through that exact environment.

### Profile

A personal, reusable explicit set of skill IDs. A profile is not a copy of skill content and does
not make an otherwise unassigned skill applicable. At resolution time it filters the applicable set.
Personal profiles are visible and editable only by their owner in V1.

### Manifest

The canonical, immutable list of selected skill revisions for one session, plus content hashes, file
metadata, assignment provenance, profile choice, and resolver version.

## Product Experience

### Skills settings

Add a **Skills** category to Settings. The list view shows:

- display name and canonical skill name;
- description;
- enabled or disabled state;
- Global, repository, and environment assignment summaries;
- creator and last editor;
- last updated time;
- validation state.

The create/edit view has three tabs:

1. **Content**: structured fields for `name`, `description`, optional `license` and `compatibility`,
   a Markdown editor for the `SKILL.md` body, and a supporting-file tree.
2. **Assignments**: global toggle plus repository and environment multi-selects.
3. **Details**: creator, current revision digest, timestamps, validation output, disable, and delete
   actions.

The structured fields render the `SKILL.md` frontmatter rather than maintaining an independent
description that can drift. The server reparses the rendered file and returns field-level errors. An
advanced raw `SKILL.md` mode may be added later, but V1 should not provide two simultaneous sources
of truth.

The canonical skill name is immutable after creation and read-only in the edit view. Renaming would
change invocation identity and complicate repository collisions, profiles, and historical
provenance; V1 users create a replacement skill instead.

Supporting files use path-based create, rename, edit, and delete operations. The UI should suggest
the conventional `scripts/`, `references/`, and `assets/` directories without requiring them.
`SKILL.md` cannot be renamed or deleted.

Saving content creates a new internal revision and makes it current for newly created sessions.
Existing sessions retain their pinned revision. The UI states this explicitly.

### Profiles settings

Add a **Skill Profiles** section under Skills or the user settings area. Users can:

- create, rename, edit, and delete personal profiles;
- select an explicit set of shared skills;
- see each skill's assignments and whether it is currently disabled;
- see that a selected skill will only load when it also applies to the session target.

V1 profiles are personal because the requirement is user customization and the product has no
team-role model. Shared/admin-managed profiles can be added once ownership and ACL semantics exist.

### Session creation

Add a skill selector alongside target, model, and reasoning effort:

- **All applicable skills** is the default.
- **No managed skills** opts out of all managed skills.
- Personal profiles appear by name.

The selector displays a preview count after a target is selected. Changing the selection must
invalidate the web client's warmed pending session, just like changing the target or model. The
create-session request carries a discriminated choice, never an ambiguous nullable profile ID:

```ts
type SessionSkillSelection =
  | { mode: "all" }
  | { mode: "none" }
  | { mode: "profile"; profileId: string };
```

Bot, automation, Slack, Linear, and GitHub-created sessions use `{ mode: "all" }` unless their
server-side configuration gains an explicit profile later. A caller cannot select another user's
profile.

### Session visibility

The session details UI shows the pinned managed skills with:

- skill name and description;
- revision number and shortened digest;
- profile choice;
- assignment reasons such as Global, Environment: Production, or Repository: owner/name;
- installation status or startup error.

This is read-only provenance. Editing a catalog skill from this view affects only future sessions.

## Skill Format

V1 adopts the [Agent Skills specification](https://agentskills.io/specification):

```text
skill-name/
|-- SKILL.md
|-- scripts/       # optional
|-- references/    # optional
`-- assets/        # optional
```

`SKILL.md` contains YAML frontmatter followed by Markdown. V1 accepts the portable fields:

- `name` (required);
- `description` (required);
- `license` (optional);
- `compatibility` (optional);
- `metadata` (optional string-to-string map).

The standard's experimental `allowed-tools` field is rejected in V1. OpenCode does not document it
as a recognized skill field, and natural-language or skill metadata must not bypass OpenCode
permissions or sandbox controls. Host-specific Claude or Codex fields are also rejected so a skill
does not appear portable while silently behaving differently. The editor exposes `metadata` as a
string-to-string map. Shared validation enforces the standard's 1,024-character description limit
and 500-character compatibility limit.

Parse YAML with a safe schema. Reject custom tags, duplicate keys, and aliases rather than allowing
parser-dependent expansion or ambiguity. Render canonical frontmatter from the structured fields
before validation and hashing.

The standard name constraints become the canonical catalog constraints:

```text
^[a-z0-9]+(-[a-z0-9]+)*$
```

Names are 1 to 64 characters, match the skill directory, and are globally unique case-insensitively.
Runtime-bundled skill names are reserved and cannot be used by managed skills. The UI should
encourage an organization prefix for generic names, such as `acme-deploy`, to reduce collisions with
repository-authored skills.

### V1 content limits

Define each value once as a shared constant and use it in schemas, the UI, control plane, and
runtime:

| Limit                             | Proposed value |
| --------------------------------- | -------------: |
| Files per skill                   |            100 |
| Bytes per file                    |        256 KiB |
| Total bytes per revision          |          1 MiB |
| Path length                       |      240 bytes |
| Path depth below skill root       |    10 segments |
| Managed skills per session        |             20 |
| Total managed content per session |          5 MiB |

Only valid UTF-8 text files are accepted. This supports Markdown, source code, scripts, JSON, YAML,
and text templates while keeping D1 storage and JSON delivery bounded. Binary assets and archive
upload move to content-addressed R2 packages in a later phase.

The aggregate session limits are enforced by resolution preview and session creation. Resolution
returns a specific error and never truncates a profile or silently drops skills.

Paths must be normalized relative POSIX paths. Reject absolute paths, empty segments, `.`, `..`,
backslashes, NUL/control characters, duplicate normalized paths, symlinks, hard links, and reserved
platform paths. An `executable` bit may be set only for regular files under `scripts/`; it is stored
in the manifest and applied after writing.

## Assignment and Resolution Semantics

Resolution happens once in the control plane after repository/environment resolution and canonical
user resolution, but before the D1 session row and Durable Object are initialized.

### Applicable set

For an enabled skill, assignments are additive. It is applicable when any assignment matches:

- a global assignment always matches;
- a repository assignment matches any member of a scalar, list, or environment session;
- an environment assignment matches only when `environment_id` is that environment;
- no assignment means the skill is catalog-only and never automatically selected.

An environment session can match its environment assignment and assignments for any member
repository. The manifest retains every matching reason, not only the first. A repository-less
session can match only global assignments.

### Profile filter

After building the applicable set:

- `all` selects every applicable skill;
- `none` selects none;
- `profile` intersects the applicable set with the profile's explicit skill IDs.

Disabled or soft-deleted skills are excluded for new sessions even if referenced by a profile. A
profile reference to an inapplicable skill is ignored and reported in the preview; it is not an
error. This lets one profile work across several repositories without making its skills global.

The result is sorted by canonical skill name before hashing and persistence. Profiles do not define
prompt order because OpenCode exposes skills independently and loads them on demand.

### Conflicts

OpenCode requires discovered skill names to be unique but does not document a collision precedence
rule. The platform must not rely on filesystem location or copy order to select one.

At catalog write time, reject collisions with managed and bundled runtime names. At sandbox boot,
enumerate every effective discovery location supported by the pinned OpenCode version, currently the
project and global `.opencode/skills`, `.claude/skills`, and `.agents/skills` locations. Perform the
scan after multi-repository assembly, include bundled sources directly, and exclude the
platform-owned managed destination because a snapshot may contain this session's previous complete
tree. Reconcile that destination by manifest digest instead. If a selected managed skill has the
same canonical name as another discovered skill, fail startup with a diagnostic naming both sources.
Do not merge directories, overwrite files, or silently omit one skill.

Repository-to-repository skill conflicts already predate this feature and remain governed by the
current multi-repository assembly behavior. Normalizing that behavior is a separate change.

### Resolver pseudocode

```ts
const applicable = await listEnabledSkillsMatching({ repositories, environmentId });
const selectedIds =
  selection.mode === "all"
    ? new Set(applicable.map((skill) => skill.id))
    : selection.mode === "none"
      ? new Set()
      : await loadOwnedProfileSkillIds(userId, selection.profileId);

const resolved = applicable
  .filter((skill) => selectedIds.has(skill.id))
  .sort((a, b) => compareUtf8Bytes([a.name, a.id], [b.name, b.id]))
  .map((skill) => ({
    skillId: skill.id,
    revisionId: skill.currentRevisionId,
    name: skill.name,
    revisionSha256: skill.revisionSha256,
    assignmentSources: skill.matchingAssignments,
  }));
```

Use a singleton catalog-generation row to make the read consistent. Every skill, assignment, and
profile mutation increments the generation in the same D1 batch as its data changes. Resolution
reads the generation, loads all inputs, then reads the generation again. A mismatch retries from the
start with a bounded retry count. An equal before/after value proves the resolved set existed as one
database state. The immutable revisions and final manifest rows are then persisted in the same D1
batch as the session and repository snapshot so later catalog edits cannot alter the result.

Assignment generation updates are enforced by database triggers, rather than only by store methods,
because environment deletion can remove assignments through a foreign-key cascade. An environment
name update also increments generation when environment assignments reference it, since that display
name is copied into manifest provenance. The resolver filters candidate skills with a SQL `EXISTS`
over the bounded target repositories, then batches assignment hydration and retains the small
in-memory matching pass so every matching source is preserved without constructing JSON in SQL.

Agent-spawned child sessions copy the parent's pinned manifest and selection provenance verbatim;
they do not re-resolve mutable assignments or lose the parent's personal profile. This keeps a
subtask in the same effective environment even when its checkout target is one member of the
parent's multi-repository or environment session.

## Data Model

The following is logical DDL. Exact names and constraints should be finalized in the migration.
Managed-skill timestamps use Unix milliseconds and control-plane writes use `Date.now()`
consistently; the repository contains older tables with mixed timestamp units.

```sql
CREATE TABLE skills_catalog_state (
  singleton           INTEGER PRIMARY KEY CHECK(singleton = 1),
  generation          INTEGER NOT NULL
);

CREATE TABLE skills (
  id                  TEXT PRIMARY KEY,       -- skill_<opaque-id>
  name                TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  deleted_at          INTEGER,
  created_by          TEXT NOT NULL,
  updated_by          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  FOREIGN KEY(id, current_revision_id) REFERENCES skill_revisions(skill_id, id)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED
);
CREATE UNIQUE INDEX idx_skills_name ON skills(lower(name));

CREATE TABLE skill_revisions (
  id                  TEXT PRIMARY KEY,       -- skillrev_<opaque-id>
  skill_id            TEXT NOT NULL,
  revision_number     INTEGER NOT NULL,
  revision_sha256     TEXT NOT NULL,
  description         TEXT NOT NULL,
  license             TEXT,
  compatibility       TEXT,
  metadata_json       TEXT NOT NULL DEFAULT '{}',
  total_bytes         INTEGER NOT NULL,
  created_by          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  UNIQUE(skill_id, revision_number),
  UNIQUE(skill_id, id),
  FOREIGN KEY(skill_id) REFERENCES skills(id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE skill_revision_files (
  revision_id         TEXT NOT NULL,
  path                TEXT NOT NULL,
  content             BLOB NOT NULL,
  content_sha256      TEXT NOT NULL,
  size_bytes          INTEGER NOT NULL,
  executable          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(revision_id, path),
  FOREIGN KEY(revision_id) REFERENCES skill_revisions(id) ON DELETE CASCADE
);

CREATE TABLE skill_assignments (
  id                  TEXT PRIMARY KEY,
  skill_id            TEXT NOT NULL,
  scope_type          TEXT NOT NULL CHECK(scope_type IN ('global', 'repository', 'environment')),
  repo_owner          TEXT,
  repo_name           TEXT,
  environment_id      TEXT,
  created_by          TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE CASCADE,
  CHECK(
    (scope_type = 'global' AND repo_owner IS NULL AND repo_name IS NULL AND environment_id IS NULL)
    OR (scope_type = 'repository' AND repo_owner IS NOT NULL AND repo_name IS NOT NULL
        AND environment_id IS NULL)
    OR (scope_type = 'environment' AND repo_owner IS NULL AND repo_name IS NULL
        AND environment_id IS NOT NULL)
  )
);

CREATE TABLE skill_profiles (
  id                  TEXT PRIMARY KEY,       -- skillprof_<opaque-id>
  user_id             TEXT NOT NULL,
  name                TEXT NOT NULL,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE skill_profile_items (
  profile_id          TEXT NOT NULL,
  skill_id            TEXT NOT NULL,
  PRIMARY KEY(profile_id, skill_id),
  FOREIGN KEY(profile_id) REFERENCES skill_profiles(id) ON DELETE CASCADE,
  FOREIGN KEY(skill_id) REFERENCES skills(id)
);

CREATE TABLE session_skill_manifests (
  session_id          TEXT PRIMARY KEY,
  selection_mode      TEXT NOT NULL CHECK(selection_mode IN ('all', 'none', 'profile')),
  profile_id          TEXT,
  profile_name        TEXT,
  resolver_version    INTEGER NOT NULL,
  manifest_sha256     TEXT NOT NULL,
  resolved_at         INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  CHECK(
    (selection_mode = 'profile' AND profile_id IS NOT NULL AND profile_name IS NOT NULL)
    OR (selection_mode IN ('all', 'none') AND profile_id IS NULL AND profile_name IS NULL)
  )
);

CREATE TABLE session_skill_revisions (
  session_id          TEXT NOT NULL,
  position            INTEGER NOT NULL,
  skill_id            TEXT NOT NULL,
  revision_id         TEXT NOT NULL,
  skill_name          TEXT NOT NULL,
  revision_sha256     TEXT NOT NULL,
  assignment_sources  TEXT NOT NULL,          -- validated JSON
  PRIMARY KEY(session_id, skill_id),
  UNIQUE(session_id, position),
  FOREIGN KEY(session_id) REFERENCES session_skill_manifests(session_id) ON DELETE CASCADE,
  FOREIGN KEY(skill_id) REFERENCES skills(id) ON DELETE RESTRICT,
  FOREIGN KEY(revision_id) REFERENCES skill_revisions(id) ON DELETE RESTRICT
);
```

Add uniqueness indexes for each assignment shape because SQLite treats `NULL` values as distinct:

- one global row per skill;
- one case-normalized row per `(skill_id, repo_owner, repo_name)`;
- one row per `(skill_id, environment_id)`.

The composite deferred foreign key guarantees that `current_revision_id` exists and belongs to the
same skill while permitting atomic creation of the mutually linked first skill and revision.
`assignment_sources` snapshots assignment ID, target identity, and the display label used at
resolution. In particular, environment sources retain both `environmentId` and the historical
`environmentName` so later rename or deletion does not change session provenance.

`created_by` and `updated_by` logically reference `users.id`, but existing identity retention and
deletion policy should determine whether they use foreign keys. API responses resolve current user
display data and retain the opaque ID if the user record no longer exists.

Skill deletion is soft deletion. Revisions referenced by session manifests must remain available for
sandbox creation, restore, and provenance. A later garbage collector may remove unreferenced
revisions after a retention period, but it must never remove a revision referenced by a live or
retained session.

Although version history is not exposed in V1, immutable `skill_revisions` avoid a future breaking
migration and prevent a save racing with sandbox startup. A save equal to the current revision is a
no-op. Content equal to an older revision creates a new monotonic revision in V1; moving the current
pointer backward is reserved for the future rollback experience.

### Future tenant boundary

Do not add a nullable or constant fake `team_id` in V1. Keep all skill queries behind `SkillStore`
and profile queries behind `SkillProfileStore`, and pass an explicit authorization context to route
handlers. When real teams are introduced, add a non-null tenant key and backfill the installation's
resources into a default tenant. That migration must scope sessions, environments, repository
access, secrets, integrations, images, and skills together.

Future ACL operations should distinguish `read`, `use`, `edit`, `review`, `publish`, `assign`, and
`admin`. Permission to use a skill must not grant access to MCP servers, secrets, tools, or network
destinations mentioned by the skill.

## API Design

Define Zod schemas and response types in `@open-inspect/shared`. The web BFF proxies authenticated
browser requests and forwards no caller-asserted user IDs.

### Catalog APIs

| Method   | Path              | Purpose                                                                     |
| -------- | ----------------- | --------------------------------------------------------------------------- |
| `GET`    | `/skills`         | List active or disabled skills, assignments, authors, and current metadata. |
| `POST`   | `/skills`         | Create a skill, first revision, and initial assignments atomically.         |
| `GET`    | `/skills/:id`     | Read metadata, current files, assignments, and provenance.                  |
| `PATCH`  | `/skills/:id`     | Change enabled state or assignments without changing content.               |
| `PUT`    | `/skills/:id`     | Atomically edit content, enabled state, and assignments with `If-Match`.    |
| `DELETE` | `/skills/:id`     | Soft-delete and remove it from future resolution.                           |
| `POST`   | `/skills/preview` | Validate unsaved files without creating a revision.                         |

Use one content update containing the complete desired file tree. Full replacement makes deletion
unambiguous and allows the server to validate and hash one atomic revision. Reject `If-Match`
mismatches using the current revision ID to prevent one editor silently overwriting another.
`SKILL.md` must retain the skill's immutable canonical name.

### Profile APIs

| Method   | Path                      | Purpose                                               |
| -------- | ------------------------- | ----------------------------------------------------- |
| `GET`    | `/skill-profiles`         | List the authenticated user's profiles.               |
| `POST`   | `/skill-profiles`         | Create a personal profile and its explicit skill set. |
| `PATCH`  | `/skill-profiles/:id`     | Rename or replace selected skill IDs.                 |
| `DELETE` | `/skill-profiles/:id`     | Delete an owned profile.                              |
| `POST`   | `/skills/resolve-preview` | Preview effective skills for a target and selection.  |

Profile routes derive `user_id` from the principal. They return not found for another user's
profile, avoiding an ownership oracle that will complicate future authorization.

### Session API

Extend `CreateSessionRequest` with optional `skillSelection`; omission normalizes to
`{ mode: "all" }` for old clients. This is concrete backward compatibility for bot and web callers
that may deploy separately.

`POST /sessions` resolves skills and writes the session, repository snapshot, skill manifest, and
manifest entries in the existing D1-before-Durable-Object initialization path. If any selected
current revision is missing or invalid, session creation fails rather than pinning a partial set.
The same D1 batch owns all session snapshot rows. The separate agent-child spawn path copies the
parent's rows instead of running the resolver again.

Add `GET /sessions/:id/skills` for authenticated human-readable provenance.

### Sandbox API

Add a sandbox-authenticated endpoint:

```text
GET /sessions/:id/sandbox-skills
```

The session-specific sandbox bearer token, validated by the Session Durable Object, must
authenticate the request and bind it to exactly the same session ID. Internal HMAC service
authentication and human principals are rejected on this sandbox-only route. The response is a
narrow installation DTO containing the pinned manifest digest and bounded UTF-8 files:

```json
{
  "schemaVersion": 1,
  "manifestSha256": "...",
  "skills": [
    {
      "name": "acme-deploy",
      "files": [
        {
          "path": "SKILL.md",
          "content": "---\nname: acme-deploy\n...",
          "sha256": "...",
          "sizeBytes": 42,
          "executable": false
        }
      ]
    }
  ]
}
```

All integer fields in digest encodings are unsigned big-endian. `str(value)` means a 32-bit byte
length followed by the exact UTF-8 bytes. A SHA-256 field contributes its raw 32 bytes, not hex.

A revision encoding is the ASCII domain separator `OPEN_INSPECT_SKILL_REVISION_V1`, NUL, a 32-bit
file count, then each file sorted by UTF-8 path bytes. Each file contributes `str(path)`, one
executable byte (`0` or `1`), a 64-bit content length, and exact content bytes.

A manifest encoding is the ASCII domain separator `OPEN_INSPECT_SKILL_MANIFEST_V1`, NUL, a 32-bit
resolver version, one selection byte (`0` All, `1` None, `2` Profile), and, for Profile only,
`str(profileId)` and `str(profileName)`. It then contains a 32-bit skill count and skill entries
sorted by `(UTF-8 canonical name bytes, UTF-8 skill ID bytes)`. Each entry contributes
`str(skillId)`, `str(revisionId)`, `str(name)`, the raw revision digest, and a 32-bit assignment
count. Assignment sources are sorted by the UTF-8 byte tuple
`(type, assignmentId, repoOwner, repoName, environmentId, environmentName)` and contribute each of
those six values with `str`, using the empty string for fields not applicable to that source type.

The control plane owns the canonical provenance digest. The sandbox independently verifies every
delivered file's path, size, content hash, permissions, and generated `SKILL.md` identity.
Selection, revision metadata, and assignment provenance remain available from
`GET /sessions/:id/skills`. Return `ETag: "<manifestSha256>"` for diagnostics and future caching.

The response is intentionally not placed in `SESSION_CONFIG`, environment variables, or the Modal
create request. Content can exceed environment limits, executable instructions should not appear in
provider control logs, and a fetch endpoint works consistently across sandbox providers and
restores.

## Sandbox Materialization

Add a provider-neutral managed-skills component to `packages/sandbox-runtime`. It uses the existing
control-plane URL, session ID, and sandbox authentication token.

### Startup sequence

1. Complete repository boot and multi-repository `.opencode` assembly.
2. Request the pinned session manifest from the control plane.
3. Revalidate schema, names, paths, counts, sizes, UTF-8, and every file SHA-256 hash.
4. Scan all skill locations discovered by the pinned OpenCode version except the managed destination
   and reject selected-name collisions.
5. Build the complete managed tree in a temporary directory on the same filesystem.
6. Set executable bits only where the manifest permits; remove other write/execute bits as
   appropriate.
7. Install the managed tree with a journaled directory swap.
8. Start `opencode serve` only after materialization succeeds.

Use `OpenCodeServer._resolve_opencode_global_config_dir() / "skills"`, normally
`~/.config/opencode/skills`, for managed skills. This avoids changing a repository checkout and
works for single-repository, multi-repository, and repository-less sessions. The platform owns this
directory in its sandboxes; repository and bundled skills retain their existing project locations.

On snapshot restore, fetch and reinstall the session's same pinned manifest before OpenCode starts.
Replacing the complete managed directory removes stale files from prior snapshots and revisions.
Never refresh skills during a running OpenCode process or an OpenCode process restart.

The supervisor runs the async materializer once after repository boot and before the initial
`OpenCodeServer.start()`. Process-level OpenCode restarts reuse the installed tree without requiring
the control plane. Do not perform async HTTP by blocking the event loop.

### Atomicity

The destination and staging directory must share a filesystem. Write each file with exclusive
creation, verify its final hash, and fsync where supported. A normal POSIX rename cannot replace a
non-empty directory atomically, so use `renameat2(RENAME_EXCHANGE)` where the image and filesystem
support it. The portable fallback writes a single intent marker, renames the current directory to a
backup, renames staging to current, and removes the backup and marker. Every sandbox startup repairs
an interrupted journal before reading or installing skills. OpenCode is not running during this
sequence, so the fallback may have a transient missing destination but never exposes a partial tree
to the agent. Tests must cover a crash after each transition.

Because each session pins its own manifest, a last-known-good manifest from another session is not a
valid fallback. A restored snapshot may reuse its matching installed tree only after comparing the
stored and expected manifest digests.

## Security and Trust Model

Skills are untrusted executable supply-chain content even when their primary file is Markdown. The
agent can follow hidden instructions, run bundled scripts, read injected secrets, or send data over
the network using already-authorized tools.

V1 controls are:

- Require an authenticated admitted user for all authoring operations.
- Record creator and revision author from the verified principal, never the request body.
- Validate content server-side on preview and save and independently in the sandbox.
- Reject binary files, links, traversal, special files, invalid names, and oversized packages.
- Compute per-file and whole-revision SHA-256 digests.
- Authenticate sandbox downloads and bind the token to one session.
- Never include platform secrets in skill content or API responses.
- Do not interpret `allowed-tools` as an authorization grant.
- Keep OpenCode permissions, sandboxing, network policy, MCP authorization, and secret injection
  separate from skills.
- Fail closed when selected content cannot be verified or installed.
- Escape skill metadata in the UI and logs; never render authored Markdown as unsanitized HTML.
- Bound each request with file, revision, and session limits; V1 adds no feature-specific request
  throttle for admitted users.

Allowing every admitted user to modify installation-wide executable content follows the product's
current single-tenant trust model and is an explicit V1 risk acceptance, not an authorization
boundary. Deployments that do not trust every admitted user should keep the feature disabled until
operation-specific roles or an interim editor allowlist are designed.

The UI should show a persistent warning that skills may contain executable scripts and agent
instructions. Users must be able to inspect every file before saving. V1 does not claim malware or
prompt-injection detection; heuristic scanning would create false assurance. Future publication
workflows should add code review, secret scanning, static analysis, and evaluations.

Soft deletion stops future selection but does not stop an already-running session. A future
emergency-revocation feature may terminate or restart affected sessions, but that policy must be
explicit because mutating their skills in place would break reproducibility.

## Failure Handling

| Failure                               | Behavior                                                       |
| ------------------------------------- | -------------------------------------------------------------- |
| Invalid content save                  | Return field/path errors; keep the current revision unchanged. |
| Concurrent edit                       | Return `409 Conflict` with the new current revision ID.        |
| Profile deleted before session create | Return `404`; do not silently use All.                         |
| Skill disabled during resolution      | Omit it from new sessions.                                     |
| Revision changes after resolution     | Session uses the pinned old revision.                          |
| Missing pinned revision               | Fail session initialization and mark the session failed.       |
| Sandbox download auth failure         | Fail startup; do not start OpenCode without selected skills.   |
| Control-plane timeout                 | Retry with bounded exponential backoff, then fail startup.     |
| Manifest or file hash mismatch        | Delete staging content and fail startup.                       |
| Name collision                        | Fail startup with both sources and remediation guidance.       |
| Snapshot contains stale managed files | Replace the complete managed directory before startup.         |

Use a named TypeScript timeout constant in milliseconds and a Python timeout constant in seconds.
Define each default once. Sandbox download retries must fit inside the existing OpenCode startup
budget and surface a specific boot phase in session diagnostics.

## Observability and Audit

Emit structured events and metrics for:

- skill create, content revision, assignment update, enable/disable, and soft delete;
- profile create, update, and delete;
- manifest resolution count, duration, selection mode, and digest;
- bundle response bytes and duration;
- sandbox fetch, validation, collision scan, and installation duration;
- materialization failures grouped by stable error code;
- skill count and total bytes per manifest.

Do not log full skill content. Logs may contain IDs, canonical names, hashes, paths, sizes, user
IDs, and assignment types. Audit records should retain actor, action, target ID, previous/current
revision IDs, assignment changes, and timestamp. If a general audit-event facility is not introduced
in V1, the immutable revision author plus `created_by`/`updated_by` is the minimum; assignment
changes will not have complete history and this limitation should be documented.

## Testing Strategy

### Shared contracts

- Valid and invalid skill names and frontmatter.
- File path normalization, duplicates, size/count/depth boundaries, and executable constraints.
- Assignment discriminated unions, including nested repository owners.
- Session skill selection and backward-compatible default parsing.
- Manifest canonicalization and stable digest fixtures shared with Python.

Build `@open-inspect/shared` before dependent packages.

### Control plane unit tests

- Atomic skill creation and content replacement.
- Content-identical revision reuse.
- Optimistic concurrency conflict.
- Global, repository, environment, multi-repository, and repository-less matching.
- Profile ownership and intersection behavior.
- Disabled and deleted skill behavior.
- Stable ordering and assignment provenance.
- Catalog-generation retry under concurrent skill, assignment, and profile writes.
- Session pinning across later edits and deletion.
- Agent-spawned children copy the parent's exact manifest and provenance.
- Sandbox endpoint principal and session binding.
- Content and manifest hashing.

### Control plane integration tests

- Apply the D1 migration and include all new tables in shared cleanup.
- CRUD through authenticated routes against real D1.
- Session creation writes repositories and skill manifest consistently.
- Environment edits after session creation do not alter the manifest.
- Another sandbox cannot fetch a session's manifest.
- Revisions referenced by sessions survive catalog deletion.
- Existing create-session callers without `skillSelection` receive All behavior.

### Sandbox runtime tests

- Fetch and install occur before the OpenCode subprocess launches.
- Single-repository, multi-repository, and repository-less paths.
- Full companion-file tree and executable modes.
- Traversal, symlink-equivalent paths, invalid UTF-8, oversize, and digest rejection.
- Atomic replacement and cleanup after an interrupted staging write.
- Stale files disappear on snapshot restore.
- A matching installed digest can take the validated fast path.
- Managed/repository and managed/bundled name collisions fail clearly.
- Download retry, timeout, and authentication behavior.
- Python and TypeScript canonical digest fixtures produce identical values.

### Web tests

- Settings navigation and loading/error/empty states.
- Create, edit, validation, disable, and delete flows.
- Supporting-file operations and unsaved-change protection.
- Assignment selectors for repositories and environments.
- Profile ownership and selection.
- Effective-set preview.
- Session warming invalidation when skill selection changes.
- Creator/revision/session provenance rendering.

## Rollout Plan

### Phase 0: Format and runtime hardening

- Publish shared format and limit constants.
- Extract reusable skill parsing and manifest canonicalization.
- Add collision detection covering current bundled and repository skills.
- Fix sandbox-runtime deployment hashes so changes to bundled `SKILL.md` and companion files trigger
  provider updates; some provider Terraform hashes currently include only source-code extensions.

### Phase 1: Catalog and authoring

- Add D1 tables, stores, shared schemas, control-plane routes, web BFF routes, and settings UI.
- Support internal immutable revisions while showing only the current one.
- Record authorship and validate all content.

### Phase 2: Assignments, profiles, and preview

- Add global/repository/environment assignment editing.
- Add personal profiles and target-aware resolution preview.
- Extend session creation and warmed-session keys.
- Persist manifests but do not yet deliver them to production sandboxes.
- Compare preview/resolution output in staging and inspect collision rates and manifest sizes.

### Phase 3: Sandbox delivery

- Add the sandbox endpoint and runtime materializer across every supported provider.
- Enable for internal sessions first, then opt-in installations, then by default.
- Monitor boot failure rate, download latency, collision errors, and bytes per manifest.

### Phase 4: Governance and distribution

- Expose revision history, diff, rollback, and immutable release labels.
- Add draft/review/publish/promotion lifecycle and evaluations.
- Add Git import/export with source URL, commit SHA, and content digest provenance.
- Move large or binary packages to a dedicated R2 bucket.
- Add shared profiles, real team ownership, and operation-specific ACLs.
- Add signed packages, approval gates, emergency revocation, and staged rollout channels.

## Implementation Map

Expected code areas include:

| Tier         | Files or modules                                                                    |
| ------------ | ----------------------------------------------------------------------------------- |
| Shared       | `packages/shared/src/types/skills.ts`, session request schemas and exports          |
| D1           | New migration under `terraform/d1/migrations/`, integration cleanup                 |
| Stores       | `packages/control-plane/src/db/skills.ts`, `skill-profiles.ts`                      |
| Resolution   | `packages/control-plane/src/session/skill-resolution.ts`, session initialization    |
| Routes       | Human CRUD/profile/preview routes and sandbox installation route                    |
| Router/types | Route registration, `Env` only if storage bindings later change                     |
| Web BFF      | `/api/skills`, `/api/skill-profiles`, and preview proxies                           |
| Web UI       | Settings category, skill editor, profile editor, session selector, provenance panel |
| Runtime      | New `managed_skills.py`, `entrypoint.py`, `opencode_server.py` integration          |
| Providers    | No content wire field; verify all images contain the updated runtime                |
| Terraform    | Runtime source-hash coverage; dedicated R2 binding only in a later phase            |

No Modal-specific skill copying should be introduced. The control-plane endpoint and sandbox-runtime
materializer keep the feature provider-neutral.

## Alternatives Considered

### Store skills only in Git repositories

This gives familiar review and history but cannot supply repository-less sessions, requires
duplication for global workflows, makes environment-wide assignment awkward, and does not provide
personal profiles. Git import/export remains a valuable later source, not the only registry.

### Mutate one current skill without internal revisions

This is simpler schema-wise but creates a race between session creation and sandbox download. It
also makes restored sessions irreproducible and forces a larger migration when user-facing history
arrives. Internal immutable revisions are worth retaining even when hidden from V1 users.

### Put complete skills in `SESSION_CONFIG`

This threads potentially large executable content through provider request JSON and environment
variables, risks logging and size limits, and requires coordinated TypeScript/Python/provider wire
changes. A session-authenticated fetch is bounded, auditable, and provider-neutral.

### Push files into the sandbox after provider creation

The runtime starts immediately and can race the copy. Restore paths differ by provider. Fetching in
the runtime immediately before OpenCode gives one ordering invariant.

### Install into each repository's `.opencode/skills`

This dirties or requires excluding every checkout, duplicates content in multi-repository sessions,
and does not fit repository-less sessions. OpenCode's global skill location is the appropriate
managed location.

### Let nearest or latest source win name conflicts

OpenCode does not document a precedence rule for all discovered locations. Silent overwrite can
select different instructions than the UI preview and can merge companion files. Rejecting
collisions is safer and diagnosable.

### Make profiles copied bundles

Copying content into profiles creates drift, multiplies storage, obscures authorship, and makes
security fixes hard to propagate. Profiles should reference stable skill identities; sessions pin
the resulting revisions.

### Use R2 packages in V1

R2 is the better long-term home for binary and large content-addressed bundles, but bounded UTF-8
skill trees fit D1 and avoid new infrastructure, archive parsing, and lifecycle policy in V1. The
revision/file abstraction allows storage to move behind the store without changing assignments or
manifests.

### Introduce teams only for skills

This would not isolate repository access, environment secrets, sessions, integrations, or sandbox
downloads and would give users a false security expectation. True tenancy must be a product-wide
architecture change.

## Future Version Control

The internal revision model supports a future version-control experience without changing session
semantics. A later design should add:

- revision list, author, commit message, and file-by-file diff;
- rollback by moving `current_revision_id` to an existing immutable revision;
- draft versus published revisions;
- mutable channels such as staging and production that resolve to immutable revisions;
- source repository URL, branch/tag, commit SHA, subdirectory, and import digest;
- export as a standard skill directory or archive;
- protected promotion and approval actions;
- eval results linked to a revision;
- deterministic canary assignment and emergency revocation.

A session must always store the resolved revision ID and digest, never a moving channel such as
`latest`. Git sync must distinguish source commit, release version, and downloaded content digest.

## Product Validation

V1 deliberately chooses admitted-user editing, personal-only profiles, All for unconfigured bot and
automation sessions, bounded UTF-8 text packages, startup failure on name collision, and immediate
publication of each successful save. Deleted revisions are retained for at least as long as any
referencing session. Authorship survives user offboarding and does not make the skill part of the
departing user's data.

Before implementation, customer discovery should validate that the proposed 1 MiB per-skill and 5
MiB per-session limits cover initial use cases and that immediate publication is acceptable. If
binary templates, shared profiles, approval before publication, or a narrower editor population are
required for launch, this document must return to Draft because those changes affect storage,
ownership, and workflow rather than being incidental UI additions.

## Research Findings

The design follows recurring patterns from current agent products and configuration systems:

| Source                                                                                         | Relevant lesson                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Agent Skills specification](https://agentskills.io/specification)                             | A portable skill is a directory with `SKILL.md`, optional scripts/references/assets, constrained metadata, and progressive disclosure.                                    |
| [OpenCode skills](https://opencode.ai/docs/skills/)                                            | OpenCode discovers project and global skill locations, loads bodies on demand, supports skill permissions, and requires unique names.                                     |
| [Claude Code skills](https://code.claude.com/docs/en/skills)                                   | Enterprise, personal, project, and plugin scopes need explicit precedence; plugin namespacing prevents collisions.                                                        |
| [Anthropic Skills API](https://platform.claude.com/docs/en/build-with-claude/skills-guide)     | Workspace skills use immutable versions and allow requests to pin a concrete version.                                                                                     |
| [Codex skills](https://developers.openai.com/codex/build-skills)                               | Repository, user, admin, and system scopes are distinct; progressive disclosure prevents loading every full skill at startup.                                             |
| [GitHub Copilot skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills) | Skills are explicitly folders of instructions, scripts, and resources and can come from project and personal scopes.                                                      |
| [GitHub CLI skill management](https://cli.github.com/manual/gh_skill)                          | Distribution benefits from source refs, content digests, validation, and explicit pinning.                                                                                |
| [LangSmith prompt management](https://docs.langchain.com/langsmith/manage-prompts)             | Immutable commits plus movable environment tags support diff, promotion, and rollback; pinning the resolved commit for run provenance is an Open-Inspect inference.       |
| [PromptLayer registry](https://docs.promptlayer.com/features/prompt-registry)                  | Prompt changes benefit from release labels, approval controls, evaluations, and production attribution.                                                                   |
| [OPA bundles](https://www.openpolicyagent.org/docs/management-bundles)                         | OPA demonstrates authenticated distribution, optional signature/hash verification, activation reporting, and retaining the prior bundle after failed verified activation. |
| [SLSA build provenance](https://slsa.dev/spec/v1.2/build-provenance)                           | Artifact digests, resolved dependencies, builder identity, and invocation context are useful provenance primitives.                                                       |

These sources do not define Open-Inspect's product semantics. In particular, the Agent Skills
standard does not specify assignments, profiles, package transport, versions, provenance, or name
precedence. Those are platform decisions documented here.

Research was reviewed on August 14, 2026. External products evolve, so implementation should test
against the OpenCode version pinned in the sandbox image rather than assuming current online docs
match every deployed runtime.

## Related Open-Inspect Documentation

- [How It Works](../HOW_IT_WORKS.md)
- [Image Pre-Building](../IMAGE_PREBUILD.md)
- [Secrets](../SECRETS.md)
- [Session Snapshot Handoff ADR](../adr/0003-session-snapshot-handoff.md)
- [Modal Infrastructure](../../packages/modal-infra/README.md)
