# PI-DEVIATIONS-AUDIT — the open (D) boundary deviations

Branch: `feat/pi-deviations`, off `feat/pi-go-live-integration-v2`.

The base moved twice while this work was in flight — the Agents SDK 0.28.1 → 0.29.0 upgrade, then a
merge of `origin/main` and the D1 migration renumbering — and this branch was rebased onto the tip
both times (`d365dc05`), then merged into `feat/pi-go-live-integration-v2` as `cd1c5554`.

**Every `file:line` below was re-verified against the merged tree** (`619b2c81`, the tip at the time
of this follow-up, which carries the MCP OAuth lifecycle and the Pi memory tools on top of the
merge). The tree has moved on since; a reader who finds a line off by a few should take the symbol
name as the anchor.

Scope: the (D) boundary deviations D4–D8 of [`PI-INTEGRATION-AUDIT.md`](PI-INTEGRATION-AUDIT.md).
D1, D2 and D3 were already closed and were not touched.

**Outcome in one line:** D5, D6, D7 and D8 are fixed. D4 is reported, not changed: separating the Pi
Durable Object's three table families is a design decision, and the task forbade inventing it.

---

## 1. What I verified before I changed anything

Every citation in the audit's (D) section was re-read against this tree. The audit is accurate about
the _shape_ of every deviation and about three of the five items' details; three details are wrong,
and they are listed in §7.

| The audit says                                                                                                                 | Verified at                                                                                                                                                                                                                                                                                                                                                       | Verdict                                           |
| ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| D5: the outboxes create their tables with `CREATE TABLE IF NOT EXISTS` at construction                                         | `packages/control-plane/src/pi/projection-outbox.ts` (was `:17-37`, `:257-258`), `packages/control-plane/src/pi/repository-diff-outbox.ts` (was `:10-21`, `:268`)                                                                                                                                                                                                 | **true**                                          |
| D5: the SessionDO's registry "does track the Pi migrations by id"                                                              | `packages/control-plane/src/session/schema.ts:1107-1130` (`applyMigrations`), `:1135-1141` (`initSchema`), `packages/shared/src/pi-migration-reservations.ts`                                                                                                                                                                                                     | **true, but for the wrong store** — see §7.1      |
| D6: delete is honoured; archive and export are not                                                                             | delete: `packages/control-plane/src/routes/session-index.ts:460-481` → `packages/control-plane/src/cloudflare/pi-durable-object.ts:1432` (`destroy`, `deleteAll` at `:1478`); archive: `packages/control-plane/src/session/http/handlers/session-lifecycle.handler.ts:155-191`; export: `packages/control-plane/src/routes/session-export.ts:122-140`, `:356-377` | **true**                                          |
| D6: the export is D1-only                                                                                                      | `packages/control-plane/src/db/session-export-store.ts:120-139`, `packages/control-plane/src/session/services/message.service.ts:216-272`                                                                                                                                                                                                                         | **true**                                          |
| D6: the Pi DO has a read surface (`lookup`, `status`)                                                                          | `packages/control-plane/src/cloudflare/pi-runtime-dispatch.ts:23-25`                                                                                                                                                                                                                                                                                              | **true, and it is not the transcript** — see §7.2 |
| D7: `mcp_read` accepts either a `connectionId` or a `serverId`                                                                 | `packages/control-plane/src/pi/mcp-extension.ts` (was `:63-75`), `packages/shared/src/types/mcp-read.ts:111-133`                                                                                                                                                                                                                                                  | **true**                                          |
| D7: the shared lane uses the deployment's credential and the session's `repo_scope`; the personal lane uses one person's OAuth | `packages/control-plane/src/session/http/handlers/mcp-session.handler.ts:219-325` (shared), `:327-420` (personal)                                                                                                                                                                                                                                                 | **true**                                          |
| D8: the Pi control route requires `collaborate` for the write actions                                                          | `packages/control-plane/src/routes/pi-controls.ts:101-108` (the two gates; the action sets were `:45-46` before this change)                                                                                                                                                                                                                                      | **half true** — see §7.3                          |
| D4: three table families share one SQLite database inside `PiSessionDO`                                                        | see §6                                                                                                                                                                                                                                                                                                                                                            | **true**                                          |

---

## 2. D5 — the outbox tables are tracked migrations now

**Fixed.** The Pi Durable Object's own tables are created by a numbered, forward-only migration
registry, in the same shape as the Session Durable Object's, and the outboxes assert that their
tables exist rather than creating them.

