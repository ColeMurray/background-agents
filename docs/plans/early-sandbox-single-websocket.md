# Early Sandbox Single-WebSocket Plan

## Core Decision

Use one existing sandbox WebSocket for both boot-time control and execution.

- WebSocket connection proves runtime liveness.
- The existing `ready` event grants execution capability.
- Heartbeats run over the WebSocket during boot and execution.
- No boot-progress HTTP endpoint.
- No database migration.
- No new sandbox status or event type.
- No boot phases or failure-ack protocol.

```text
Supervisor starts
      |
      v
Bridge connects to existing sandbox WebSocket
      |
      +---- heartbeat(status="booting")
      |
      v
Repository boot and setup
      |
      v
OpenCode becomes healthy
      |
      v
Bridge completes signing/session initialization
      |
      v
Existing ready event
      |
      v
Control plane grants execution capability
      |
      v
Queued prompt dispatches
```

## 1. Required Invariants

1. A connected socket does not imply prompt readiness.
2. Every new or replacement socket starts execution-unready.
3. Only `ready` from the current authenticated socket grants execution.
4. Pending prompts remain `pending` until execution readiness.
5. Heartbeats from the current socket renew startup liveness.
6. A socket that stops heartbeating eventually fails.
7. Old runtimes continue working because they already send `ready` immediately after their late
   connection.
8. Persisted `connecting`/`ready` status keeps readiness safe across hibernation.
9. Stale or replaced sockets cannot grant readiness.
10. Shutdown remains deliverable while the runtime is booting.

## 2. Connection State

Use the existing statuses:

| Socket state             | Persisted status                     | Meaning                                       |
| ------------------------ | ------------------------------------ | --------------------------------------------- |
| No socket                | `spawning` or `connecting`           | Waiting for runtime                           |
| Socket attached, unready | `connecting`                         | Supervisor alive, startup incomplete          |
| Socket attached, ready   | `ready`                              | Prompts and repository commands allowed       |
| Socket disconnected      | Existing status temporarily retained | Existing disconnect watchdog applies          |
| Recoverable failure      | `failed`                             | A current runtime may reconnect and self-heal |
| Terminal sandbox         | `stopped` or `stale`                 | Connection rejected or fenced                 |

No `booting` status is required.

## 3. Readiness State

Use the existing persisted sandbox status as the only readiness state:

```text
connecting = control only
ready      = execution capable
```

The socket keeps its existing `sid:` identity tag. The current sender and persisted sandbox identity
fence `ready`; no serialized attachment, protocol version, or readiness column is required.

On every successful admission, persist `connecting` before accepting the socket. On an authoritative
`ready`, persist `ready`. Because status survives Durable Object hibernation, the recovered current
socket retains the correct capability without a second representation of readiness.

## 4. WebSocket Admission

Change `packages/control-plane/src/session/connection-authenticator.ts`.

Current behavior on admission:

- Sets status `ready`.
- Broadcasts readiness.
- Starts inactivity monitoring.
- Processes the queue.

New behavior:

1. Authenticate the sandbox as today.
2. Validate sandbox identity and lifecycle state.
3. Reject reconnect with retryable `503` while a snapshot is in progress.
4. Persist sandbox status `connecting` and a server-received heartbeat.
5. Accept the new socket and replace any previous or hibernated sandbox socket.
6. Schedule startup liveness monitoring.
7. Do not start inactivity monitoring.
8. Do not broadcast `ready`.
9. Do not process the prompt queue.

Old runtimes remain compatible because their bridge sends `ready` immediately after connecting.

## 5. Authoritative Ready Event

Change:

- `packages/control-plane/src/session/message-router.ts`
- `packages/control-plane/src/session/sandbox-events/processor.ts`
- `packages/control-plane/src/session/sandbox-events/context.ts`
- `packages/control-plane/src/session/sandbox-events/runtime.handler.ts`
- `packages/control-plane/src/session/components.ts`

The message router must retain the actual sending socket when dispatching sandbox events.

