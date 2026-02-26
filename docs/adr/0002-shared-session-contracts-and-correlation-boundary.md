# ADR 0002: Shared Session Contracts and Correlation Boundary Rules

## Status

Accepted

## Context

Session websocket and sandbox event contracts were duplicated across `shared`, `control-plane`, and
`web`, which caused drift in discriminated unions, message variants, and status fields. This drift
created many small per-file edits and increased regression risk when adding protocol features.

Correlation naming also drifted between `traceId`/`requestId` and `trace_id`/`request_id` in
provider and client boundaries, making tracing behavior harder to reason about.

## Decision

1. **`@open-inspect/shared` is the protocol source of truth**
   - `ClientMessage`, `ServerMessage`, `SandboxEvent`, and `SessionState` are defined in shared.
   - `control-plane` re-exports these types instead of maintaining local protocol duplicates.

2. **Boundary normalization is explicit**
   - `web` can keep UI-local types, but must normalize shared protocol payloads at the websocket
     boundary before storing in UI state.
   - Adapter helpers are preferred over ad-hoc inline casts.

3. **Correlation naming is canonical at transport boundaries**
   - Canonical keys: `trace_id`, `request_id`, `session_id`, `sandbox_id`.
   - Headers: `x-trace-id`, `x-request-id`, `x-session-id`, `x-sandbox-id`.
   - Provider/client configs use a `correlation` object with canonical snake_case keys.

4. **Provider/client layering is enforced**
   - Provider implementations delegate outbound HTTP/auth mechanics to `ModalClient`.
   - Providers are responsible for lifecycle semantics and error classification, not raw fetch/auth
     wiring.

## Consequences

### Positive

- Protocol changes are made once and propagated consistently.
- Type-level drift between backend and frontend is reduced.
- Correlation propagation is easier to audit and query in logs.
- Provider abstractions have cleaner responsibilities.

### Negative

- UI layers may need lightweight normalization code when shared contracts are stricter than local
  rendering needs.
- Protocol changes in `shared` can trigger coordinated updates in consumers.

## Follow-Up Rules

- New websocket or sandbox event variants must be added in `packages/shared` first.
- Do not reintroduce parallel protocol definitions in feature packages.
- Keep correlation key naming canonical at every external boundary.
