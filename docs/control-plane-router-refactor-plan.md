# Control Plane Router Refactor Plan

## Goal And Scope

Reduce `packages/control-plane/src/router.ts` from a god-mode module into a small HTTP Gateway while
creating portability seams for future runtimes outside Cloudflare.

The refactor should preserve the current external HTTP surface and the current Session Durable
Object internal contract. It should not redesign Session behavior, authentication, or the
`SessionInternalPaths` contract as part of the first pass.

## Context Summary

| Area               | Findings                                                                                                                                                                    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Route pattern      | Existing route modules export `Route[]`, keep handlers private, and use `routes/shared.ts` for `json`, `error`, `parseJsonBody`, and `parsePattern`.                        |
| Router role        | `router.ts` should remain the HTTP Gateway: CORS, auth, SCM gating, metrics, tracing, and route dispatch.                                                                   |
| Cloudflare leakage | `router.ts` directly uses `DurableObjectNamespace`, `DurableObjectStub`, `R2Bucket`, `ExecutionContext.waitUntil`, and `CF-Connecting-IP`. These are the portability seams. |
| Session routes     | Many Session routes are pure Session runtime proxies. The heavy use cases are Session creation, prompt intake, media artifacts, and child Session intake.                   |
| Tests              | Route modules have direct tests. Router-level tests cover integration/pipeline behavior such as auth, SCM gating, and trace headers.                                        |
| Stable contracts   | `SessionInternalPaths`, `initializeSession`, `SessionInitInput`, shared Session types, and ADR 0002 should stay stable.                                                     |

## Nomenclature

- **HTTP Gateway**: CORS, correlation, auth, route matching, response wrapping.
- **Endpoint Adapter**: translates one HTTP request into an application call.
- **Use Case Module**: orchestrates a real operation such as creating a Session or spawning a child
  Session.
- **Policy Module**: owns guardrails and validation rules.
- **Gateway Interface**: hides infrastructure such as Durable Objects, R2, `waitUntil`, D1, or
  provider clients.
- **Adapter**: Cloudflare-specific implementation of a Gateway Interface.

For portability, module names should describe Open-Inspect concepts. Cloudflare-specific names
should stay in adapter implementations. Prefer names such as `SessionRuntimeClient`,
`ObjectStorage`, and `BackgroundTasks` over `DurableObjectClient`, `R2Bucket`, and
`ExecutionContext`.

## Proposed Module Breakdown

### 1. Request Pipeline Module

Keep `router.ts` focused on the HTTP Gateway:

- CORS preflight and response headers
- correlation IDs and request metrics
- internal HMAC auth
- sandbox auth fallback
- SCM provider gating
- route dispatch and request logging

This module should not know how Sessions are initialized, how media is stored, or how child Session
guardrails work.

### 2. Session Identity Module

Move Session actor identity helpers out of `router.ts`:

- `parseAuthorId`
- `deriveUserId`
- `resolveProviderIdentity`
- linked source-control identity enrichment

Likely files:

- `packages/control-plane/src/session/identity.ts`
- `packages/control-plane/src/session/identity.test.ts`

This is the safest first extraction and removes exported helper tests from
`router.identity.test.ts`.

### 3. Session Runtime Client

Create a portability seam around "talk to the live Session runtime."

Today the implementation will still use:

- `env.SESSION.idFromName(sessionId)`
- `env.SESSION.get(id)`
- `stub.fetch(...)`
- `SessionInternalPaths`

Later, the same interface could be backed by another actor runtime, service, queue, or
database-backed worker.

Likely files:

- `packages/control-plane/src/session/runtime-client.ts`
- later, if needed: `packages/control-plane/src/platform/cloudflare-session-runtime.ts`

This should hide Durable Object details from route handlers and use-case modules.

### 4. Session Routes Module

Move external Session route definitions into a dedicated route module.

Likely file:

- `packages/control-plane/src/routes/sessions.ts`

Thin proxy routes should delegate through `SessionRuntimeClient`. `router.ts` should import
`...sessionRoutes` just like `reposRoutes`, `repoImageRoutes`, and `automationRoutes`.

Pure proxy routes include:

- `GET /sessions/:id`
- `POST /sessions/:id/stop`
- `GET /sessions/:id/events`
- `GET /sessions/:id/artifacts`
- `GET /sessions/:id/participants`
- `POST /sessions/:id/participants`
- `GET /sessions/:id/messages`
- `POST /sessions/:id/pr`
- `POST /sessions/:id/openai-token-refresh`
- `POST /sessions/:id/ws-token`
- `PATCH /sessions/:id/title`
- `POST /sessions/:id/archive`
- `POST /sessions/:id/unarchive`
- `GET /sessions/:id/children/:childId`
- `POST /sessions/:id/children/:childId/cancel`

### 5. Session Intake Module

Move external Session creation orchestration into a use-case module.

Likely file:

- `packages/control-plane/src/session/intake.ts`

Responsibilities:

- parse and validate the create request
- normalize repository identifiers
- resolve repository access
- resolve creator identity
- encrypt source-control tokens
- enrich source-control identity from linked provider records
- validate model and reasoning effort
- resolve code-server and sandbox settings
- build `SessionInitInput`
- call `initializeSession`
- enqueue background token upsert

`initializeSession` should remain the stable module that writes the D1 Session index before
initializing the Session runtime.

### 6. Prompt Intake Module

Move `handleSessionPrompt` behavior into a use-case module because it is more than a proxy.