Ready processing:

1. Verify the sending socket's `sid:` tag matches payload `sandboxId`.
2. Verify the socket is still the active socket.
3. Verify the persisted sandbox identity still matches.
4. Transition `spawning`, `connecting`, or current-attempt `failed` to `ready`.
5. Record runtime version and repository baselines as today.
6. Initialize server-received heartbeat and activity timestamps.
7. Schedule heartbeat and inactivity monitoring.
8. Broadcast ready status and access changes.
9. Process the pending prompt queue last.

Repeated `ready` from the same current socket must be idempotent.

A late `ready` from a replaced socket must do nothing.

## 6. Socket Accessors

Change `packages/control-plane/src/session/websocket-manager.ts`.

Keep the existing control accessor and add one execution accessor:

```ts
getSandboxSocket(): WebSocket | null;
getExecutionSocket(): WebSocket | null;
```

`getSandboxSocket()` requires:

- Current authenticated socket.
- Current sandbox identity.
- Non-terminal sandbox state.

`getExecutionSocket()` returns that current socket only when persisted sandbox status is `ready`.

## 7. Command Classification

| Command                  | Socket required       |
| ------------------------ | --------------------- |
| Heartbeat                | Control               |
| Shutdown                 | Control               |
| Stop                     | Control               |
| ACK                      | Exact captured sender |
| Prompt                   | Execution             |
| Push                     | Execution             |
| Diff refresh             | Execution             |
| Runtime snapshot command | Execution             |

Affected paths:

- `packages/control-plane/src/session/message-queue.ts`
- `packages/control-plane/src/session/messenger.ts`
- `packages/control-plane/src/session/sandbox-push-service.ts`
- `packages/control-plane/src/session/diffs/service.ts`
- Relevant lifecycle and stop handlers

Prefer explicit messenger methods:

```ts
sendControlCommand(...);
sendExecutionCommand(...);
```

Avoid a generic readiness framework or command registry.

## 8. Queue Behavior

Change `packages/control-plane/src/session/message-queue.ts`.

The queue needs three cases:

```text
No control socket
    -> retain existing spawn/resume behavior

Control socket but no execution socket
    -> leave message pending
    -> do not claim it
    -> do not start execution timeout
    -> do not spawn another sandbox

Execution socket available
    -> claim and send using existing behavior
```

This is the central behavioral change.

Warm-on-typing should treat an attached control socket as an existing sandbox so it does not create
a duplicate.

## 9. Runtime Startup

Change:

- `packages/sandbox-runtime/src/sandbox_runtime/supervisor.py`
- `packages/sandbox-runtime/src/sandbox_runtime/bridge.py`
- Possibly `packages/sandbox-runtime/src/sandbox_runtime/agent_bridge_process.py`
- Possibly `packages/sandbox-runtime/src/sandbox_runtime/opencode_client.py`

New supervisor order:

1. Exclude image-build mode as today.
2. Start the bridge process immediately.
3. Start desktop best-effort.
4. Run repository boot.
5. Materialize managed skills.
6. Start code-server and terminal best-effort.
7. Start OpenCode and wait for health.
8. Continue normal process monitoring.

Remove the HTTP boot-progress task entirely.

## 10. Deferred Bridge Initialization

The bridge currently performs OpenCode and repository-dependent work before connecting:

- Restored-session validation
- Commit-signing initialization
- Repository manifest reads
- Ready-event construction

Split bridge startup into two concurrent responsibilities.

### Transport Initialization

Runs immediately:

- Connect WebSocket.
- Start heartbeat.
- Handle reconnects.
- Receive shutdown and stop.
- Buffer outbound events.
- Reject execution commands defensively before ready.

### Execution Initialization

Runs locally while the transport is connected:

1. Poll OpenCode `/global/health`.
2. Wait until health succeeds.
3. Load or validate the OpenCode session.
4. Read the final repository manifest.
5. Initialize commit signing.
6. Build the ready payload.
7. Mark local execution initialization complete.
8. Send `ready` on the current connection.

