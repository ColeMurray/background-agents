# Persistent session memory

Memory carries useful knowledge between sessions without changing repository files. It has no
embedding store or semantic search: the agent sees a compact fact catalog and reads relevant bodies
with `memory_read`.

## User experience

| Surface                    | Behavior                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Settings → Memories        | Manage your personal facts and directives, review proposals, edit, archive, restore, replace and inspect revision history.                                                     |
| Settings → Shared memories | Select a repository or environment. Readers see its catalog; authorized maintainers can manage it.                                                                             |
| Personal default           | **Include my personal memories in new sessions by default** is initially enabled. It applies to web, integration-created and scheduled sessions.                               |
| New-session composer       | Override the default with **Include my personal memories**. The preview shows selected counts, estimated tokens and omissions. Changing the selection replaces a warmed draft. |
| Session sidebar → Memories | Inspect pinned revisions, omitted records, estimates and subsequent edits/archives.                                                                                            |

Personal memories can be included in **shared sessions**. Included content may appear in responses
and be visible to collaborators. This does not give collaborators access to the owner's personal
settings catalog. Opting out excludes personal context and also denies personal reads and writes
through memory tools. Changing the default affects **new sessions only**; it cannot erase text
already supplied to an agent or included in a conversation.

### Facts, directives and approval

| Record                           | How it loads                                              | Agent-write policy                                                                                                         |
| -------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Personal fact                    | Title and description in the catalog; body read on demand | Active immediately only in a root session that has remained private and owner-only. Otherwise proposed for owner approval. |
| Personal directive               | Full content                                              | Proposed for owner approval.                                                                                               |
| Repository/environment fact      | Catalog; body on demand                                   | Proposed for maintainer approval.                                                                                          |
| Repository/environment directive | Full content                                              | Proposed for maintainer approval.                                                                                          |

Human-authored records are active immediately. Editing keeps the original record provenance and adds
a revision with the editor's identity. Rejected proposals are archived; restoring them returns them
to proposed status. Restoring an approved record returns it to active status. A replacement proposal
does **not** archive its predecessor until approval. Concurrent edits and decisions reject stale
revisions with HTTP 409.

Sandbox tools currently authenticate a session, not an immutable prompt author. For this reason,
automatic personal facts are disabled permanently once a session is shared or gains a collaborator,
even if it is later made private again. Children never auto-save personal facts. A child created by
a different participant cannot write to the inherited owner's personal scope.

## Architecture and implementation

| Layer            | Responsibility                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shared contracts | Strict scope/content/provenance schemas, record limits, manifest types and `memories.manage_own`.                                                                                                |
| D1               | Migration `0084_memories.sql`: records, immutable revisions, per-user default, session manifest headers and ordered revision references.                                                         |
| Memory store     | Atomic revision/supersession/status mutations, optimistic concurrency, per-session write quotas and content-free audit events.                                                                   |
| Resolver         | Canonical personal identity, ordered repositories, optional environment, deterministic selection and whole-record truncation.                                                                    |
| Session creation | Save the resolved manifest in the same database transaction as the session index, before sandbox warming. Schedulers use the execution owner's default. Children copy the parent's selection.    |
| Runtime boot     | Fetch the installation using the sandbox's session-bound bearer token, clear stale restored content, then atomically write owner-readable `oi-memory.md` in the harness configuration directory. |
| OpenCode         | Add the memory file to `instructions`; expose `memory_read` and `memory_write` custom tools.                                                                                                     |
| Claude           | Append the same file text to repository guidance; expose both tools through the existing SDK MCP server.                                                                                         |
| Web              | Cookie-authenticated proxy routes, owner/shared management pages, composer toggle/preview and session diagnostics.                                                                               |

No project scope, embeddings, automatic memory search, repository writes or new infrastructure
services are required. Memory estimates are available on the session manifest; a broader
per-component context-snapshot feature is not introduced here.

### Pinning and live reads

Memory boot requires runtime v74 or later for either harness. The runtime/rebuild floors reject
pre-memory repository images. Restores remove old context and abandoned staging files before
fetching; new content is installed through a unique exclusive 0600 file and atomic replacement.

- Directives and catalog entries use **pinned revisions** for the session's lifetime, including
  sandbox restarts and restores. A child copies the same selection and personal owner, not the
  spawning participant's personal catalog.
- `memory_read` returns the **current** fact body and provenance. A pinned archived record returns
  only its archive notice. Proposals, unpinned archives, and directives cannot be expanded by
  sandbox tools.
- A top-level session may directly read an active fact in its authorized scopes even if budget
  truncation omitted it. An inherited child cannot expand into unpinned personal records.
- Editing or archiving does not rewrite an existing session's injected text. New sessions resolve
  from current active records.
- The selection hash covers the ordered record/revision/inclusion tuples and the personal selection
  flag. User aliases can be merged without changing the pinned selection hash.

### Limits and ordering

| Limit                               |                                                    Value |
| ----------------------------------- | -------------------------------------------------------: |
| Title                               |                                           200 characters |
| Description                         |                                        10–420 characters |
| Directive body                      |                                         2,000 characters |
| Fact body                           |                                        20,000 characters |
| Directives per scope / overall      |   6,000 / 12,000 body characters; at most 100 directives |
| Fact catalog                        | 24,000 title+description characters, at most 200 entries |
| Rendered boot context               |             240,000 characters including labels/escaping |
| Management page                     |                       50 records by default, at most 100 |
| Accepted agent writes per session   |              20, including subsequently archived records |
| Pending agent proposals per session |                                                        5 |

