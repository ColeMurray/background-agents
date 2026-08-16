# Research: Managed Skills Prompt Autocomplete

**Date:** 2026-08-16

**Status:** Research only

**Scope:** Internal repository behavior, history, contracts, and tests relevant to completing
managed skill names in new-session and follow-up prompt composers.

This document is intentionally research-only. It does not include recommendations, implementation
plans, proposed code/API/schema changes, task breakdowns, estimates, or rollout steps.

## Summary

Managed skills entered the repository in commit `97f6aeb` (`feat: add managed skills (#1449)`,
2026-08-15) as a cross-tier feature: D1 catalog and revision storage, assignment and profile stores,
session-time resolution and pinning, authenticated APIs, web settings and session selection, and
sandbox materialization. Commit `b8c757b` (`fix: clean up managed skills rollout (#1459)`,
2026-08-15) removed the original kill switch, retained boot compatibility for existing sessions, and
hardened collision and concurrent-create behavior. User documentation followed in `30e0e8b`.

No internal issue, specification, plan, or source implementation was found for managed-skill
autocomplete inside a prompt composer. Both current prompt textareas explicitly set browser
`autocomplete` to `off`, with assertions in web tests. The available composer history instead covers
component extraction, durable follow-up queueing, queued-prompt removal and draft restoration, and
focus restoration. Managed skills are currently selected when a session is created and installed
before OpenCode starts; they are not represented in the prompt payload or prompt WebSocket protocol.

The current web and control-plane contracts expose skill names and descriptions at both prompt
stages, but through different sources. Resolution preview returns the exact mutable-catalog result
for a proposed new-session target and selection. The session skills view returns the exact immutable
manifest pinned to an existing session. The general catalog list includes disabled skills and omits
only soft-deleted skills, so it differs from both sets.

Compatibility is explicit at several boundaries. Omitted `skillSelection` means `all`; child
sessions copy the parent's pinned manifest; sessions created before managed skills receive an empty
installation response; the sandbox installation DTO and manifest resolver are both version 1; and
the Python sandbox parser accepts additive JSON fields while independently validating required
content. Prompt submission uses a correlated WebSocket request/acknowledgement contract with a
64,000-character limit, a ten-item unfinished queue limit, attachment-only support, and no feature
negotiation.

## Research Questions

1. When and how was the managed skill store introduced?
2. What prompt composer, suggestion, or autocomplete-related work already exists?
3. Which API, protocol, persistence, runtime, and test constraints are visible in the repository?

## Current Behavior

### Managed skill catalog and persistence

- Managed skills are installation-wide shared records. Any admitted signed-in user can create, edit,
  enable, disable, assign, or soft-delete them; profiles are scoped to their canonical user.
  Authorship is recorded separately from authorization.
- D1 stores catalog state, skills, immutable content revisions, revision files, assignments,
  personal profiles, profile items, per-session manifests, and per-session pinned revisions.
- A skill's canonical name is unique case-insensitively. Its current revision pointer is guarded by
  triggers so that it can only reference a revision belonging to the same skill.
- Assignment rows support `global`, `repository`, and `environment`. Repository owners and names are
  separate fields, preserving nested repository-owner namespaces.
- Assignment changes and relevant environment-name changes increment a singleton catalog generation.
  Resolution reads the generation before and after catalog/profile reads and retries up to three
  times if it changed.
- Resolution first computes enabled, non-deleted applicable skills and then applies `all`, `none`,
  or an owned profile as a filter. Profiles do not make an unassigned skill applicable.
- Session creation resolves the mutable catalog before session initialization. The session row,
  repository snapshot, manifest, and pinned revisions are written in one D1 batch before Durable
  Object initialization.
- Child sessions copy their parent's persisted manifest and provenance instead of resolving the
  mutable catalog again.
- Catalog content is bounded to UTF-8 text. Current shared limits include 100 files per skill, 256
  KiB per file, 1 MiB per revision, 20 managed skills per session, and 5 MiB of managed content per
  session.

### Managed skill delivery

- Human-facing session provenance is available from `GET /sessions/:id/skills` after session
  visibility checks. It contains selection, resolver version, manifest digest, pinned revisions,
  descriptions, and assignment sources, but no installation file contents.