### What changed

- **New: `packages/control-plane/src/pi/schema.ts`.** The Pi Durable Object's own schema: the three
  table definitions, the migration registry (`PI_DO_MIGRATIONS`), `applyPiDoMigrations(sql)`, and
  `assertPiDoTables(sql, ...names)`.
- `packages/shared/src/pi-migration-reservations.ts`: a third migration store, `"pi_do"`, with
  `PI_DO_OUTBOX_MIGRATION_ID = 1` and `PI_DO_REPOSITORY_DIFF_OUTBOX_MIGRATION_ID = 2`, reserved for
  `piProjection` and `repositoryEditing`.
- `packages/control-plane/src/cloudflare/pi-durable-object.ts:274-281`: the constructor applies the
  migrations once per activation, before any writer can reach a table.
- `packages/control-plane/src/pi/projection-outbox.ts` and
  `packages/control-plane/src/pi/repository-diff-outbox.ts`: the runtime
  `CREATE TABLE IF NOT EXISTS` is gone; both outboxes now call `assertPiDoTables` and fail with "its
  migrations did not run" when the deployment did not migrate.

### Why a second registry, and not the SessionDO's

The SessionDO's registry is applied to the **SessionDO's** database
(`packages/control-plane/src/cloudflare/durable-object.ts:11`, `:58` →
`initSchema(this.platform.storage.sql)`). The outbox tables are in the **Pi Durable Object's**
database (`packages/control-plane/src/cloudflare/pi-durable-object.ts:315-320`,
`this.ctx.storage.sql`). Moving the tables into the SessionDO's database would move their _writer_ —
the Pi DO projects its own events, and the projection outbox exists so that a delivery failure keeps
the event queued on the side that produced it. That is a design change, not a migration, and §7.1
explains why I did not make it.

The new registry follows the repo's pattern exactly: numbered ids, an `_schema_migrations` tracking
table, `runMigration` swallowing only "duplicate column"/"already exists", string migrations run
through `runMigration` and function migrations required to be idempotent
(`packages/control-plane/src/session/schema.ts:459-473` for the `SchemaMigration` shape,
`:1086-1130` for the runner).

### Compatibility

The DDL is byte-identical to what the runtime used to create, so a database written by the old code
migrates cleanly: `CREATE TABLE IF NOT EXISTS` finds the table and does nothing
(`packages/control-plane/src/pi/schema.test.ts`, "leaves an already migrated database's tables
intact").

### Tests

`packages/control-plane/src/pi/schema.test.ts` (new, 8 tests): the registry's ids are unique,
reserved and increasing; the migration creates the three tables and records what it applied;
applying twice changes nothing; an already migrated database keeps its tables; a missing table is
refused; both outboxes refuse to work against a database that did not migrate and work against one
that did. The two existing outbox suites were updated to apply the migrations first.

---

## 3. D6 — the export says what it does not carry, and the archive preserves the record

**Fixed, option (b).** The export states plainly that a Pi session's own durable record is not in
it, and the archive path now reaches the Pi Durable Object, which preserves its record.

### Why (b) and not (a)

The task offered (a) "extend the export with the Pi Durable Object's own read surface (there is one
— `lookup` and `status` on `packages/control-plane/src/cloudflare/pi-runtime-dispatch.ts:23-25`)"
and (b) "state plainly in the export response that Pi-native state is not included AND add a
preservation step to the archive path", and asked me to choose "by what the repo's existing export
contract allows".

**The existing export contract does not allow (a) as the audit describes it.**

- The export's carrier is one NDJSON line per session
  (`packages/shared/src/types/trace-export.ts:60-99`), holding the D1 index projection plus at most
  three trace collections read from the **SessionDO's** own storage
  (`packages/control-plane/src/session/contracts.ts:31-52`,
  `packages/control-plane/src/session/services/message.service.ts:216-272`). There is no carrier for
  a second object's state, and adding one is a new shared schema field plus a new collection in
  `sessionTraceIncludeSchema` — a contract change, not a wiring change.