OpenCode health is sufficient as the readiness boundary because the supervisor starts OpenCode only
after repository boot and manifest creation complete.

This avoids supervisor-to-bridge IPC.

## 11. Runtime Reconnect

Maintain one process-level flag:

```py
execution_initialized: bool
```

Before initialization:

- Connect.
- Heartbeat with `status="booting"`.
- Do not send `ready`.

After initialization:

- Send `ready`.
- Heartbeat with `status="ready"`.

On WebSocket reconnect after initialization:

- The new control-plane socket starts unready.
- Bridge immediately re-sends `ready`.
- Control plane marks the replacement socket execution-ready.

The existing heartbeat schema already allows arbitrary status strings, so no shared contract change
is required.

## 12. Runtime Command Defense

The control plane is the primary gate, but the bridge should also reject execution commands before
readiness.

Before ready, permit:

- `shutdown`
- `stop`
- `ack`

Before ready, reject or return unavailable for:

- `prompt`
- `push`
- `refresh_diff`
- `snapshot`

This protects against rollout mistakes and stale control-plane versions.

## 13. Heartbeat And Timeout

Retain the renewable lease model.

Before socket connection:

```text
created_at + existing startup timeout
```

After attachment:

```text
latest server-received heartbeat + heartbeat timeout
```

Recommended timing:

- Heartbeat every 30 seconds.
- Failure after 90-120 seconds without heartbeat.
- No total boot-duration limit.

The same persisted `last_heartbeat` field works for booting and ready states.

Timeout transition must remain fenced by:

- Sandbox ID.
- Spawn attempt timestamp.
- Startup status.
- Observed heartbeat timestamp.

No new timestamp column is required.

## 14. Failure Handling

Do not introduce `boot_failed` events or acknowledgements.

On startup failure:

1. Supervisor uses the existing fatal-error reporting path.
2. Supervisor shuts down the bridge.
3. Heartbeats stop.
4. Existing heartbeat timeout is the fallback if fatal reporting fails.
5. Control plane marks the attempt failed and re-drives pending work according to existing policy.

This preserves current behavior without another delivery protocol.

## 15. Hibernation

Hibernation recovery must:

1. Recover the tagged sandbox socket.
2. Verify the `sid:` tag matches the current sandbox row.
3. Use persisted `connecting` or `ready` status as the capability gate.
4. Recover connecting sockets as control-only.
5. Close identity-mismatched sockets.

No additional database or WebSocket attachment persistence is needed.

## 16. Snapshot Interaction

If a runtime reconnects while persisted status is `snapshotting`, reject the upgrade with retryable
`503` and `Retry-After`. The bridge reconnect loop retries after snapshot completion. Its next
accepted socket is persisted as `connecting` and must reannounce `ready` before execution resumes.

## 17. Compatibility And Rollout

A same-route rollout is possible without protocol V2.

| Control plane       | Runtime                   | Result                                            |
| ------------------- | ------------------------- | ------------------------------------------------- |
| New readiness-aware | Old late-connect runtime  | Safe; old runtime sends `ready` immediately       |
| New readiness-aware | New early-connect runtime | Safe; waits for explicit `ready`                  |
| Old control plane   | Old runtime               | Existing behavior                                 |
| Old control plane   | New runtime in late mode  | Existing behavior                                 |
| Old control plane   | New runtime in early mode | Unsafe; old control plane dispatches on admission |

Use one temporary activation environment variable:

```text
EARLY_SANDBOX_CONNECTION=1
```

New runtime defaults to late mode when absent.

Deployment sequence:

1. Deploy readiness-aware control plane.
2. Verify old runtimes still connect and dispatch.
3. Deploy early-capable runtime with activation off.
4. Enable early mode for a canary environment/provider.
5. Expand activation after metrics are stable.
6. Remove the HTTP boot-progress endpoint and polling loop.
7. Remove the temporary flag after rollback no longer requires late mode.

No protocol-version schema or dedicated route is required under this controlled deployment order.