- A sandbox-authenticated `GET /sessions/:id/sandbox-skills` endpoint returns only schema version,
  manifest digest, skill names, and files. The bearer principal is bound to the requested session.
- Sessions that predate managed-skill manifests receive a generated empty version-1 installation
  when the session still exists. This supports restoration of older snapshots.
- The sandbox client retries transport failures, HTTP 408/429, and server failures, with three
  attempts and a 15-second timeout per request. It bounds the raw response at 32 MiB.
- Python independently validates schema version, names, paths, UTF-8 content, sizes, hashes,
  executable placement, required `SKILL.md`, frontmatter identity, duplicate names and paths, and
  aggregate limits.
- Materialization occurs after repository boot and before code-server, the terminal, OpenCode, and
  the agent bridge start. OpenCode process restarts reuse the materialized tree.
- Installation replaces the complete global managed-skills directory through staging, backup, and
  journal paths. Startup repairs an interrupted swap before installing.
- Collision scanning covers bundled skills and `.opencode/skills`, `.claude/skills`, and
  `.agents/skills` under the active workspace, member repositories, and home directory. A selected
  managed name collision fails materialization.

### Prompt composers

- The new-session page owns a controlled textarea and starts warming a session as the prompt and
  configuration are prepared. Target, model, reasoning effort, branch, and managed-skill selection
  form the warmed-session identity; a managed-skill selection change invalidates the warmed session.
- The in-session `SessionPromptComposer` is a controlled textarea component. The parent page owns
  prompt state, submission, keyboard handling, attachment upload, typing notifications, retry
  identity, and draft restoration.
- Both new-session and in-session textareas set `autoComplete="off"`. No custom suggestion list,
  token parser, skill-name lookup, slash-command handling, or autocomplete state was found in either
  composer.
- The two textareas do not share a prompt-input component or keyboard-state hook. The new-session
  textarea and handlers live in `page.tsx`; the follow-up textarea is rendered by
  `SessionPromptComposer`, while `usePromptInput` in its parent page owns its state and keyboard
  handling.
- The in-session keyboard contract submits only on Cmd/Ctrl+Enter without Shift or Alt and ignores
  that shortcut while an input method editor composition is active. Plain Enter remains a newline.
- Prompt submission temporarily locks the draft during attachment upload and server acknowledgement.
  The draft is cleared only after a matching successful acknowledgement.
- A keyboard-originated submission records whether the textarea held focus. After unlock, it
  restores focus only if focus remains on `document.body`, avoiding focus theft from another
  control.
- Removing a queued prompt restores its text only when the current composer is blank and has no
  attachments; restoration focuses the textarea. It does not restore model, reasoning effort, or
  attachments.

## Relevant Workflows

### Skill authoring and use

1. A signed-in user creates or edits structured skill content and optional supporting UTF-8 files.
2. The control plane generates `SKILL.md`, validates the complete tree, computes file and revision
   hashes, and writes an immutable revision.
3. Assignments determine applicability; a personal profile can filter that applicable set.
4. The new-session page sends only the discriminated `skillSelection`, not caller-selected skill
   IDs. The control plane resolves and pins exact revisions.
5. The sandbox fetches the pinned installation with its session-bound token and installs it before
   OpenCode discovery starts.
6. The session sidebar reads pinned provenance independently of the mutable catalog.

### Existing skill-name read paths

- `useSkills()` reads the installation-wide `GET /skills` catalog. `SkillStore.list()` excludes
  soft-deleted records but does not filter on `enabled`, and the returned summaries include names,
  descriptions, enabled state, revision identity, and assignments.
- `resolveSkillPreview()` accepts a new-session target plus `all`, `none`, or profile selection. Its
  response contains the same ordered resolved-skill objects used by session resolution, including
  names and descriptions after enabled-state, assignment, and profile filtering.
- `SessionSkillSelector` currently calls resolution preview but stores only resolved and ignored
  counts in component state; the returned skill objects are discarded after each request.
- `useSessionSkills(sessionId)` reads `GET /sessions/:id/skills`. Its response contains the pinned
  resolved-skill objects, including names and descriptions, and is already consumed by the session
  sidebar. No composer currently consumes this hook.
