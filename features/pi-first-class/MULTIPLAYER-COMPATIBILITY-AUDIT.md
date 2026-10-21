# Pi multiplayer compatibility audit

Scope: go-live commits `d484e480..a1e4bd95`, audited against the reachable implementation on
2026-10-19. This audit is a precondition for Slice 5; it does not add or activate Code Mode,
browser, execution, MCP, external-action, or cross-session capabilities.

## Product authority

Pi is another execution harness behind one Open-Inspect session. It is not another product session,
room, user, permission boundary, or transcript authority.

- **SessionDO is canonical for people and the product:** participants, presence, typing, read state,
  author identity, message ordering, the shared timeline, WebSocket replay/snapshots, visibility,
  teams, collaborators, budget, callbacks, audit, archive/delete, and export.
- **PiSessionDO is subordinate execution state:** the model-facing transcript, inbox, conversations,
  tasks, compaction, tool journals, and per-conversation usage. Its numeric conversation/task IDs
  are opaque identifiers scoped to the owning SessionDO.
- **D1 is long-lived authority:** users, suspension, teams/current membership, collaborators,
  credentials, grants, OAuth, bot ingress, and future cross-session receipts.

Every browser and bot request terminates at an authenticated control-plane route and the owning
SessionDO. No BFF, browser, bot, public route, or Pi tool holds a public PiSessionDO address.

## Findings and corrections

### Corrected: web exposed a parallel Pi transcript

The Slice 4B agent panel returned and displayed the latest assistant text directly from Pi's
internal conversation view. That made Pi look like a second room. The public agents projection now
contains only opaque conversation ancestry, active/queued state, task metadata, usage/cost, and a
bounded entry ID used for authorized fork requests. The public last-message route was removed.

`get_last_message` remains an internal root-agent tool. It traverses the active-operation SessionDO
bridge and can only read a conversation inside the same PiSessionDO. Its text never becomes a public
BFF response.

### Corrected: explicit human controls bypassed the canonical timeline

Web and Slack controls previously wrote only a Pi control receipt before calling PiSessionDO. They
now also write one completed SessionDO message plus one ordinary `user_message` event, atomically
and idempotently, before dispatch. The event carries bounded `piControl` metadata and the verified
participant identity. It uses the existing event sequence, WebSocket broadcast, message list, read
state, timeline, deletion, and trace-export machinery. Pi assistant transcript content is not
copied.

Internal Pi-to-agent controls keep `source: pi`; they do not impersonate a participant or synthesize
a human timeline entry. Their parent tool call/task events remain visible through the current root
operation projection.

### Confirmed: existing harnesses stay on the existing path

OpenCode, Claude, and Codex still enter `SessionMessageQueue`, resolve the existing sandbox command
target, warm/spawn through `SandboxLifecycle`, dispatch through the sandbox WebSocket, and settle
via the existing callback/snapshot path. They never call `PiRuntimeDispatch`. GitHub/Linear behavior
and automation callbacks are unchanged. Slack ordinary text still calls the prompt endpoint and
queues a turn; only exact `follow up now: ...` and `steer: ...` syntax selects the additive Pi
control route.

## Reachable capability boundaries

### A. Cloudflare Computer VFS

- One lazy `Workspace` is constructed inside each PiSessionDO. Its Computer SQLite/VFS state is
  scoped by that Durable Object and deleted with it. The facade exposes filesystem methods only; it
  has no credentials, shell, Git, network, mounts, publishing, or execution authority.
- `/workspace/scratch` means Pi's session-scoped Computer VFS. It is unrelated to an Open-Inspect
  workspace, organization, team, repository grant, or deployment workspace. `/workspace/repos/N` is
  a bounded materialized repository overlay, not provider authority.
- Human use starts with the normal SessionDO prompt/control authorization. Tool reads and mutations
  run under the canonical processing message/operation. Mutation policy memos use task identity,
  enforce scratch/repository roots and quotas, and publish repository changes through SessionDO's
  shared diff service. Existing timeline tool events make activity visible to collaborators.
