# ADR 0004: Shared First-Party Client API

## Status

Accepted

## Context

The CLI and local MCP server need revocable login credentials, retry-safe session mutations, and
bounded resource reads. Mobile and desktop applications will need the same product operations.
Browser authentication currently uses a Better Auth session over the signed web BFF channel.
Different authentication mechanisms do not justify different session creation or authorization
rules.

## Decision

1. **One versioned human-client resource contract**
   - `/external/v1` is the shared first-party resource API, not a CLI-only API. The existing URL is
     retained; `external` distinguishes client resources from service, callback, and sandbox APIs.
   - Web, CLI, MCP, and future native clients share resource semantics and canonical human RBAC.
     UI-specific aggregation may remain in the BFF; it must not own session admission policy.
   - Client-surface metadata is bounded diagnostic text, not an authorization grant or allowlist.

2. **Authentication adapters remain explicit**
   - Shared resource routes opt into browser-session-over-`service:web` OR revocable bearer auth.
     Both resolve to `principal.kind: "user"`. A failed signed-channel attempt is terminal; it never
     falls back to a bearer. A web service signature alone is not a human credential.
   - Existing internal routes do not automatically accept bearers. Credential inspection/revocation
     still requires the bearer being managed. Device approval still requires a browser session.
   - The current device flow and `oi_cli_` credential format remain supported. A native browser/PKCE
     login flow can be added at the authentication boundary without a new session API; this change
     does not implement that login flow or distribute service-signing secrets to native clients.
   - SCM credential authority is separate from resource access. Browser sessions retain linked
     Better Auth account enrichment. Device credentials retain the GitHub App fallback; they do not
     silently gain access to the legacy user-token store.

3. **Human session creation has one owner**
   - `createUserSession` owns target/configuration resolution, model admission, permissions, initial
     prompt dispatch, and retry-safe reservation/bootstrap recovery for both route families.
   - The legacy web `/sessions` POST is a compatibility adapter preserving its response shape. Its
     `Idempotency-Key` maps to the versioned create body's `idempotencyKey`; scope is the canonical
     user, not the client or credential. Repeating a key with different input is a conflict.
   - Web warm-session creation retains its key across unknown network results and rotates it for a
     different launch or consumed session. Older web callers without a key still create a fresh
     operation, without a cross-request retry guarantee.
   - Existing service-actor creation remains an integration adapter, not a native-client API.
     Existing reservation column names and session-ID derivation remain unchanged for retry
     compatibility with earlier versions of this PR.

4. **Readers tolerate additive responses; producers project explicitly**
   - Client response schemas validate required fields but discard unknown fields, including nested
     fields. Unknown event type names can be transported without breaking the entire event page.
   - Request schemas remain strict. Tolerant response readers are not a redaction boundary: server
     handlers still select public fields and sanitize events before serialization.
   - Breaking changes require a new API version or a documented deprecation period. Installed CLI
     and native releases are not assumed to upgrade in lockstep with the server.

5. **Event consumption and UI synchronization have different guarantees**
   - ADR 0003 remains authoritative for UI hydration: a canonical snapshot followed by semantic
     WebSocket updates. The event journal is not a second whole-session view or a replacement for
     the snapshot-to-socket handoff.
   - The journal serves a stronger, bounded event-consumption requirement: a disconnected consumer
     can observe persisted event revisions, renames, and deletions since its checkpoint. Historical
     timestamp pagination alone cannot provide that guarantee when an old event is revised.
   - This costs additional writes and retention/pruning work on the shared event path, including
     sessions not currently followed by the CLI. Retain the existing time/count/byte limits and
     explicit checkpoint-expiry recovery. No reconnect-bandwidth improvement is claimed.
   - Native UI clients should not be required to replay the journal merely to render current state.
     Native socket/token admission is follow-up work on shared resources, not a separate mobile or
     desktop synchronization API. Extending the journal to other session-view mutations requires a
     separate decision and the evidence required by ADR 0003.

## Incremental Web Migration

1. This change shares human creation behind the existing web URL, enables authenticated BFF access
   to the versioned resources, and shares creator-filter resolution. Existing web reads and sockets
   keep their contracts.
2. Move BFF resource reads to the versioned contract one resource at a time, adding fields the web
   actually needs and parity tests. Keep user-specific read-state decoration and UI aggregation
   explicit; do not silently drop them to force migration.
3. Add remaining native product operations and socket admission to the same client API. Remove
   obsolete web adapters only after their consumers have migrated. Bot and sandbox APIs are not
   implicitly included in that migration.

## Consequences

- Authentication can evolve independently from session behavior and client release schedules.
- Shared creation fixes and admission policy apply to web and native clients together.
- Human web creation now uses the same enabled-model and permission checks as the versioned API;
  invalid settings are rejected rather than silently replaced.
- The BFF and temporarily different wire shapes remain, but overlapping human operations have one
  implementation. The event journal's additional write cost remains explicit and bounded.