- Both preview resolution and session provenance are limited to at most 20 managed skills by the
  session manifest contract. The full shared catalog has no corresponding 20-item list bound.

### Prompt submission and queueing

1. The composer retains local text and attachment state.
2. Attachments are uploaded before the prompt WebSocket message is sent.
3. The client waits for WebSocket subscription, sends a `prompt` message with a `clientRequestId`,
   and waits up to 15 seconds for `prompt_queued` or a correlated error.
4. The same request identity is retained for a retry when the prompt payload signature is unchanged,
   allowing server-side idempotency.
5. The server persists an authoritative FIFO queue and broadcasts queue state. The client does not
   optimistically add the user message.
6. A pending prompt can be removed through correlated `cancel_prompt` and `prompt_cancelled`
   messages. Restoration occurs only after authoritative confirmation.

## Prior Work and Git History

### Managed skills

- `97f6aeb82b7aa068b760d6597def9a7e9a45916b` (`feat: add managed skills (#1449)`, 2026-08-15):
  introduced the feature in 75 files with 8,603 insertions and 64 deletions. The commit message
  records catalog authoring, immutable revisions, assignments, profiles, session pinning, sandbox
  delivery, settings/session UI, shared contracts, golden fixtures, D1 migration, Terraform, and
  design documentation.
- `30e0e8b` (`docs: add managed skills user guide (#1455)`, 2026-08-15): added the current
  user-facing guide at `docs/MANAGED_SKILLS.md`.
- `b8c757b28760f8fea17f7ade64f16574e3619543` (`fix: clean up managed skills rollout (#1459)`,
  2026-08-15): removed the feature kill switch, hardened collision scans against invalid UTF-8 and
  oversized `SKILL.md` reads, and mapped concurrent same-name creation to HTTP 409 behavior. It
  modified 15 files with 85 insertions and 99 deletions.
- `0d76305` (`docs: add managed skills changelog entry (#1451)`, 2026-08-15): recorded the shipped
  capability in `CHANGELOG.md`.
- `79c68a3` (`fix: show skill name in tool calls (#1450)`, 2026-08-15): is adjacent by subject, but
  repository evidence does not identify it as managed-skill storage or composer autocomplete work.

The design file `docs/plans/managed-skills.md` still labels itself as a proposed design and contains
historical rollout and implementation sections even though the feature is implemented. Its current
code references largely match the shipped implementation. Its final research section cites external
material; that section was excluded from this internal-only investigation.

### Prompt composer and queue

- `6443127a6248e4e96dc0d0a045b27906af58b6d9`
  (`Import Slack shared types from canonical modules (#1346)`, 2026-08-09) is the earliest commit
  available for `packages/web/src/components/session-prompt-composer.tsx`. The commit imported a
  broad repository baseline, so earlier history for the extracted component is not present in this
  repository's reachable history. The component already had `autoComplete="off"` and a matching test
  at that point.
- `fc4aab11056531ea8b1744b935326e51150ab58c`
  (`feat: queue follow-up prompts from web sessions (#1386)`, 2026-08-12): added durable FIFO
  follow-ups, correlated request IDs and acknowledgements, idempotent retry behavior, the
  64,000-character prompt limit, the ten-item unfinished queue limit, and queue UI. It changed 55
  files with 2,211 insertions and 227 deletions.
- `acaeab6dafcd215c3ec4e9301ccb5619495211d6` (`feat: remove queued prompts from sessions (#1423)`,
  2026-08-14): added correlated queued-prompt cancellation, released attachment claims, and restored
  cancelled text only into an empty attachment-free composer.
- `e2c013aaf177bfc4bbca9a691d0b0426ebce5fa2` (`fix: restore prompt focus after submission (#1456)`,
  2026-08-15): added conditional focus restoration after submission unlock. The commit changed only
  `packages/web/src/app/(app)/session/[id]/page.tsx`; its commit message reports focused validation,
  but no dedicated focus test file is present in the current tree.

History searches for `autocomplete`, `autoComplete`, `suggestion`, `composer`, `slash command`, and
prompt suggestion terminology found no separate custom autocomplete feature. Internal integration
documentation states that Slack and GitHub do not use slash commands today.

## API and Protocol Compatibility

### Managed skill contracts