- The Pi DO's read surface the audit names is not the transcript. `lookup` returns one operation's
  status (`packages/control-plane/src/cloudflare/pi-durable-object.ts:954-975`) and `status` returns
  `{busy, pending}` (`:931-938`). The transcript and the task graph are reachable through the Pi
  DO's _control_ read actions — `list_conversations` (`:943`), `inspect` (`:962`), `task_graph`
  (`:977`), `get_conversation` (`:1004`) — and `get_conversation` returns only entry ids and kinds
  (`:1004-1018`), **not** the transcript content. So (a) would need a _new_ Pi-side read surface
  that returns the transcript, plus a decision about bounds and about whether model-written VFS
  bytes belong in a trace export at all. That is a new primitive, and the task says to stop and
  report rather than invent one.

So: (b). It is the outcome that can be implemented without inventing a primitive, and it satisfies
the hard requirement — an export never looks complete while omitting the agent's durable record.

### What changed

**The export states the gap.** `packages/shared/src/types/trace-export.ts`: a new
`traceExportHarnessStateSchema` (`{included: false, reason: string}`) on the session line, plus
`PI_HARNESS_STATE_NOT_EXPORTED`, the Pi Durable Object's own words about what it keeps.
`packages/control-plane/src/routes/session-export.ts:122-134`: a Pi session line carries
`harnessState`; no other harness does. The published JSON Schema was regenerated
(`docs/schemas/trace-export.v2.schema.json`) and `docs/TRACE_EXPORT.md` documents the field. The
field is **additive inside schema 2** — the doc's own rule is "Additive fields can arrive within a
major schema version; consumers must ignore unknown fields" (`docs/TRACE_EXPORT.md:124-131`) — so
the schema version did not change.

**The archive preserves the record.** `packages/control-plane/src/pi/runtime-contract.ts`:
`PiRuntimeDispatch` gained `preserveForArchive(sessionId)`, and
`packages/control-plane/src/cloudflare/pi-runtime-dispatch.ts` adapts it.
`packages/control-plane/src/cloudflare/pi-durable-object.ts:1410-1430` implements it:

- the agent stops working (`harness.abort`), but only when the harness is already open — a cold
  object has no live code to abort, and opening its harness would make the archive depend on
  repository rematerialization and on a provider that may be unavailable or revoked (the same
  reasoning `destroy` records at `:1408-1412`);
- every event the agent produced reaches the owning session: the projection outbox's undelivered
  operations are drained. A delivery that fails stays in the outbox, where the projector's own job
  retries it, so a provider outage never blocks an archive.

`packages/control-plane/src/session/http/handlers/session-lifecycle.handler.ts:155-192` calls it for
a Pi session, alongside the existing sandbox preservation (a Pi session that also has an execution
sandbox preserves both). `packages/control-plane/src/session/components.ts:1404-1426` wires it to
the session's own `PI_SESSION` port.

Nothing durable is deleted by any of this: the conversation, the task graph, the compaction
boundaries and the workspace files stay where they are. Delete still wipes the object
(`packages/control-plane/src/cloudflare/pi-durable-object.ts:1432-1478`).

### Tests

- `packages/control-plane/test/integration/session-export.test.ts` (new case): a Pi session line
  carries `harnessState` with a reason that names Pi Durable; a sandbox session line does not carry
  the field at all.
- `packages/control-plane/test/integration/pi-session-do.test.ts` (new case): `preserveForArchive`
  delivers the queued projection, leaves the outbox empty, and leaves the session id and the `pi_*`
  and `oi_pi_*` tables in place.
- `packages/control-plane/src/session/http/handlers/session-lifecycle.handler.test.ts` (new cases):
  a Pi archive calls the Pi preservation; a sandbox archive does not.

---

## 4. D7 — `mcp_read` is two tools, one per credential domain

**Fixed.** The shared lane and the personal lane are two model-visible tools.

### What changed

- `packages/shared/src/pi-tool-effects.ts`: `PI_MCP_TOOL_EFFECT_REGISTRATIONS` is now
  `mcp_read_shared` and `mcp_read_connection`, both `external_read` / `callers: ["model"]` /
  `replay: "safe"`. The assembler enforces that a declaration has a tool and a tool has a
  declaration (`packages/control-plane/src/pi/extension-assembler.ts:186-199`), so the two sides
  move together.
- `packages/control-plane/src/pi/mcp-extension.ts`: two tools. Each names **exactly one** target,
  and the target is _required_ in the tool's parameters: `mcp_read_shared` takes `serverId`,
  `mcp_read_connection` takes `connectionId`. The "exactly one target" rule therefore holds at the
  tool boundary, not only at the server boundary (`packages/shared/src/types/mcp-read.ts:131-133`,
  kept as the second line of defence).