- There is no browser file route and no direct client VFS binding. Paths cannot cross Pi sessions.
  Trace export includes canonical events/diffs/usage, not raw VFS contents. Session deletion closes
  Computer and deletes its storage; archive/rollback cannot grant new mutations.

### B. Browser Run, Agents Browser, and Kitesurf (not implemented)

Current repository state has no Browser Run binding, Worker Loader binding, `Browser` component, or
browser tool. The pinned `agents@0.28.1` package does not export the current Browser APIs. No
browser capability should be inferred from Pi, Code Mode, or Computer; adoption requires a
separately audited pin upgrade.

Official sources reviewed:

- Cloudflare Agents Browser documentation, updated 2026-10-13:
  <https://developers.cloudflare.com/agents/tools/browser/>
- Browser Run overview and limits, updated 2026-08-11 and 2026-10-14:
  <https://developers.cloudflare.com/browser-run/> and
  <https://developers.cloudflare.com/browser-run/limits/>
- Kitesurf documentation, updated 2026-10-06:
  <https://developers.cloudflare.com/browser-run/kitesurf/>
- Current `cloudflare/agents` browser source (`agents/browser/ai`), inspected from the official
  repository.

The current recommended persistent API is `Browser` plus `browserTool`; it retains a Browser Run
session ID in a Durable Object, gives Pi conversations separate active-tab scopes, and shares
cookies inside that Browser. Live View URLs are bearer credentials and must not be stored or shown
to the model. Calls are not automatically replayed after interruption and default to bounded
timeouts. Legacy `createBrowserTools` is still required for Kitesurf. Kitesurf is beta, stateless,
one-shot, CDP-WebSocket scoped, and does not support reuse, pause/resume, Live View, recording,
`keepAliveMs`, or protocol discovery. It is unsuitable for persistent authenticated browsing.

The Kitesurf product page documents `browser: "kitesurf"` for binding Quick Actions, while the
current Agents Browser guide/source still disables its default Kitesurf Quick Actions and describes
the binding selector as unavailable there. A future implementation must pin compatible Agents and
Workers types, compile the exact binding surface, and canary the selected integration instead of
assuming those two surfaces are interchangeable.

If added later, browser capability must be optional, lazy, deployment-gated, and default off. The
binding stays behind a SessionDO gateway; Pi never receives it directly. Each operation must bind
the current SessionDO participant/action/operation, recheck team/private/current-membership
authority, and require approval for login, cookies, authentication, downloads, uploads, sensitive
navigation, or human takeover. Never copy human cookies implicitly. Apply host/network policy, treat
page text, DOM, screenshots, WebMCP, and downloaded files as untrusted prompt-injection input, and
bound calls, screenshots, artifacts, events, retained state, cost, and session lifetime. Publish
only sanitized artifacts/events to the shared timeline, clean up on delete/rollback, and require
disposable canaries.

### C. Other execution and external capabilities

| Capability       | Subordinate implementation state           | Required Open-Inspect authority                                                                                                                |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Code Mode        | Pi task journal and private QuickJS worker | SessionDO creation snapshot, active operation, task-based policy, budget/audit, emergency deny, shared tool events; no credentials             |
| Lazy execution   | Provider request/receipt state             | SessionDO dispatch/cancel/retry fence, participant action, budget, shared events/artifacts; no direct provider client route                    |
| MCP              | Pi transport/session state                 | D1 OAuth/grant/catalog authority, SessionDO pinned server/tool and active operation, read-only first, approval/egress policy; no token in Pi   |
| External actions | Pi tool task                               | SessionDO prepare/status/approval/execute/revoke ledger and D1 audit projection, current participant authority, reversible provider definition |

All four inherit the owning session's workspace/team/private boundary. Tool calls are never evidence
of human permission by themselves. SessionDO binds them to the current canonical operation and
actor, charges existing budgets, broadcasts sanitized outcomes to current collaborators, and retains
status/cancel/reconcile paths while new admission is off.

### D. Authorized cross-session path (future Slice 9 only)

The only acceptable path is:

1. Pi A tool calls SessionDO A with source session, participant, canonical operation/task,
   capability, target, and stable idempotency key.