Likely file:

- `packages/control-plane/src/session/prompt-intake.ts`

Responsibilities:

- validate prompt body
- enrich bot-originated authors with linked source-control identity
- forward the prompt to `SessionRuntimeClient`
- touch the D1 Session index in the background so the Session bubbles to the top of the sidebar

### 7. Child Session Intake Module

Move agent-spawned child Session creation into a use-case module.

Likely file:

- `packages/control-plane/src/session/child-session-intake.ts`

Responsibilities:

- validate child spawn request
- load parent Session row
- resolve child Session limits from sandbox settings
- enforce depth, concurrent child, total child, and same-repo guardrails
- fetch parent spawn context from `SessionRuntimeClient`
- validate explicit child model and reasoning effort
- build child `SessionInitInput`
- initialize child Session
- enqueue the initial prompt
- mark the child failed if enqueue fails
- notify the parent Session in the background

The first extraction should keep these responsibilities together for locality. A later pass can
separate the child Session policy if it becomes useful.

### 8. Media Artifact Gateway

Move media upload/download behavior out of `router.ts`.

Likely files:

- `packages/control-plane/src/session/media-artifacts.ts`
- `packages/control-plane/src/platform/object-storage.ts`

Responsibilities:

- parse multipart screenshot/video uploads
- validate MIME type, byte limits, dimensions, URL fields, and file signatures
- enforce per-Session upload limits
- write bytes to object storage
- register the artifact with `SessionRuntimeClient`
- rollback object storage writes when artifact registration fails
- stream full or ranged media responses

This module should depend on:

- `ObjectStorage`, implemented by R2 today
- `SessionRuntimeClient`, used to list/register/fetch artifacts

This is the second major portability seam after `SessionRuntimeClient`.

### 9. Background Tasks Interface

Replace direct `ctx.executionCtx?.waitUntil(...)` usage over time with a small portability seam.

Potential interface:

```ts
interface BackgroundTasks {
  defer(task: Promise<unknown>): void;
}
```

The Cloudflare adapter can call `ExecutionContext.waitUntil`. A non-Cloudflare runtime can map this
to a queue, scheduler, or best-effort detached promise.

This can be last because `waitUntil` appears in several route modules and is lower risk when wrapped
after the main Session route extractions.

## Implementation Sequence

### Phase 1: Low-risk extractions

1. Extract `session/identity.ts`.
2. Move identity tests from `router.identity.test.ts` to `session/identity.test.ts`.
3. Introduce `session/runtime-client.ts` with a Cloudflare Durable Object-backed implementation.
4. Update direct Session runtime proxy code to use the new client, without changing route files yet.

### Phase 2: Session route module

1. Create `routes/sessions.ts`.
2. Move Session route definitions and thin proxy handlers from `router.ts`.
3. Keep `router.ts` responsible for auth, SCM gating, metrics, trace headers, and route dispatch.
4. Update `session/contracts.test.ts` so it scans the new files that use `SessionInternalPaths`.

### Phase 3: Use-case modules

1. Extract `session/intake.ts` for `POST /sessions`.
2. Extract `session/prompt-intake.ts` for `POST /sessions/:id/prompt`.
3. Extract `session/child-session-intake.ts` for `POST /sessions/:id/children`.
4. Keep route handlers as endpoint adapters that call these use-case modules.

### Phase 4: Media artifact gateway

1. Introduce `ObjectStorage` and an R2-backed adapter.
2. Extract screenshot/video upload and download/range streaming into `session/media-artifacts.ts`.
3. Route `POST /sessions/:id/media` and `GET /sessions/:id/media/:artifactId` through the gateway.

### Phase 5: Background task portability

1. Introduce `BackgroundTasks`.
2. Wrap `ExecutionContext.waitUntil` in the router request context.
3. Update route modules and use-case modules to call `ctx.backgroundTasks.defer(...)`.
4. Remove direct `ExecutionContext` references from use-case modules.

## Testing Plan

- Keep router-level tests for auth, SCM gating, CORS, trace headers, and route dispatch.
- Move identity helper tests to `session/identity.test.ts`.
- Add direct route-module tests for `routes/sessions.ts`.
- Move create Session behavior tests closer to `session/intake.ts`.
- Move child Session spawn behavior tests closer to `session/child-session-intake.ts`.
- Add focused tests for `SessionRuntimeClient` request construction and correlation headers.
- Add focused tests for `MediaArtifactGateway` upload rollback and range parsing.
- Preserve integration tests:
  - `packages/control-plane/test/integration/child-session-ops.test.ts`
  - `packages/control-plane/test/integration/do-internal-routes.test.ts`
- Update `session/contracts.test.ts` to preserve the invariant that internal Session paths come from
  `SessionInternalPaths` and no raw `http://internal/internal/...` strings are reintroduced.

## Risks and Guardrails

- Avoid turning the refactor into a behavior change. Keep the external HTTP surface stable.
- Avoid introducing hypothetical seams with no second adapter unless the seam isolates an existing
  portability problem, such as Durable Objects, R2, or `waitUntil`.
- Keep `initializeSession` ordering intact: D1 Session index write must happen before Session
  runtime initialization.
- Keep ADR 0001 provider rules intact: provider-specific source-control details stay in provider
  implementations, not router/session layers.
- Keep ADR 0002 protocol rules intact: shared Session contracts remain the source of truth, and
  transport normalization stays explicit.