- `packages/control-plane/src/pi/event-translator.ts:378-386`: the timeline's redacted-output list
  carries both new names beside the old one.

The SessionDO's read handler is unchanged: it still re-validates both lanes and still returns a
bounded, credential-free result
(`packages/control-plane/src/session/http/handlers/mcp-session.handler.ts:195-420`). No new scope,
no new credential kind, no new auth path.

### Tests

`packages/control-plane/src/pi/mcp-extension.test.ts`: the shared tool never names a connection, the
personal tool never names a server, and each tool's parameter schema requires exactly one target.

---

## 5. D8 — the agent's lifecycle is not a messaging authority

**Fixed.** `fork` and `compact` join `reset`, `handoff` and `cancel_exact` on the session's
**existing** `lifecycle` authority.

### The authority I used, and why it is the right one

The audit asked for "the authority Open-Inspect already uses for 'this person may reshape the
session'". That authority exists and is already called `lifecycle`:

- `packages/shared/src/types/session-access.ts:177` — the session rule is
  `lifecycle: { permission: "sessions.lifecycle" }`;
- `packages/shared/src/rbac.ts:81` — `sessions.lifecycle` is a granted permission, and the built-in
  member role holds it (`packages/shared/src/rbac.ts:149-164`);
- the sandbox harness's own lifecycle routes already require it:
  `packages/control-plane/src/routes/session-runtime-proxy.ts:368-371` (`/sessions/:id/stop`),
  `:514-517` (`/sessions/:id/archive`), and the session's own command router requires it for
  `cancel_prompt`, `stop` and `recover_preservation`
  (`packages/control-plane/src/session/message-router.ts:159-177`).

So the precedent is the sandbox harness's `/compact` and `/clear` belonging to the same authority as
the session's stop and archive — not a new permission. No new permission, no new scope, no new auth
path.

### What changed

- `packages/control-plane/src/routes/pi-controls.ts:45-60`: `COLLABORATION_ACTIONS` is now `send`,
  `steer`, `follow_up`; `LIFECYCLE_ACTIONS` is now `cancel_exact`, `fork`, `reset`, `handoff`,
  `compact`. The two sets are already routed to two different URLs with two different
  `requireSession(...)` gates (`:85-93`, `:124-128`), so the collaborator route now refuses a
  lifecycle action with "Pi control action is not allowed on this route" and the lifecycle route
  refuses a collaborator who lacks `sessions.lifecycle`.
- `packages/web/src/hooks/use-pi-agents.ts:36-48`: the web client routes `fork` and `compact` to
  `/pi/lifecycle-control`, beside `reset`, `handoff` and `cancel_exact`.

Slack's `steer` and `follow_up` are unchanged and still reach the collaborator route
(`packages/control-plane/src/routes/pi-controls.ts:16`, `:21-27`).

### Tests

`packages/control-plane/src/routes/session-runtime-proxy.test.ts` (new cases): a user with
`sessions.read` and `sessions.collaborate` but no `sessions.lifecycle` may `steer` and may not
`fork` or `compact`; a session owner may `fork`, `reset`, `handoff`, `compact` and `cancel_exact`.
`packages/web/src/hooks/use-pi-agents.test.tsx` (new case): the web client routes `fork` to the
lifecycle route.

---

## 6. D4 — reported, not changed

**Reported.** The Pi Durable Object's storage still holds three table families. Separating them is a
design change, and the task says not to invent it.

### 6.1 The writer audit (the part that was asked for)

One SQLite file, three families, three writers, three migration systems.

