# Provider account rotation: rollout and recovery

Implementation of the first release in the [design](plans/provider-account-rotation.md) and
[implementation plan](plans/provider-account-rotation-implementation-plan.md): fixed/random
new-session allocation and manual same-provider, same-harness, same-auth-mode account switching.
Structured provider-limit classification, automatic fallback, and round robin remain follow-ups.

## Release status

**Not live-qualified.** No non-production account pairs or paid inference probes have been
authorized yet. Automated tests exercise the protocol and failure paths, not provider behavior. Do
not advertise a supported pair or enable switching until the qualification below passes.

| Candidate runtime path | Credential path                                         | Live qualification |
| ---------------------- | ------------------------------------------------------- | ------------------ |
| OpenCode / OpenAI      | Codex subscription broker and account-specific header   | Pending            |
| OpenCode / xAI         | OAuth broker and plugin restart                         | Pending            |
| Claude / Anthropic     | SDK disconnect/recreation and exact conversation resume | Pending            |

The runtime manifest is `v72-provider-account-rotation` (generation 72). Existing images and
snapshots do not gain this capability merely because the control plane was deployed. Qualify each
concrete sandbox provider's snapshot/retained-resume path separately, including hard expiry.

## Controls and deployment order

1. Apply global migration `0081_provider_account_rotation.sql`; session schema upgrades to 55. Back
   up using the installation's normal procedure. Existing fixed defaults and account bindings retain
   their choices; existing binding revisions start at 1.
2. Deploy compatible control-plane and web readers/writers. Keep both admission controls disabled:
   - `PROVIDER_ACCOUNT_RANDOM_ENABLED=false`
   - `PROVIDER_ACCOUNT_SWITCH_ENABLED=false`
3. Deploy the runtime with `PROVIDER_ACCOUNT_SWITCH_QUALIFIED` empty. This comma-separated allowlist
   is propagated from the control plane into managed runtime configuration. Candidate values are
   `opencode/openai`, `opencode/xai`, and `claude/anthropic`; they are **not** preapproved defaults.
4. Random allocation can be released separately after SQL-host and creation-path qualification.
   Enable its flag, then explicitly save an eligible random pool in Settings. Existing sessions
   never reroll; pins override policy and children inherit the parent's binding at admission.
5. In an approved non-production installation only, configure the candidate pair and enable switch
   admission for qualification. Keep production admission disabled until evidence is reviewed.

An empty/disabled random pool fails closed. Turning random allocation off blocks new allocations
requiring that policy; it does not silently reinterpret the policy as fixed or API-key billing.

## Qualification procedure (requires separate live authorization)

Record the exact code SHA, schema, image/runtime version, SDK/plugin versions, sandbox provider,
account aliases A/B, retention kind and hard expiry. Do not record credentials or raw provider
request/response bodies. Obtain explicit approval before any paid inference.

For each candidate pair and retention path:

1. Create a session pinned to A. Establish a conversation and repository/workspace state. Add an
   uncommitted sentinel file, record transcript ID, queue two distinguishable messages, and record
   cumulative cost. Capture sanitized evidence of the credential/account identity actually used.
2. Switch to B while idle, streaming, retrying, and executing a tool. Check that all owned execution
   and deliveries stop before the binding changes. Check process descendants, not only HTTP idle.
3. Confirm the same workspace, sentinel, transcript, session/model/harness, queue order, and cost
   remain. Confirm the applied acknowledgement matches operation, generation, conversation, provider
   and binding revision. With approval, make one controlled inference and verify B's identity.
4. Confirm queued/interrupted work does not replay automatically. Continue explicitly; interrupted
   prompts must be intentionally resubmitted by the user. Repeat Continue from two tabs.
5. Lose acknowledgements, restart the bridge/control plane, delay credential issuance, disable the
   target during preparation, and inject failed stop/apply. No stale credential installs, revision
   rollback, overlapping execution, fresh-workspace fallback, or generic destructive cleanup is
   acceptable. Check that the SQL receipt's account-change fact appears once in session history.
6. Exercise failure retention, successful-switch idle retention, and new-generation recovery. A
   restored switched session requalifies the current binding before dispatch, including when runtime
   readiness precedes the provider's resume response. Verify the queued prompt remains held until
   explicit continuation. Disable new-switch admission and repeat saved Continue.
7. Exercise switch-only boot expiry with pending messages, checkpoint uncertainty, archive/cancel
   during awaits, target revocation, provider hard expiry, and unavailable conversation recovery.
   Unknown outcomes must remain held and visible; they must not fail an unrelated queue head.
8. Record stop/apply/recovery latency and observed retention limits. The initial whole-operation
   deadline is 120 seconds; supervisor control requests are bounded at 45 seconds. Set operational
   thresholds from this evidence, not from the automated test duration.

Stop expansion on any workspace/transcript loss, wrong account identity, implicit replay,
billing-mode change, overlap, or incorrect prompt attribution. Report uncertain outcomes as
uncertain, not success.

## Diagnose and recover

Use the session's provider-auth panel/API and preservation state. Correlate session ID, operation
ID, provider, actor, source/target account IDs, generation, binding revision, phase, deadline and
reason. The global `session_provider_account_switches` receipt is authoritative for a committed
binding; the session recovery record describes whether that binding has been applied by the runtime.
Account-change events contain identifiers and revisions only, never credentials.

- **Validating/quiescing:** work is held. A failed containment proof does not authorize a binding
  change. Retry the same operation only within its original deadline and with identical intent.
- **Applying/needs reconciliation:** a binding may already have committed. Reload/reconnect retries
  the qualified protocol, not the prompt. Never decrement revisions or rewrite the binding manually.
- **Applied, held:** use Continue explicitly. A saved workspace first offers **Restore and confirm
  account**; this creates a new bounded reapplication operation. Continue again after it applies.
- **Expired/failed operation with saved workspace:** select the current or another eligible account
  to start a new bounded operation. The old operation's deadline is never extended.
- **Preservation unavailable/unknown:** retain the hold, inspect provider state and receipt
  validity, and restore access/capability before retrying. External hard expiry can make recovery
  impossible; do not promise the workspace still exists. Termination/archive requires explicit user
  authority.
- **Actor/account no longer eligible:** restore legitimate access or use an authorized actor and
  eligible target. Do not bypass permission checks or silently fall back to an API key.

The existing preservation coordinator owns stop, checkpoint and retirement. A switch does not create
a second destructive cleanup path. Ordinary restore after an applied switch also reserves a new
recovery hold atomically with its generation before any provider I/O.

## Rollback

Disable `PROVIDER_ACCOUNT_SWITCH_ENABLED` to stop new account changes. Leave compatible runtime
capability configuration and handlers available for committed operations, credential fencing,
alarms, reconciliation and explicit continuation. Saved continuation and ordinary reapplication of
the current binding remain available even while new-switch admission is disabled.

Keep schema, routing policies, receipts and monotonic revisions. Do not downgrade to binaries that
ignore revision/generation fences while switched sessions survive. Do not clear recovery holds,
random pools, receipts, or qualification configuration as a substitute for draining operations.
Prefer a forward fix; an older-binary rollback requires a separately approved compatibility/drain
plan.
