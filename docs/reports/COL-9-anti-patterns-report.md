# COL-9: Anti-Pattern Investigation Report

## Scope and approach

This report reviews architecture and implementation anti-patterns across the `background-agents`
codebase, with emphasis on maintainability, correctness, and operational risk. Findings are based on
direct inspection of runtime code paths in `control-plane`, `web`, `slack-bot`, and `shared`.

## Executive summary

The codebase is functional and well-tested, but several structural anti-patterns are slowing
iteration and increasing risk:

1. **God modules** in critical runtime surfaces (`SessionDO`, Slack bot entrypoint, WebSocket hook).
2. **Ad hoc logging/observability** patterns in production request paths and client connection
   logic.
3. **Identity fallback semantics** (`"anonymous"`) repeated across API boundaries, which can hide
   auth/data issues.
4. **Unsafe type coercion boundary** in GitHub webhook normalization (`as unknown as`) with only
   partial runtime validation.
5. **Retry flow coupling in UI** (`sendPrompt` self-retry via `setTimeout`) that can create hidden
   queued retries.

These are not immediate blockers, but they are compounding sources of fragility as the system grows.

## Findings

### 1) God module pattern in core runtime classes

**Evidence**

- `packages/control-plane/src/session/durable-object.ts` (1817 lines) combines routing, lifecycle
  orchestration, websocket flow, auth/token concerns, child-session orchestration, PR flow wiring,
  persistence access, alarm handling, and callback integration.
- `packages/slack-bot/src/index.ts` (2006 lines) combines Slack verification, command routing, repo
  resolution, thread/session persistence, UI/modal logic, classifier calls, control-plane transport,
  and callbacks.
- `packages/web/src/hooks/use-session-socket.ts` (784 lines) combines transport connection
  management, replay/event transforms, participant state, reconnection, optimistic state, and UI
  store concerns.

**Why this is an anti-pattern**

- Violates single-responsibility boundaries.
- Increases blast radius of changes and regressions.
- Raises cognitive load and slows onboarding/review.

**Impact**

- Medium to high maintainability risk; elevated probability of incidental breakage in unrelated
  features.

---

### 2) Ad hoc logging in production paths

**Evidence**

- Client websocket hook uses many `console.log` calls in hot path connection lifecycle:
  - `packages/web/src/hooks/use-session-socket.ts:286`
  - `packages/web/src/hooks/use-session-socket.ts:523`
  - `packages/web/src/hooks/use-session-socket.ts:551`
  - `packages/web/src/hooks/use-session-socket.ts:588`
  - `packages/web/src/hooks/use-session-socket.ts:653`
- API routes emit request timing via `console.log`:
  - `packages/web/src/app/api/sessions/route.ts:35`
  - `packages/web/src/app/api/sessions/[id]/ws-token/route.ts:55`

**Why this is an anti-pattern**

- Unstructured logs are hard to aggregate/filter compared to centralized structured logging.
- Can leak sensitive context in browser consoles and make local debugging noisy.
- Creates inconsistent observability semantics across services.

**Impact**

- Medium operational and debugging cost.

---

### 3) Repeated `"anonymous"` identity fallback across trust boundaries

**Evidence**

- Web API routes derive user identity with fallback:
  - `packages/web/src/app/api/sessions/route.ts:61`
  - `packages/web/src/app/api/sessions/[id]/ws-token/route.ts:32`
  - `packages/web/src/app/api/sessions/[id]/prompt/route.ts:24`
  - `packages/web/src/app/api/sessions/[id]/title/route.ts:14`
  - `packages/web/src/app/api/sessions/[id]/archive/route.ts:15`
  - `packages/web/src/app/api/sessions/[id]/unarchive/route.ts:15`
- Control-plane request handling also accepts fallback behavior:
  - `packages/control-plane/src/router.ts:770`
  - `packages/control-plane/src/router.ts:1072`
  - `packages/control-plane/src/routes/automations.ts:267`

**Why this is an anti-pattern**

- Masks identity propagation bugs (missing user IDs appear "valid").
- Can weaken attribution/audit quality for sensitive operations.
- Duplicated logic creates drift between services.

**Impact**

- Medium correctness and auditability risk.

---

### 4) Unsafe type coercion at webhook normalization boundary

**Evidence**

- `packages/shared/src/triggers/github/normalizer.ts:92` uses:
  - `const typedPayload = payload as unknown as SupportedGitHubPayload;`

**Why this is an anti-pattern**

- Bypasses TypeScript safety at a key external-input boundary.
- Current checks validate event/action and select numeric fields, but not full payload shape.
- Future fields/access paths may assume presence and regress into runtime failures.

**Impact**

- Medium risk at integration boundaries.

---

### 5) Recursive prompt-send retry coupling in UI socket hook

**Evidence**

- `packages/web/src/hooks/use-session-socket.ts:649` retries by recursively calling `sendPrompt`
  through `setTimeout` when subscription is not ready.

**Why this is an anti-pattern**

- Retries are hidden inside user action flow with no bounded queue semantics.
- Can create stale retries after state transitions unless carefully cancelled.
- Mixes transport readiness concerns with user intent lifecycle.

**Impact**

- Low to medium correctness/UX risk, especially under reconnect churn.

## Prioritized remediation plan

### Phase 1: fast risk reduction (1-2 sprints)

1. Introduce shared identity resolver utility and remove `"anonymous"` fallback for authenticated
   endpoints; fail closed where identity is required.
2. Replace route/client `console.log` usage with structured logger wrappers and environment-gated
   debug logging.
3. Add guardrails around prompt send retries (bounded retries + cancellation on unmount/disconnect).

### Phase 2: boundary hardening (2-3 sprints)

4. Add runtime schema validation (e.g. Zod) for GitHub webhook payload/event-specific shapes before
   normalization.
5. Add explicit error telemetry for rejected/invalid payloads to improve diagnostics.

### Phase 3: modularization (incremental)

6. Split `SessionDO` by transport/orchestration concerns (routing adapter, ws session service,
   lifecycle coordinator, auth/token service).
7. Split Slack bot entrypoint into command handlers, session service, and Slack UI/message service
   modules.
8. Split `useSessionSocket` into composable hooks (`useSessionTransport`, `useSessionReplay`,
   `useSessionPresence`, `usePromptDispatch`).

## Suggested success metrics

- Reduce line count of top 3 runtime god modules by at least 40% each over staged refactors.
- 100% of authenticated write endpoints use strict identity resolver with no `"anonymous"` fallback.
- 0 direct `console.log` calls in production web app codepaths (except explicitly gated debug
  utility).
- 100% of external webhook boundaries validated with runtime schemas.

## Notes

This issue requested investigation and reporting. No behavioral code changes were made in this pass.