Rollback:

1. Disable early-mode activation.
2. Let or force active early sessions drain.
3. Roll runtime artifacts back if needed.
4. Roll the control plane back only after no early sessions remain.

## 18. PR Structure

To keep reviews manageable, split the work.

### PR 1: Explicit Readiness In Control Plane

Scope:

- Persisted connecting/ready capability
- Admission no longer grants readiness
- Current-sender ready handling
- Queue gating
- Command classification
- Reconnect and hibernation tests
- Legacy late runtime compatibility

Expected scope: approximately 15-20 files.

This PR is independently deployable because existing runtimes already emit `ready`.

### PR 2: Early Runtime Connection

Scope:

- Start bridge before repository boot
- Deferred bridge execution initialization
- Booting heartbeat
- Runtime command defense
- Temporary activation variable
- Remove HTTP boot-progress loop and endpoint
- Runtime and cross-version tests

Expected scope: approximately 8-12 files.

## 19. Test Plan

### Control-Plane Unit Tests

- Admission persists connecting before accepting the socket.
- Admission does not mark status ready.
- Admission does not process the queue.
- Ready from current socket grants execution.
- Ready from replaced socket is ignored.
- Identity mismatch closes or rejects the sender.
- Duplicate ready is idempotent.
- Attached-unready message stays pending.
- Attached-unready state does not spawn a duplicate.
- Stop and shutdown use control socket.
- Prompt, push, and diff use execution socket.
- ACK returns to the captured sender.
- Hibernation preserves connecting and ready capability through persisted status.
- Reconnect is retryably rejected during snapshots.

### Control-Plane Integration Tests

- Pending prompt survives early attachment.
- Prompt dispatches only after ready.
- Reconnect before ready remains unready.
- Reconnect after ready requires reannouncement.
- Replaced socket cannot grant readiness.
- Heartbeating boot exceeds the former startup duration.
- Missing heartbeat fails the attempt.
- Durable Object eviction preserves readiness correctly.
- Legacy runtime admission plus immediate ready still works.
- Snapshot reconnect is rejected until snapshot completion, then requires ready.

### Runtime Tests

- Bridge connects before repository boot completes.
- Heartbeats are sent while OpenCode is unavailable.
- No ready event before OpenCode health.
- No signing/session initialization before health.
- Ready follows health and initialization.
- Reconnect after initialization re-sends ready.
- Shutdown works while booting.
- Prompt and push are rejected before ready.
- Repository or OpenCode startup failure stops bridge.
- Image-build mode never starts bridge.
- Activation off retains existing late-start order.

### Cross-Version Tests

- New control plane with old runtime.
- New control plane with new runtime, activation off.
- New control plane with new runtime, activation on.
- Old control plane with new runtime, activation off.
- Activation cannot be enabled against an old control plane.

## 20. Acceptance Criteria

1. Runtime WebSocket attaches before repository boot.
2. Attached socket immediately provides heartbeat liveness.
3. No prompt is claimed before explicit ready.
4. Existing ready event is the only execution grant.
5. Every replacement socket starts unready.
6. Ready is accepted only from the active authenticated socket.
7. A heartbeating boot can run indefinitely.
8. Missing heartbeats eventually fail the current attempt.
9. Shutdown remains available while booting.
10. Legacy runtimes continue working.
11. Durable Object hibernation preserves connection readiness safely.
12. No database migration is introduced.
13. No protocol V2, boot phases, or failure-ack system is introduced.
14. HTTP boot-progress polling is removed.
15. Image-build behavior is unchanged.
16. The implementation remains split into reviewable PRs.

## Estimated Scope

- Production files: approximately 16-20
- Test files: approximately 10-14
- Total files across two PRs: approximately 24-30
- No shared schema, web UI, provider-specific behavior, or database migration expected

The unavoidable complexity is limited to connection-scoped readiness, sender fencing, queue gating,
and deferred bridge initialization. Everything else from the earlier 99-file approach remains
excluded.