- `CreateSessionRequest.skillSelection` is optional. The route normalizes omission to
  `{ mode: "all" }`, preserving older web, bot, automation, and integration callers.
- The selection contract is a discriminated union: `all`, `none`, or `profile` with `profileId`. The
  browser session BFF forwards this selection but strips caller-provided `skillIds` and fields
  outside its allowlist.
- Catalog and profile input schemas use strict objects at authoring boundaries. Unknown fields in
  those request objects are rejected.
- The sandbox DTO has `schemaVersion: 1`; the persisted human-facing manifest has resolver version
  1. A persisted resolver version of 2 currently raises an unsupported-version error.
- The TypeScript sandbox DTO uses non-strict Zod objects, and the Python parser checks required key
  subsets rather than exact key sets. Current tests confirm additive installation, skill, and file
  fields are ignored by Python.
- Manifest and revision hashes use fixed version-1 domain separators, big-endian integer encodings,
  exact UTF-8 bytes, and deterministic ordering. The code states that incompatible serialization
  changes require new domains and a new resolver version.
- TypeScript and Python duplicate sandbox-visible limits. The shared golden fixture pins TypeScript
  rendering, hashes, file metadata, and limit values; Python validates incoming files but does not
  compute the provenance manifest digest because selection and assignments are absent from the
  narrow DTO.
- Human and sandbox routes are intentionally distinct. Human provenance requires user authentication
  and session visibility; installation requires a sandbox principal bound to the same session ID.

### Prompt transport contracts

- The current client WebSocket union contains `prompt`, `cancel_prompt`, `stop`, `typing`, presence,
  history, subscribe, and ping messages. There is no autocomplete or skill-lookup message.
- A `prompt` requires `clientRequestId`, content, and optional model, reasoning effort, and uploaded
  attachment references. Source and canonical author identity are derived server-side and are not
  sent by the browser WebSocket client.
- Prompt content is capped at 64,000 characters. Blank text is rejected unless at least one valid
  attachment reference is present.
- Server acknowledgements echo `clientRequestId`. `prompt_queued` includes an authoritative
  `messageId` and nullable queue position; correlated errors can reject the request.
- The web client sends correlated prompts without feature negotiation. Unknown or malformed server
  messages fail schema parsing and close the connection with the invalid-message close code.
- The transport waits up to five seconds for subscription and 15 seconds for prompt acknowledgement.
  Only one prompt request can await acknowledgement in a given hook instance.
- Queue snapshots and live updates contain prompt text and `pending` or `processing` status. The
  unfinished queue is bounded to ten prompts by the shared contract and server queue behavior.

## Test Coverage Constraints

### Managed skills

- `packages/shared/src/types/skills.test.ts` covers canonical names, traversal, duplicate and
  ancestor-conflicting paths, executable placement, malformed Unicode, default collections, and
  repository-preview bounds. It does not exhaustively test every published byte/count boundary in
  that file.
- `packages/control-plane/src/skills/content-addressing.test.ts` covers canonical `SKILL.md`
  rendering, cross-runtime limit fixture values, stable revision hashing, stable manifest hashing,
  metadata order, assignment order, and the golden file list.
- `packages/control-plane/test/integration/managed-skills.test.ts` uses real D1 migration state and
  covers immutable content reuse, nested-owner assignments, owned profiles, same-name races, atomic
  manifest persistence, child copying, foreign-key integrity, unsupported resolver versions, sandbox
  session binding, catalog/profile CRUD, HTTP conflict and validation mapping, aggregate edit
  preconditions, stale compare-and-swap behavior, generation triggers, and ignored profile entries.
- `packages/control-plane/src/router.auth.test.ts` asserts that managed-skill browser routes require
  Better Auth user authentication rather than web service-only authentication.
- `packages/sandbox-runtime/tests/test_managed_skills.py` covers traversal and path conflicts, file
  hashes, frontmatter identity, additive DTO fields, URL encoding and bearer auth, transient
  retries, complete destination replacement, bundled collisions, invalid UTF-8 collision input,
  interrupted swap repair, absent endpoint configuration, and global config directory selection.