Scope priority is environment, repositories in session order, then personal. Directives are oldest
first; facts are most recently updated first; IDs break timestamp ties. Records beyond a budget are
omitted whole and counted in aggregate; only selected items are persisted. Candidate queries are
bounded per scope/type and never fetch fact bodies. Token estimates use rendered text length / 4,
including labels and framing; they are estimates, not provider-measured token counts.

## API

All human memory responses are private/non-cacheable. Identity comes from authentication, never a
request body. Repository management uses existing repository permissions and team grants;
environment management uses existing ownership/management authorization. Personal management is
owner-only, including when the caller is another administrator.

| Method and path                                           | Purpose                                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /memories?scope=...&status=...&offset=...&limit=...` | Page through one scope (`personal`, `repository`, or `environment`) and status (`active`, `proposed`, or `archived`). Repository scope also takes `repoOwner` and `repoName`; environment takes `environmentId`. `nextOffset` is null at the last page. |
| `POST /memories`                                          | Create or propose a replacement via `supersedesMemoryId`.                                                                                                                                                                                               |
| `GET /memories/:id`                                       | Current record and server-calculated management capabilities.                                                                                                                                                                                           |
| `PATCH /memories/:id`                                     | Revise with `expectedRevisionId`.                                                                                                                                                                                                                       |
| `GET /memories/:id/revisions`                             | Immutable revision history.                                                                                                                                                                                                                             |
| `POST /memories/:id/{action}`                             | `archive`, `restore`, `approve`, or `reject` with `expectedRevisionId`; archive accepts an optional reason.                                                                                                                                             |
| `POST /memories/preview`                                  | Resolve a target for the current user without creating a session.                                                                                                                                                                                       |
| `GET, PUT /memory-preferences`                            | Read/save the current user's personal inclusion default.                                                                                                                                                                                                |
| `GET /sessions/:id/memories`                              | Session-readable pinned diagnostics.                                                                                                                                                                                                                    |
| `GET /sessions/:id/sandbox-memory`                        | Sandbox-bound rendered installation.                                                                                                                                                                                                                    |
| `GET /sessions/:id/sandbox-memory/:memoryId`              | Sandbox-bound live read.                                                                                                                                                                                                                                |
| `POST /sessions/:id/sandbox-memory`                       | Sandbox-bound agent write with scope/approval/quota checks.                                                                                                                                                                                             |

Sandbox routes reject credentials belonging to another session and recheck current workspace/team
repository grants and environment ownership. Agent inserts repeat these checks atomically and
require an active owner and a live (`created`/`active`) session; settled sessions must be
reactivated by a fresh prompt before writing. Repository identities require a stable ID; legacy
null-ID memories fail closed rather than becoming accessible when a name is reused. Audits record
record/revision/status/actor/session IDs, never memory content or private archive-reason text. Scope
identifiers are retained after target deletion to preserve historical manifests. There is no
hard-delete endpoint. Restoring an approved memory is allowed only when its entire replacement
family has no active record.

## Local verification

Use Node 24; build shared before dependent TypeScript checks. Run heavyweight checks sequentially.
No Cloudflare, Modal or model-provider credentials are needed for these tests.

```bash
npm ci
npm run build -w @open-inspect/shared
npm test -w @open-inspect/shared -- --maxWorkers=1
npm test -w @open-inspect/control-plane -- --maxWorkers=1
npm run test:integration -w @open-inspect/control-plane -- \
  test/integration/memories.test.ts \
  test/integration/memories-routes.test.ts \
  test/integration/memories-access.test.ts --maxWorkers=1
npm test -w @open-inspect/web -- --maxWorkers=1
npm run typecheck -w @open-inspect/control-plane -w @open-inspect/web
npm run lint:sql-portability

cd packages/sandbox-runtime
uv sync --frozen --extra dev --python 3.12
# A short disposable temp path avoids macOS Unix-socket path-length failures.
uv run --frozen --extra dev pytest tests --basetemp=/tmp/oi-memory-pytest
OPENCODE_TEST_BINARY=/path/to/opencode-1.18.29 \
  uv run --frozen --extra dev pytest tests/test_opencode_reasoning_contract.py -k memory_text
```

The optional binary test uses isolated configuration, synthetic credentials and a localhost fake
provider. It verifies actual OpenCode prompt/tool serialization, not a real model's behavior.

## Rollout and failure behavior

1. Apply migration 0084 with the existing D1/Node migration mechanism.
2. Deploy the control plane. Existing sessions without a manifest receive empty memory context; they
   are not retroactively resolved. No new Durable Object binding is needed.
3. Rebuild/deploy the sandbox runtime image, then deploy the web app. Both harnesses must use the
   updated runtime to gain the tools and boot phase.
4. In a disposable session, create a personal directive and fact, verify the preview and loaded
   diagnostics, exercise read/write/approval, then repeat with personal inclusion disabled and with
   a child session. Verify restore and archived-read behavior before broad rollout.

An old control plane returning 404 produces empty memory, clearing stale files. Transient fetch
errors retry a bounded number of times. Unauthorized, malformed or exhausted fetches fail the
`memory` boot phase before the harness starts. A failed database transaction creates neither orphan
revisions nor successful domain audit records. Rollback application code without dropping the memory
tables; already-injected text cannot be revoked from a running conversation.

Local tests are not evidence of deployed Cloudflare or Modal behavior. Deployment/provider canaries
remain a separate rollout gate.
