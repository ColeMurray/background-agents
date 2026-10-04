# Persistent session memory

Memory carries useful knowledge between sessions without changing repository files. It has no
embedding store or semantic search: the agent sees a compact fact catalog, discovers additional
facts with lexical `memory_search`, and reads relevant bodies with `memory_read`.

## User experience

| Surface                    | Behavior                                                                                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Settings → Memories        | Manage your personal facts and directives, review proposals, edit, archive, restore, supersede, revert to an earlier revision and inspect history.                             |
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

| Layer            | Where                                                                       | Responsibility                                                                                                                                                                                                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shared contracts | `packages/shared/src/types/memories.ts`, `memory-tools.ts`                  | Wire schemas (management DTOs, selection summaries, sandbox requests/responses), limits, scope helpers, the lifecycle transition table and the agent tool definitions. `memories.manage_own`.                                                                                                                                         |
| Domain           | `control-plane/src/memory/`                                                 | Partitions (identity only; records carry a separate display `scope`), selection and budget, rendering, initial status, DTO projection, `SessionMemorySelector` for new sessions and `SessionMemoryService` for agent operations. Services receive their stores through constructors; `*-factory.ts` modules and routes wire D1.       |
| Access policy    | `control-plane/src/authorization/memory-access.ts`                          | `MemoryManagementPolicy` for humans and `SessionMemoryAccessPolicy` for session principals, both returning typed decisions with stores injected; `memory-access-factory.ts` wires D1.                                                                                                                                                 |
| Stores           | `control-plane/src/db/memory-records.ts`, `session-memory-selections.ts`, … | SQL only: revisioned records and lifecycle, pinned selections, preferences, lexical fact search and the commit-time agent write guard. Queries are built with the `sql` fragment template.                                                                                                                                            |
| D1               | Migration `0084_memories.sql`                                               | Records keyed by typed identity columns (`owner_user_id` — a foreign key to `users` — `repo_id` or `environment_id`, exactly one per `partition_type`) with a generated, indexed `partition_key`; repository names are display-only. Immutable revisions, per-user default, session manifest headers and ordered revision references. |
| Session creation | `routes/session-create.ts`, scheduler, child spawn                          | Select and pin the session's memories in the session insert's transaction (`Pinned<T>`: resolved for roots, inherited by children). Schedulers use the execution owner's default.                                                                                                                                                     |
| Runtime boot     | `sandbox-runtime/src/sandbox_runtime/memories.py`                           | Fetch the rendered memory with the session-bound token, clear stale restored content, then atomically write owner-readable `oi-memory.md` in the harness configuration directory.                                                                                                                                                     |
| Harness tools    | `tools/_memory.js`, `harness/memory_tools.py`                               | Both harnesses build `memory_read`, `memory_search` and `memory_write` from the generated specs and forward arguments verbatim. OpenCode reads the file via `instructions`; Claude appends it.                                                                                                                                        |
| Web              | `web/src/hooks/use-memories.ts`, `components/settings/memories-settings/`   | Typed queries and mutations (revision fencing via `If-Match`), owner/shared management pages, composer control/preview and session diagnostics.                                                                                                                                                                                       |

### Extending memory

- **A new scope** (for example, team): add it to `MEMORY_SCOPE_TYPES` and `memoryScopeSchema`, then
  follow the compiler — every switch over scopes and partitions is exhaustive (`partition.ts`,
  `sources.ts`, `memory-access.ts`, the write guard, the shared scope helpers and the web settings
  link). Storage needs one typed identity column (for example, `team_id` with its foreign key),
  added to the `partition_key` expression and the check constraint; the indexes are unchanged.
- **A new lifecycle action or state:** add an entry to `MEMORY_TRANSITIONS`; the store, routes, DTO
  capabilities and web action buttons all derive from it.