| Family                         | Tables                                                                                                                                                               | Writer                                                      | Where the write happens                                                                                                               | Its own migrations?                                                                                        |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Pi Durable's own runtime state | `pi_durable_schema`, `pi_durable_metadata`, `pi_record_ids`, `pi_conversations`, `pi_entries`, `pi_tasks`, `pi_submissions`, `pi_documents`, `pi_document_revisions` | `agents`/`pi-durable`, through the harness's storage handle | `node_modules/agents/dist/harness/pi/index.js:324` (`openPiSessionStore(this.lifecycle.storage)`), `:29` (the `pi_` prefix), `:31-32` | **yes** — `node_modules/@earendil-works/pi-durable/dist/storage/sqlite/migrations.js:1-80`                 |
| The Computer VFS               | `vfs_meta`, `vfs_nodes`, `vfs_dirents`, `vfs_blobs`, `vfs_blob_bytes`, `vfs_chunks` (+ the `_vfs_*` bookkeeping tables)                                              | `@cloudflare/computer`, over the same object storage        | opened at `packages/control-plane/src/cloudflare/pi-durable-object.ts:1499-1501` (`new Workspace({storage: this.ctx.storage …})`)     | **yes** — `node_modules/@cloudflare/computer/dist/index.js:94-137` and its `MIGRATIONS` list at `:243-291` |
| Open-Inspect's Pi outboxes     | `oi_pi_projection_outbox`, `oi_pi_projection_finalization`, `oi_pi_repository_diff_outbox`                                                                           | this repo's outboxes                                        | `packages/control-plane/src/cloudflare/pi-durable-object.ts:315-320` (`this.ctx.storage.sql`)                                         | **now yes** — D5's registry, `packages/control-plane/src/pi/schema.ts`                                     |

So the honest statement of the deviation is: **each table already has exactly one writer**, and —
after D5 — each family has its own tracked migrations. What is shared is the _file_. The audit's
phrase "three independent writers" is accurate only at file granularity, and "one writer per table
through the shared adapter" was already true per table; what was missing was the tracked migration,
which D5 closes.

The remaining blast radius is the one the audit names: a failure that affects the database (a full
volume, a corrupt page, a long-running write) affects the transcript, the audit trail and the
model-written workspace together. The model-writable part is already bounded — the scratch area is
capped at 8 MiB and 1 000 entries (`packages/control-plane/src/pi/computer-workspace-quota.ts:8-9`,
`:104-239`) — but the repository overlay is written through the raw workspace handle, not through
that quota (`packages/control-plane/src/cloudflare/pi-durable-object.ts:1532`), and the SQLite
file's own capacity is the deployment's, not the agent's.

### 6.2 The options, and the single-tenant tension

**Option A — give the VFS its own Durable Object.** The agent's writable bytes never share a file
with the transcript. Cost: a new DO class and a new namespace binding
(`packages/control-plane/src/index.ts:26` exports the classes;
`terraform/environments/production/workers-control-plane.tf:228-232` declares them), a second
Terraform deploy phase for the new binding (`enable_durable_object_bindings = false`, then `true`,
per `AGENTS.md`), the workspace tools would have to cross a Durable Object boundary on every read
and write, and the new object needs its own SQLite migration tag
(`control_plane_new_sqlite_classes`, `terraform/environments/production/variables.tf:965-969`).
_Single-tenant tension:_ Open-Inspect is single-tenant, so every Pi session currently costs one
SessionDO **and** one PiSessionDO; a third object per session doubles the object count and the
per-session failure surface for a deployment that has one tenant and one deployment-wide credential.
The tension is that the isolation the audit wants is per-_session_ isolation, while the deployment's
tenancy is one tenant — so the cost is real and the benefit is bounded by the per-session scratch
quota that already exists.

**Option B — move the `oi_pi_*` outboxes into the SessionDO's database.** It is already
migration-tracked there. Cost: the outbox's writer would have to move with it. Today the Pi DO
enqueues and drains its own events
(`packages/control-plane/src/pi/projection-capability.ts:91-173`), so the outbox exists on the side
that produced the event — a delivery failure keeps the event queued next to the transcript that
produced it. Moving the outbox to the SessionDO would make the Pi DO deliver over the network and
let the SessionDO own the queue: a change to the projection's failure semantics, and the reason the
projection exists in the Pi DO at all. _Single-tenant tension:_ this one has none in cost and all of
the risk — it trades a durability guarantee for tidiness.

**Option C — keep one database and bound what the agent can put in it.** Extend the existing quota
to the repository overlay, or give the VFS a byte budget inside the object. Cost: the repository
overlay legitimately holds checkouts, so a byte budget has to be generous; it bounds the _worst
case_, not the _sharing_. _Single-tenant tension:_ none — one tenant, one set of per-session quotas.

**What I did and did not implement.** D5 (the tracked registry for our own tables) is implemented —
it is the half of D4 that is unambiguous. The rest is reported. Option C is the only one that can be
done without a new primitive, and even it needs a decision about the repository overlay's budget,
which is a product decision about how big a checkout may be.

### 6.3 Where I disagree with the audit on D4