- The current Python test file does not contain a direct assertion for every mirrored count/size
  limit, every discovery root, every HTTP non-retryable status, the 32 MiB streamed-response limit,
  executable output mode, or startup ordering relative to OpenCode. Some lifecycle ordering is
  covered separately by sandbox supervisor tests introduced in the managed-skills commit.
- `packages/web/src/app/api/skills/managed-skills-routes.test.ts` covers unauthenticated aggregate
  edits, URL encoding, `If-Match` forwarding, and empty response forwarding. It does not exercise
  every catalog/profile/preview BFF method.
- `packages/web/src/components/session-skill-selector.test.tsx` currently has one focused preview
  reset test. `packages/web/src/app/(app)/page.test.tsx` covers warmed-session invalidation and
  forwarding `none`; settings editor/profile tests cover additional authoring behavior.

### Prompt composer and protocol

- `packages/web/src/components/session-prompt-composer.test.tsx` covers browser autocomplete being
  disabled, the 64,000-character textarea limit, resizing, mobile queue/stop/upload controls,
  processing and terminal-session control state, inline submission errors, and responsive action bar
  classes.
- `packages/web/src/app/(app)/page.test.tsx` separately covers browser autocomplete being disabled
  on the new-session composer and managed-skill changes invalidating warmed sessions.
- No current web test exercises a custom autocomplete popup, suggestion filtering, caret/token
  replacement, arrow-key navigation, Escape handling, or selection semantics because no such
  behavior exists in the current source.
- `packages/shared/src/types/boundary-schemas.test.ts` covers correlated client prompt parsing,
  request-ID bounds, blank and oversized prompt rejection, attachment-only prompts, attachment
  source and count restrictions, and cancellation parsing.
- `packages/shared/src/types/server-messages.test.ts` covers correlated prompt acknowledgements and
  rejections plus authoritative queue snapshots and updates.
- `packages/web/src/hooks/use-session-socket.test.tsx` covers waiting for matching acknowledgements,
  ignoring unrelated responses, cancellation races, operation without feature negotiation,
  invalid-prompt errors, subscription and disconnect behavior, and stable request IDs across
  reconnect retries.
- `packages/web/src/lib/restore-queued-prompt.test.ts` covers restoration and focus only for an
  empty, attachment-free composer. No current test directly asserts the conditional post-submit
  focus logic added by `e2c013a`.
- Control-plane queue tests cover persistence, FIFO ordering, authoritative timeline timing,
  attachment claims, callback context, cancellation, capacity, idempotency, and WebSocket behavior
  across unit and workerd integration suites.

## Known Gaps and Risks

- The managed-skills plan is retained as a proposed design with historical implementation and
  rollout language, while the feature is already shipped and the kill switch described by the
  initial commit was removed immediately afterward. The user guide and current code reflect the
  post-cleanup state.
- There is no internal issue text or specification for prompt autocomplete in the checked-out
  repository, and no `.github` issue templates or issue-export files are present.
- Reachable history for the prompt composer begins with a broad repository import commit. Earlier
  component provenance cannot be established from this checkout.
- The prompt composer explicitly suppresses browser autocomplete, but tests use the phrase "autofill
  suggestions". Repository evidence does not indicate whether this attribute was intended only for
  browser form history or also as a product-level statement about prompt suggestions.
- Managed skills currently reach the agent through OpenCode's skill discovery after session-time
  selection and sandbox installation. They do not enter prompt payloads, queue rows, or WebSocket
  composer messages.
- The repository pins OpenCode `1.18.18`, but OpenCode's parser and native prompt UI source are not
  vendored. Internal tests establish filesystem discovery and unchanged prompt transport, not the
  runtime meaning of `/skill-name` or `$skill-name` in a text prompt.
- Catalog schemas, sandbox DTO schemas, and WebSocket schemas have different unknown-field
  tolerance. Strict authoring inputs reject extras; sandbox installation parsing tolerates additive
  fields; WebSocket discriminated unions reject unknown message types while ordinary object members
  generally strip extra fields during parsing.
- Session provenance rejects resolver versions other than 1, while the legacy sandbox endpoint can
  synthesize an empty version-1 installation for pre-feature sessions.

## Open Questions

- The supplied feature request identifies `/skill-name` and `$skill-name` as candidate trigger
  syntaxes, but does not choose one or define whether selecting a result inserts only the token or
  also changes skill selection.