2. SessionDO A revalidates source state, participant action, budget, capability, and task ownership.
3. D1 re-reads both sessions and current user status, team membership, visibility, collaborators,
   and grants. It writes immutable source and target audit occurrences plus bounded
   rate/fanout/depth and idempotency state.
4. SessionDO B revalidates target state, permissions, budget, capability, and delivery fence.
   Archived/deleting targets are denied. Suspension, revocation, and membership loss are checked at
   delivery, not only preparation.
5. SessionDO B enqueues its existing message queue with the original human actor and explicit agent
   provenance. Its existing harness path then selects Pi B or a sandbox harness.
6. A bounded public result/summary returns through SessionDO B, D1 receipt, and SessionDO A. Hidden
   target transcript, prompts, credentials, private artifacts, and presence never cross.

PiSessionDO A must never call PiSessionDO B. Cross-team sends require an explicit authorized
collaborator relationship; shared deployment membership alone is insufficient. Workspace sessions
follow workspace grants. Team sessions require current target-team membership. Private sessions
require owner or explicit collaborator. Workspace-admin break-glass remains audited read-only and
never grants send. Owner/admin status does not bypass a target session's collaborate/lifecycle
action rules.

Required tests cover same-team member, removed member, suspended user, private owner, private
collaborator, private outsider, workspace member, workspace admin read-only break-glass, explicit
cross-team collaborator, unauthorized cross-team member, archived target, deleting target,
revocation between preparation/delivery, duplicate delivery, fanout/depth/rate limits, and target
harness parity.

### E. Pi/Agents feature placement and activation order

| Feature                           | Existing service to reuse                                                          | Product rule                                                                           | Activation order                           |
| --------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------ |
| Durable inbox/scheduling          | SessionDO message queue and alarms                                                 | Pi inbox is execution detail; human work always enters SessionDO ordering              | Already active for ordinary Pi prompts     |
| Task graph/inspect                | SessionDO-authorized bounded BFF                                                   | Opaque metadata only; no parallel presence/read state or hidden transcript             | Read surface after redaction tests         |
| Compaction                        | Pi conversation task + SessionDO control receipt                                   | Explicit permission, canonical control event, bounded cost                             | After native controls                      |
| Skills                            | SessionSkillStore and creation-time session context                                | Same managed installation as other harnesses; no secret-bearing skill payload          | Existing read path                         |
| Memory                            | The existing D1 memory authority, reached through the session's own internal route | No Pi-private product memory authority                                                 | Existing service only                      |
| Attachments/images                | Existing attachment/media stores and timeline                                      | Pi gets scoped references only after support; no inline secret bytes or private bypass | After provider-safe Pi attachment contract |
| Browser                           | Future SessionDO browser gateway                                                   | Optional/lazy/default off; isolated credentials and untrusted-content policy           | After Code Mode safety and browser canary  |
| MCP resources/prompts/elicitation | Future D1 OAuth catalog + SessionDO broker                                         | Read-only resources first; prompts/elicitation require explicit UX and approval        | After OAuth/egress foundation              |
| Cross-session messaging           | Future D1 dual receipt path                                                        | Existing target queue and actor provenance, never PiDO-to-PiDO                         | Last, after all RBAC cases pass            |

## Regression evidence required

- Control unit and workerd tests prove one canonical control message/event, idempotent replay,
  participant attribution, two-client WebSocket broadcast, and no Pi assistant text in SessionDO.
- Frozen route/admission matrices cover read/collaborate/lifecycle and service-actor restrictions.
- Existing participant, presence, typing, read-state, collaborator, visibility, user-merge,
  deletion, export, budget, callback, stop, prompt queue, and non-Pi harness suites remain green.
- Web tests prove BFF-only access, opaque agent metadata, permission-gated controls, keyboard/focus,
  confirmation, live-region, mobile, and reduced-motion behavior.
- Slack tests prove signature/actor binding, stable idempotency, strict explicit syntax,
  ordinary-text queueing, mapping/closure, and callback behavior. Automation/GitHub/Linear suites
  prove no change.