The audit's own fix paragraph offers the same two options and calls D4 "the largest of the (D)
items" (`PI-INTEGRATION-AUDIT.md:703`). I agree with that assessment and with the audit's own §"no"
verdict in its portability table (`PI-INTEGRATION-AUDIT.md:848`: "the new Durable Object and its
Terraform are the hard part"). I do not agree with the framing "three table families share one
SQLite database" as a _writer_ problem: after D5 there is one writer per table and one migration
registry per family. The remaining problem is file-level blast radius, which is a capacity and
isolation design question, not a writer question.

---

## 7. Where I disagree with the audit

### 7.1 D5: the outbox tables are not in the SessionDO's database

The audit says the tables should move "into the SessionDO's numbered migration registry"
(`PI-INTEGRATION-AUDIT.md:362-363`) and describes that registry as "the SessionDO's numbered
migration registry, which does track the Pi migrations by id" (`:350-353`).

They cannot go there without moving their writer. The outbox tables live in the **Pi Durable
Object's** SQLite (`packages/control-plane/src/cloudflare/pi-durable-object.ts:315-320`), and the
SessionDO's registry is applied to the SessionDO's own storage
(`packages/control-plane/src/cloudflare/durable-object.ts:58`). The audit's own §6 paragraph says
the alternative fix is "to put the `oi_pi_*` outboxes in the SessionDO's database" (`:341-343`) —
which is a _different_ fix from the one it recommends, and is the one that changes the projection's
semantics.

I built the Pi Durable Object's own registry instead, in the repo's pattern, with reserved ids. The
`MigrationStore` union gained a third member, `"pi_do"`
(`packages/shared/src/pi-migration-reservations.ts:3-13`); it is a label in a reservations table,
not a new table, scope, auth path or credential.

### 7.2 D6: the Pi DO's read surface is not the transcript

The audit's parenthetical — "there is one: `lookup` and `status` on
`packages/control-plane/src/cloudflare/pi-runtime-dispatch.ts:23-25`" — names two methods that
return one operation's status and a `{busy, pending}` pair. The transcript and the task graph are
behind the _control_ read actions, and `get_conversation` returns entry ids and kinds, not content
(`packages/control-plane/src/cloudflare/pi-durable-object.ts:1055-1069`). So option (a) is not
"extend the export with the Pi DO's existing read surface"; it is "add a new Pi-side read surface
that returns the transcript, and decide what to do with the VFS". That is a new primitive, and I
stopped there and took (b).

### 7.3 D8: `reset`, `handoff` and `cancel_exact` were already on `lifecycle`

(The line numbers in this section are the ones **before** this change; the file moved afterwards.)

The audit says the Pi control route "requires `requireSession("collaborate")` for the write actions
(`packages/control-plane/src/routes/pi-controls.ts:85-92`), and the same route admits `fork`,
`reset`, `handoff`, `compact`, `steer`, `follow_up` and `cancel_exact`"
(`PI-INTEGRATION-AUDIT.md:415-420`). At HEAD the route already had two gates: `collaborate` for
`send`, `steer`, `follow_up`, `fork`, `compact`, and `lifecycle` for `cancel_exact`, `reset`,
`handoff` (`packages/control-plane/src/routes/pi-controls.ts:45-46` and `:85-93` before this change;
the two admit gates are now `:101-108`). The live gap was `fork` and `compact` — the two actions
that create or rewrite a durable conversation — and those are what I moved.

The audit's proposed fix ("give the agent-lifecycle actions their own permission") would have added
a permission. `sessions.lifecycle` already is that permission, and the sandbox harness's own
stop/archive/diff routes already require it, so I used it rather than inventing one.

### 7.4 The audit's Pi Durable Object binding list is stale

The audit's inventory says the Pi DO's bindings are "`SESSION`, `CODEMODE_SANDBOX`, `BROWSER`
(`packages/control-plane/src/cloudflare/pi-durable-object.ts:167`, the audit's own line number)"
(`PI-INTEGRATION-AUDIT.md:58`). At HEAD the type is
`Pick<WorkerBindings, "SESSION" | "CODEMODE_SANDBOX">`
(`packages/control-plane/src/cloudflare/pi-durable-object.ts:195`) — there is no `BROWSER` binding,
deliberately: "There is no browser binding here on purpose: the browser belongs to the owning
session" (`packages/control-plane/src/cloudflare/pi-durable-object.ts:188-195`). This does not
change any conclusion; it is recorded because the audit is the document the next reader will check.

---

## 8. UNVERIFIED

- **The published JSON Schema was already stale at HEAD.**
  `docs/schemas/trace-export.v2.schema.json` had never been regenerated after the `pi` harness and
  the newer event types landed (its last commit was `3f807c62`, "add codex to the harness catalog").
  Regenerating it — which the change to the shared Zod types requires — also brings in that
  pre-existing drift. The diff therefore shows more than `harnessState`. The route test that used to
  detect drift was deleted upstream in `1a08d571` ("reduce redundant suites while preserving
  coverage"), so **there is currently no automated drift check** between the shared Zod types and
  the published schema. I did not add one: that is a test-suite change outside this scope.
- **The archive's Pi preservation was exercised in the integration lane**
  (`packages/control-plane/test/integration/pi-session-do.test.ts`), but the _route_ that reaches it
  (`POST /sessions/:id/archive` on a Pi session) has no integration test at HEAD, so the wiring is
  covered by the handler unit test and by the Pi DO integration test, not by one end-to-end route
  test.
- **The Pi DO's constructor now applies migrations on every activation.** The cost is one
  `CREATE TABLE IF NOT EXISTS` plus one `SELECT` per activation. I did not measure it against the
  activation budget.
- **`preserveForArchive` does not close the Code Mode sandbox or the Computer workspace handle.**
  Both are re-openable and both are released by `destroy`; closing them on archive would be a
  behaviour change I could not justify from the code, so I left them.
- **The SDK version moved under the work.** The branch was created from `95ea8054` and rebased onto
  `00dd5f13` (which upgraded the Agents SDK from 0.28.1 to 0.29.0) and onto `d365dc05` (which merged
  `origin/main` and renumbered the D1 migrations). The tests below ran on the rebased tree, against
  Agents SDK 0.29.0. I did not re-run anything against 0.28.1.

---

## 9. Test results

Environment: the worktree has no `node_modules` of its own, so it uses a symlinked install of the
main worktree's. Two consequences are recorded below.

| Lane                       | Command                                                | Result                                                                                |
| -------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| shared build               | `npm run build -w @open-inspect/shared`                | **pass**                                                                              |
| shared tests               | `npm test -w @open-inspect/shared`                     | **pass** — 63 files, 1 328 tests                                                      |
| typecheck, every workspace | `npm run typecheck`                                    | **pass**                                                                              |
| control-plane unit lane    | `npm test -w @open-inspect/control-plane`              | **pass** — 339 files, 5 415 tests, 1 skipped; **one environment-only failure**, below |
| control-plane workerd lane | `npx vitest run --config vitest.integration.config.ts` | **pass** — 175 files, 2 485 tests, 1 skipped                                          |
| web tests                  | `npm test -w @open-inspect/web`                        | **pass** — 231 of 233 files; two unrelated files time out, see below                  |
| lint                       | `npm run lint:fix`                                     | **pass**                                                                              |
| format                     | `npx prettier --write` on the changed files            | **pass**                                                                              |

### The one environment-only failure

`packages/control-plane/src/worker-build.test.ts` — "uses the workerd AsyncLocalStorage
implementation" — asserts that the worker bundle's metafile contains the input path
`../../node_modules/@cloudflare/computer/dist/index.js`. With a symlinked `node_modules`, esbuild
resolves the real path (`../../../pi-go-live-v2/node_modules/…`), so the assertion fails on the path
string, not on the build. The same test **passes in the main worktree**, which has a real
`node_modules`. The worker itself builds.

### The two web timeouts are this machine, not this change

`npm test -w @open-inspect/web` fails two files per run with `Error: Test timed out in 5000ms`, and
**the set of files changes from run to run** (`automation-form.test.tsx`,
`automations/new/page.test.tsx`, `github-integration-settings.test.tsx`,
`linear-integration-settings.test.tsx`). Each file passes in isolation. The **main worktree, which
does not contain any of my changes**, fails the same way — `automation-form.test.tsx` on the run I
did for comparison. None of the failing files imports the one web file I touched
(`packages/web/src/hooks/use-pi-agents.ts`).

### The workerd lane's first two runs

The first two integration runs failed with `spawn Unknown system error -88` from the Cloudflare test
pool: the workerd workers could not be spawned, because the web suite was running concurrently on
the same machine (the first run) and because the run was killed by the machine (the second). Re-run
on its own with `--maxWorkers=3`, the lane is green: 175 files, 2 485 tests, exit 0.
