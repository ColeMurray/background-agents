# DIV-83: Modal startup timeout diagnosis and reconciliation runbook

The replacement DIV-77 smoke exceeded OpenInspect's HTTP create deadline before a successful create
response or runtime connection was recorded. **The provider root cause remains unresolved.** The
historical logs establish that a create handler ran and was canceled in the incident window, but
missing correlation prevents uniquely assigning it to this session. Evidence cannot distinguish
endpoint queue/cold start, Python dependency hydration, SDK transport/provider RPC delay, or a
response lost after creation. A client timeout is not proof that no sandbox was created, and the
current pending prompt is not safely canceled.

This is a read-only diagnosis against main `90205f3f9c4f4ad30babe67d5ab5bb550a7f9743`, for
[DIV-83](https://linear.app/divinedesign/issue/DIV-83). No application code, deployment, host
setting, live state, or publication flag changed. No model worker or provider probe was launched.
The [separate proposal](../proposals/modal-startup-reconciliation.md) requires review and
implementation.

## Evidence and timeline

Historical operator reports are the preserved DIV-77 checkout's
`docs/deployments/investigation-profile-retry-2026-09-16.md` and
`docs/deployments/investigation-profile-pilot-2026-09-16.md`, under
`/home/orca/orca/workspaces/background-agents/div-77-investigation-profile-pilot/`. They are
operational evidence, not claims that this checkout performed those actions. Private artifacts below
are under `/home/orca/.local/state/openinspect/div77-resume-20260916/`; they were read selectively
without publishing raw request bodies, callback context, credentials or state.

| UTC, 2026-09-16    | Observation and source                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 18:20:00           | Historical release report: Modal v5, source `63ce1fe338e4609f58d273db9054320a4962e28b`, image `im-O9SN8sTS5qzxtJiKOogXRH`, SDK 1.5.5; mandatory image verification passed.                                                           |
| 18:29:37.913       | Session index creation for `4d503f4c1ef79561c455554a81da881b`, from `DIV-82-watch.json`.                                                                                                                                             |
| 18:29:38.608       | Session DO creation time in `session-snapshot.json`; distinct from index creation.                                                                                                                                                   |
| 18:29:39.638       | Message `11ba12219d8393c7a4448a3877c4314c` created, source Linear; `messages-final.json`.                                                                                                                                            |
| Uncaptured         | Actual outbound create start, HTTP headers/body timing, Modal input/container start, SDK RPC start and provider allocation. Do not manufacture a failure timestamp by adding 60 seconds to session creation.                         |
| Unstamped snapshot | `sandboxStatus=failed`, `isProcessing=false`, pending queue and `Failed to create sandbox: Modal request timeout after 60000ms (createSandbox)`; `session-snapshot.json`.                                                            |
| 18:35:44           | Separate local SDK diagnostic connects to `api.modal.com` and sends `AppList`; `modal-debug.log` has only these two lines. Historical report says the diagnostic was stopped after 25 seconds. It is not the create request's trace. |
| 18:36:55.979       | First stop request capture, response `stopping`; `stop-smoke.json`. This is 7m18.066s after index creation, not confirmed termination.                                                                                               |
| 18:37:13.492214    | Empty sandbox listing; `sandboxes-stop.json`.                                                                                                                                                                                        |
| 18:37:47           | Historical report: Linear implementation routing restored, publication still false.                                                                                                                                                  |
| 18:39:03.387       | WebSocket cancellation returned `PROMPT_NOT_CANCELLABLE`; `cancel-pending.json`. The error text's suggestion that the prompt is no longer pending conflicts with the message read.                                                   |
| 18:39:43.672       | Last index watch sample: session active, message_count 0, cost 0; this does not mean there is no pending DO message.                                                                                                                 |
| 18:42:55.090279    | Empty sandbox listing; `sandboxes-final.json`.                                                                                                                                                                                       |

The final message read has null `startedAt`/`completedAt` and status `pending`. The event capture is
empty. The historical report also records a separate `App.lookup` InternalError `QC2HBPC8`,
intermittent health timeouts followed by HTTP 200, and an operational provider status page; exact
lookup/health timestamps and create-correlated provider telemetry are absent from these artifacts.
`modal-startup.log` is zero bytes, not evidence that the remote handler never ran. No runtime
report, tool/token events or model charges were recorded. Infrastructure/classifier cost is unknown.

Artifact integrity anchors (SHA-256; do not upload the underlying files):

```text
session-snapshot.json  40c47180107874044c54eb8acf5a4d364f9a9297bbb92bdeb8b9d8abbbda35fb
DIV-82-watch.json      df7d796440e31fefddcbfd472697e1a60b3405c7f1f377e0882cfcc8e440795f
messages-final.json    716de2b38a6174518b44f7706c1bd84d00a91a71d17d4a4bc9b06466858cf98f
stop-smoke.json        958af520a5b2be67024d1d9c12419ce896ac587872219c1bb7f9b797bbf1a15e
sandboxes-final.json   255fe535a86f05e5530964b67b16435550efd4cfbdf9314aa402e00aff4c5b68
modal-debug.log        b3ecf17b1b5fc13ce31b8b0389bd7b8d4e9f3af4d44321625da1198765471e3c
```

## Additional coordinator-owned observations

The coordinator subsequently supplied read-only observations from
`/home/orca/.local/state/openinspect/reliability-20260916/`:

- `snapshot-1789584737.json`, 18:52:17 UTC: the same active session, failed sandbox, pending
  message, zero timeline events and recorded cost, and unchanged create timeout error.
- `sandboxes.json`, 18:52:54.883 UTC: no active sandboxes in exact app `ap-qbOmsZyI5zLYCaqhL8d5zP`.
  Authenticated message reads still report Linear origin and null start/completion. D1 has only this
  active session. Publication remains false, routing implementation, Linear version
  `3441ec5f-2356-4d52-8ad8-82611852be35`, control-plane version
  `0c4dbf1a-6392-4f61-b5fd-d2e714ae8b08`. Health returned 200 in 4.53 seconds.
- `modal-app-window.log`: coordinator's bounded historical query for exact app/environment
  `div61-dev`, 18:28–18:43 UTC, capped at 300 lines, returned four lines. SHA-256:
  `06ca938470c872a12c5430a92be89d20ddd7a17de9098194a10392aaa08ec7ac`.

Selectively parsed provider log facts:

| Field                         | Sanitized value                                                    |
| ----------------------------- | ------------------------------------------------------------------ |
| Function                      | `fu-KS1yjGeQXxnQjFr6VhqZms`                                        |
| Call                          | `fc-01M2NQPK6AX6ZA4AGD5WX51MXM`                                    |
| Container                     | `ta-01M2NQQT3B05YP9CDV8G5VZ8BR`                                    |
| Input in cancellation warning | `in-01M2NQPK6E951SDPE6VYFDFCM8`                                    |
| Cancellation warning time     | 18:33:40.568 UTC                                                   |
| Endpoint completion time      | 18:33:40.573 UTC                                                   |
| Endpoint/result               | `api_create_sandbox`, HTTP 499, outcome error, duration 196,126 ms |
| Correlation                   | trace, request, session and sandbox IDs all null                   |

The endpoint's measured duration implies wrapper entry around **18:30:24.447 UTC**, assuming
consistent wall-clock measurement. That is an inference, not a captured start event. Source maps 499
to `asyncio.CancelledError`, so this is positive evidence of handler execution and cancellation, not
merely a cold container that never entered Python. It does not identify the interrupted await, prove
the cause/timing of cancellation, or show whether SandboxCreate reached the provider. The absence of
session/trace IDs prevents treating this call as uniquely correlated to the stuck session, despite
the matching app, endpoint and incident window. No provider object ID or `sandbox.create` success is
present. Cancellation at this wrapper is not a rollback receipt. The coordinator should retain these
IDs alongside error `QC2HBPC8` for any separately authorized provider investigation; no external
support message is authorized by this document.

Conditional stage inference: for this investigation configuration, authentication, validation and
manager setup are synchronous; the first substantive asynchronous external operation is
`modal.Sandbox.create.aio`, including dependency hydration and its provider RPC. Tunnel setup has no
ports to await. If the historical call is this attempt, cancellation most plausibly interrupted that
SDK create/hydration await. This does not distinguish dependency lookup from transport or
SandboxCreate processing, and it is not direct stack evidence. The 196-second handler duration also
shows why the client deadline and remote cancellation must be measured independently.

## What timed out

1. [`ModalClient.postJson` and `createSandbox`](../../packages/control-plane/src/sandbox/client.ts)
   sign headers, then call `withRequestDeadline` around fetch **and response-body consumption**.
   `MODAL_SANDBOX_START_REQUEST_DEADLINE_MS` is 60,000. Header signing is outside that deadline; the
   enclosing `modal.request` duration includes it. The error alone does not tell us whether HTTP
   response headers arrived before body consumption stalled.
2. [`withRequestDeadline`](../../packages/control-plane/src/sandbox/request-deadline.ts) aborts the
   local fetch signal and translates a deadline-caused rejection. It sends no provider cancel,
   termination or reconciliation request. This is neither a Modal Function timeout nor an SDK
   `Sandbox.create` timeout. The Modal provider classifies it as transient; that describes circuit
   breaker accounting, not permission to retry or proof of provider nonexecution.
3. [`api_create_sandbox`](../../packages/modal-infra/src/web_api.py) is its own Modal Function. Once
   its container enters the handler, HMAC authentication and validation precede the manager import
   and create call. `_execute_endpoint` emits a completion log, including status 499 on coroutine
   cancellation, but does not compensate by terminating a potentially created sandbox. A missing
   completion log cannot locate the failure stage.
4. [`SandboxManager._launch_sandbox`](../../packages/modal-infra/src/sandbox/manager.py) resolves
   the image, environment/secrets and network policy, then awaits `modal.Sandbox.create.aio`. It
   returns the provider object ID only after that await and tunnel setup. For investigation,
   ports/editor/VNC/terminal are disabled and the tunnel helper returns immediately. This is not the
   prior image-build VNC readiness failure. The deployed base reference is loaded via
   [`images/base.py`](../../packages/modal-infra/src/images/base.py); sandbox image building is
   deliberately performed before deployment, not per session.
5. [`doSpawn`](../../packages/control-plane/src/sandbox/lifecycle/manager.ts) stores the returned
   provider ID only on success. On the observed error it marks the current in-flight generation
   failed and persists the reason. The investigation path excludes repository images, so the
   prebuilt-image fallback retry is not applicable. A separate initial-connect watchdog is
   configured by `CONNECT_WATCHDOG_MS` (240,000 ms); it is not this 60,000 ms error. Its alarm skips
   already-failed rows. The sandbox lifetime uses `DEFAULT_SANDBOX_TIMEOUT_SECONDS`, a separate
   lifetime policy that does not bound all pre-creation delays.

[Modal's Function timeout documentation](https://modal.com/docs/guide/timeouts) distinguishes
execution from scheduling and container startup; this endpoint sets neither an explicit function
execution timeout nor startup timeout. Current documented default execution timeout is 300 seconds,
excluding scheduling; it therefore cannot prove settlement at creation time plus five minutes.
[Web Function request documentation](https://modal.com/docs/guide/webhook-timeouts) describes a
150-second HTTP threshold and result redirects, which occur later than our deadline. Neither
mechanism establishes that aborting this client request rolls back provider effects.

[`api_health`](../../packages/modal-infra/src/web_api.py) is a separate unauthenticated function
returning a constant. A 200 there proves that endpoint responded, not create-endpoint warmness, HMAC
readiness, dependency hydration, sandbox allocation or runtime readiness. Modal documents
[cold starts and request queueing](https://modal.com/docs/guide/webhooks#performance-and-scaling).

The preserved deployment venv's Modal distribution metadata reads **1.5.5**. Read-only inspection of
its `modal/sandbox.py`, `_grpc_client.py` and `_utils/grpc_utils.py` shows that create hydrates
provider dependencies then calls a wrapped SandboxCreate RPC, with SDK retry machinery and a
per-call idempotency key. There is no OpenInspect generation key persisted across independent HTTP
create calls. This is evidence about the installed SDK, not proof of which RPC or retry ran in the
remote endpoint: `app.py` installs `modal` without a version pin in `function_image`, so remote
function SDK identity must be verified separately from the deployment CLI's SDK label. No change to
that dependency was made here.

## Delayed effects and remaining cause uncertainty

A delayed or response-lost sandbox is possible by source semantics; none was observed. The
[Sandbox API](https://modal.com/docs/reference/modal.Sandbox) creates its container asynchronously.
The inspected 1.5.5 list implementation sets `include_finished=False` and paginates; an empty active
listing cannot rule out an already-finished object, a queued create, a different environment, or a
future allocation. SDK transport retries within one RPC do not make a new HTTP create safe.
OpenInspect sends its logical ID as an environment value, not a Modal name/tag, so that ID cannot be
passed to `Sandbox.from_id` in place of a provider `sb-…` object ID.

There is also a concrete application hazard: the
[`connection authenticator`](../../packages/control-plane/src/session/connection-authenticator.ts)
explicitly admits a **failed** sandbox with valid current credentials, marks it ready and schedules
queue processing. [`failAttempt`](../../packages/control-plane/src/sandbox/lifecycle/manager.ts)
does not revoke those credentials. The
[`stop coordinator`](../../packages/control-plane/src/session/execution-stop-coordinator.ts) returns
early when no processing message exists, and
[`cancelPendingMessage`](../../packages/control-plane/src/session/message-repository.ts) accepts
only web-origin messages without callback context. Thus the recorded failed status and stop response
do not fence a late bridge from dispatching this pending Linear message. The Modal provider
advertises `supportsExplicitStop: false`; existing image-build termination endpoints must not be
repurposed as an undocumented session repair path.

Provider/control-path impairment is consistent with the independent InternalError, stalled AppList
and intermittent health observations, but no shared trace establishes causation. Endpoint cold
start, hydration/RPC delay and response loss remain alternatives. No evidence attributes this
failure to VPS memory, model resolution, the investigation boundary or the verified image. The
[DIV-81 diagnosis](investigation-model-resolution-2026-09-16.md) and
[investigation contract](investigation-profile.md) remain applicable; this attempt never tested
successful inference. Resolving the provider cause needs the original endpoint input/container and
RPC records, or provider-side investigation by an authorized owner. No support message was sent.

## Bounded coordinator-owned procedure

This is a proposed operator runbook using supported read/termination surfaces; it is **not an
executed repair**. DIV-84 must supply the missing supported application settlement operation before
this session can be declared safe. All live observations and mutations belong to the coordinator.

1. **Hold.** Keep publication false and restored routing unchanged. Do not prompt, warm, restart,
   retry create, delete an index row or bypass authentication. Preserve the two IDs above and all
   callback/evidence records. Reading status does not authorize mutation.
2. **Capture once, bounded.** Coordinator records exact UTC and deployed versions, current
   authenticated session/message/queue snapshots, runtime events and callback state. Retrieve
   retained `modal.request`, `sandbox.spawn`, `modal.http_request`, `api.error` and `sandbox.create`
   records for 18:29–18:43 UTC, plus Modal input/container lifecycle records. Start with the
   call/input/container IDs above; ask for the exact cancellation source and accepted/finished
   SandboxCreate RPC outcome. Join trace/request, session and logical sandbox IDs; include provider
   object ID if found. A missing log is unknown, not a successful negative. Do not capture
   credentials, full environment values or callback bodies.
3. **Fence through a reviewed API.** After DIV-84 review, tests and separately authorized release,
   use its documented authenticated stop/cancel operation for this exact pending message. Require
   durable terminal message state, preserved callback outcome/delivery identity, and prevention of
   dispatch from both an already-connected bridge and a later connection using the old generation. A
   race where pending becomes processing must use the processing-stop path. Repeat reads must show
   no pending/processing work. A `stopping` response alone fails this gate. There is no known safe
   current-code direct state-edit substitute; if the operation is unavailable, stop here.
4. **Reconcile provider effects.** With the existing authorized Modal identity and exact
   environment, resolve the existing app with creation disabled, then fully consume an app-scoped
   `Sandbox.list`. Use a 30-second total deadline per observation pass (lookup plus listing), at
   most three passes separated by 30 seconds. These are proposed operator limits, not provider
   completion guarantees. Any error, partial pagination or ambiguous scope is inconclusive. Consult
   retained provider input/history records for the original create and finished sandboxes as well.
   Do not infer identity from repository name or creation time alone.
5. **If an exact orphan is identified**, preserve its provider ID and correlation evidence, then,
   only under separate cleanup authorization, use supported `Sandbox.from_id(...).terminate()`.
   Confirm completion with `poll()`/`wait()` under a 30-second observation deadline and retain the
   exit code; a sent termination request is not confirmed termination. Never terminate unrelated app
   sandboxes. If the provider cannot confirm create settlement or object identity, retain
   `provider outcome unknown`, keep the application fence and escalate to the coordinator. Do not
   loop until a reassuring empty response appears.
6. **Record settlement.** Complete means the original create is known terminal/no outstanding
   allocation, each attributable object is terminal, and application queue/callback disposition is
   durable. An empty listing plus elapsed lifetime is insufficient because scheduling precedes
   lifetime. Archive only through the normal authenticated API after queue settlement; preserve the
   durable session and history. Provider uncertainty can remain externally blocked without endless
   polling or a new pilot.

The SDK's supported list, attach, terminate and poll operations are documented in the
[Sandbox reference](https://modal.com/docs/reference/modal.Sandbox); confirm the actual installed
version before using optional arguments. This worker performed none of those live operations.

## Readiness and prerequisites for any later retry

After settlement, the coordinator may authorize a bounded non-creating readiness check: one
30-second pass for app lookup/list and service health, and one authenticated POST of exactly `{}` to
the deployed create endpoint. Source validation returns 400 before manager import/create because
required fields are absent. Record the expected validation response and correlation log; do not
substitute an empty-auth request or a valid launch body. This exercises endpoint startup/auth but
**does not** prove sandbox allocation, SDK dependency hydration or runtime/model readiness. Stop on
unexpected success, timeout, auth error or wrong deployment identity; do not automatically repeat. A
dedicated authenticated readiness endpoint is proposed separately.

A later model retry requires all of: reviewed DIV-84 repair and confirmed fence/settlement; provider
readiness observations with unresolved creation effects closed; verified exact deployed source/image
and remote SDK identity; unchanged mandatory image verification and investigation restrictions;
publication false; a fresh explicit execution allowance, task, model and time/spend bounds; and an
owner collecting correlated startup telemetry and performing cleanup. No leftover A/B execution slot
overrides the failed-smoke stop rule. A credential-free provider canary, if needed, is itself a
separately approved create with a finite lifetime and confirmed termination; it is not implicit
authorization to start OpenInspect. A/B and publication remain separate gates.

## Validation and limits of this change

Only documentation changed. Source paths, stored timestamps and artifact hashes were checked;
Markdown formatting and `git diff --check` are the appropriate local checks. No package install,
application build, unit/integration suite, paid request or live observation ran in this worker.
DIV-84 owns the heavy-work slot. The documents do not establish provider recovery, cancellation,
callback delivery, root cause or successful investigation execution.