- Internal evidence does not establish whether OpenCode `1.18.18` assigns native invocation
  semantics to either candidate token after the unchanged text reaches `prompt_async`.
- Internal evidence does not define matching behavior for a trigger in the middle of text, repeated
  references, punctuation boundaries, an empty query, or a token whose skill is unavailable to the
  current session.
- No internal issue archive is present, so issue discussions not committed into docs or commit
  messages are unavailable in this workspace.
- Earlier history before the broad 2026-08-09 repository import is unavailable for the extracted
  `SessionPromptComposer` path.

## Evidence

- `docs/plans/managed-skills.md`: original product, storage, resolution, API, runtime, security, and
  testing design; now partly historical in status and rollout wording.
- `docs/MANAGED_SKILLS.md`: current user-facing authoring, assignment, profile, selection,
  provenance, and limits behavior.
- `CHANGELOG.md`: shipped managed-skills and prompt-queue behavior.
- `terraform/d1/migrations/0061_managed_skills.sql`: implemented D1 tables, indexes, constraints,
  generation triggers, and pinned session records.
- `packages/shared/src/types/skills.ts`: current shared input, response, selection, preview,
  installation, limits, and version contracts.
- `packages/shared/test-fixtures/managed-skills-golden.json`: canonical rendering, hash, file, and
  limit fixture.
- `packages/control-plane/src/db/skills.ts`: catalog and immutable revision persistence.
- `packages/control-plane/src/db/skill-profiles.ts`: user-owned profile persistence and validation.
- `packages/control-plane/src/db/session-index.ts`: atomic session/repository/manifest persistence
  and child-manifest copying.
- `packages/control-plane/src/db/session-skills.ts`: provenance and narrow installation projection,
  including resolver-version validation.
- `packages/control-plane/src/session/skill-resolution.ts`: generation-stable applicability and
  profile filtering with aggregate limits.
- `packages/control-plane/src/skills/content-addressing.ts`: versioned deterministic revision and
  manifest serialization.
- `packages/control-plane/src/routes/skills.ts`: catalog, profile, preview, conflict, validation,
  and canonical-user route behavior.
- `packages/control-plane/src/routes/session-create.ts`: omitted-selection compatibility and
  session-time resolution.
- `packages/control-plane/src/routes/session-skills.ts`: human provenance, session-bound sandbox
  authentication, ETag, and legacy empty manifests.
- `packages/sandbox-runtime/src/sandbox_runtime/managed_skills.py`: fetch, retry, independent
  validation, collision detection, and journaled installation behavior.
- `packages/sandbox-runtime/src/sandbox_runtime/supervisor.py`: materialization ordering before
  OpenCode startup.
- `packages/web/src/app/(app)/page.tsx`: new-session composer, managed-skill selection, and warmed
  session identity.
- `packages/web/src/components/session-prompt-composer.tsx`: current in-session textarea and control
  behavior, including `autoComplete="off"`.
- `packages/web/src/app/(app)/session/[id]/page.tsx`: controlled prompt state, shortcut, locking,
  retry identity, focus restoration, typing notifications, and draft restoration.
- `packages/shared/src/types/prompts.ts`: shared prompt and queue limits.
- `packages/shared/src/types/websocket.ts`: client WebSocket message union.
- `packages/shared/src/types/server-messages.ts`: server acknowledgement, queue, snapshot, and error
  union.
- `packages/web/src/hooks/use-session-socket.ts`: correlated prompt transport, acknowledgement,
  retry, cancellation, and timeout behavior.
- `packages/control-plane/test/integration/managed-skills.test.ts`: real-D1 managed-skills coverage.
- `packages/sandbox-runtime/tests/test_managed_skills.py`: Python installation and materialization
  coverage.
- `packages/web/src/components/session-prompt-composer.test.tsx`: current composer regression
  coverage.
- `packages/web/src/hooks/use-session-socket.test.tsx`: prompt WebSocket compatibility coverage.
- Git commits `97f6aeb`, `30e0e8b`, `b8c757b`, `6443127`, `fc4aab1`, `acaeab6`, and `e2c013a`:
  introduction and prior-work history summarized above.