- **A new agent tool:** add it to `MEMORY_TOOLS` in `packages/shared/src/memory-tools.ts`, run
  `npm run generate:memory-contract -w @open-inspect/shared`, and add a four-line OpenCode wrapper
  in `tools/`. The Claude harness picks it up from the generated JSON. A shared test fails when the
  generated artifacts are stale.
- **Selection semantics:** bump `MEMORY_SELECTION_VERSION`. It is provenance only; loaders never
  branch on it, and rendering always uses the current format with its own hard limit, so existing
  sessions keep booting.

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
  only its archive notice (`archiveKind`, `archivedAt`, `archiveNote`). Proposals, unpinned
  archives, and directives cannot be expanded by sandbox tools.
- A top-level session may directly read an active fact in its authorized scopes even if budget
  limits omitted it. An inherited child cannot expand into unpinned personal records.
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
| `POST /memories`                                          | Create a memory, optionally superseding an active one via `supersedesMemoryId`; the superseded record lists it in `supersededByMemoryIds`.                                                                                                              |
| `GET /memories/:id`                                       | Current record and server-calculated management capabilities.                                                                                                                                                                                           |
| `PATCH /memories/:id`                                     | Revise content; `If-Match: <currentRevisionId>` is required (428 when missing, 409 when stale).                                                                                                                                                         |
| `GET /memories/:id/revisions`                             | Immutable revision history.                                                                                                                                                                                                                             |
| `POST /memories/:id/{action}`                             | `approve`, `reject`, `archive`, or `restore` with `If-Match`; only `archive` and `reject` accept an optional `archiveNote`. Transitions follow `MEMORY_TRANSITIONS`.                                                                                    |
| `POST /memories/preview`                                  | Summarize the selection a new session would pin (items, sizes, omissions), without creating it.                                                                                                                                                         |
| `GET, PUT /memory-preferences`                            | Read/save the current user's personal inclusion default.                                                                                                                                                                                                |
| `GET /sessions/:id/memories`                              | The pinned selection summary with per-item drift, readable with the session.                                                                                                                                                                            |
| `GET /sessions/:id/sandbox-memory`                        | The session's rendered memory (boot context), sandbox-bound.                                                                                                                                                                                            |
| `GET /sessions/:id/sandbox-memory/:memoryId`              | Sandbox-bound live read.                                                                                                                                                                                                                                |
| `POST /sessions/:id/sandbox-memory`                       | Sandbox-bound agent write with scope/approval/quota checks.                                                                                                                                                                                             |
| `POST /sessions/:id/sandbox-memory/search`                | Session-authorized lexical discovery of active current facts, including records outside the boot catalog.                                                                                                                                               |

Sandbox routes reject credentials belonging to another session and recheck current workspace/team
repository grants and environment ownership on every boot render, read, search and write. Agent
inserts additionally enforce, atomically, the facts about the writing session: an active owner, a
live (`created`/`active`) session that still reaches the target partition, personal auto-save
eligibility, quotas and the replacement predecessor. Settled sessions must be reactivated by a fresh
prompt before writing. Grant rules are deliberately not duplicated in that SQL guard: a grant
revoked in the milliseconds between the route check and the insert can leave a shared-scope
_proposal_, which every later read denies and a human must approve. Repository memories are keyed by
the stable repository ID, so a reused name never inherits them and a renamed repository keeps them.
Record-level management (read, edit, history, lifecycle actions) authorizes the stored partition
identity directly and never resolves a record through its display names. Browser responses for
previews and session status carry a selection summary only, never the personal owner or hash.

New sessions never fail because of memory: `SessionMemorySelector` omits repositories or an
environment that the session principal cannot read from the selection, and session admission remains
`authorizeSessionTarget`'s job. Audits record record/revision/status/actor/session IDs, never memory
content or private archive-note text. Scope identifiers are retained after target deletion to
preserve historical manifests. There is no hard-delete endpoint. Restoring an approved memory is
allowed only when its entire replacement family has no active record.

### Agent write destinations

`memory_write` uses session-relative scopes. The control plane derives the personal owner, the sole
repository, or the associated environment from the authenticated session:

```javascript
memory_write({
  scopeType: "repository", // Or "personal" / "environment"
  memoryType: "fact",
  title: "Integration test setup",
  description: "Database preparation required before the integration suite.",
  content: "Start Postgres and apply test migrations before running integration tests.",
});
```

For a multi-repository session, add **both** `repoOwner` and `repoName` to select a member
repository. This applies to ad-hoc sets and environment-backed sessions alike. Omitting the selector
returns HTTP 400 with the available repository names; the server never silently defaults to the
primary repository. An explicit non-member, absent environment/repository, or repository without a
stable ID is denied. Sandbox writes do not accept `environmentId`; environment identity is always
derived from the session. Human management APIs still require explicit repository/environment
identities.

Both harnesses forward the tool arguments unchanged to `POST /sessions/:id/sandbox-memory`; the
endpoint's request schema is the tool input schema (`sandboxMemoryWriteSchema`), so `scopeType` is
`"repository"`, `"environment"`, or `"personal"` and an explicit selector is the top-level
`repoOwner`/`repoName` pair. The server resolves a complete scope before performing the existing
current-access and commit-time checks. Inference does not change approval, opt-out, quotas,
replacement rules, or pinned context.

## Local verification

### Searching beyond the catalog

Both harnesses expose `memory_search`. It discovers **current active facts**, not directives,
proposals, archives, or historical revision text. Search results contain IDs, revision IDs, scope
labels, titles and descriptions; call `memory_read` for the body.

```javascript
memory_search({ query: "billing webhook deduplication", scopeType: "repository", limit: 10 });
```

Omit `scopeType` to search permitted session scopes. Repository scope searches all attached
repositories; optionally supply both `repoOwner` and `repoName` to select one. Personal owner and
environment identity are derived from the session. Personal opt-out excludes personal results, and
inherited children can discover only their pinned personal memory IDs. Selected shared scopes are
authorized before the query and checked again before returning results.

Queries are literal whitespace-separated keywords: every term must occur in the current title,
description or body. Matching uses SQLite's ASCII case folding; it provides no stemming, synonyms,
semantic similarity or wildcard/query-language syntax. SQL wildcard characters are escaped. Per-term
title matches score 5, description matches 3, and body matches 1; the strongest field match for each
term is summed. Updated time and memory ID break ties. SQL matches and ranks before limiting, across
the full applicable fact store rather than the latest 200 records.

Queries are 2–256 characters with at most eight distinct terms. Results default to 10, max out at
20, and fit a 24,000-character serialized response budget. `hasMore` signals that the agent should
refine its query. There is no pagination or unrestricted browsing endpoint. Empty memory context
does not remove the search tool, and searching does not alter the session's pinned context.

Search sits behind the `FactSearchIndex` port (`memory/fact-search.ts`): the session service builds
an engine-independent `FactQuery` from authorized partitions and shapes the bounded response, and
`LexicalFactIndex` answers it with one escaped-`LIKE` statement ranked in SQL by
`FACT_SEARCH_FIELDS`. A different engine (Postgres full-text search, embeddings) is another adapter;
no migration or new service is needed today. Body matching still scans text; bounded results do not
guarantee constant query cost. The opt-in Node SQLite benchmark records query plans and
rare/broad-query timings at 1,000 and 10,000 facts with representative and maximum-size bodies:

```bash
MEMORY_SEARCH_BENCHMARK=1 MEMORY_SEARCH_BENCHMARK_OUTPUT=/tmp/memory-search-benchmark.json \
  npm test -w @open-inspect/control-plane -- \
  src/db/lexical-fact-index.test.ts --maxWorkers=1
```

These local measurements are not deployed D1 latency or provider-canary proof. Indexed lexical
search and semantic retrieval remain separate follow-ups if corpus size or measured cost demands
them.

### Test commands

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
  test/integration/memories-access.test.ts \
  test/integration/memories-search.test.ts --maxWorkers=1
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
