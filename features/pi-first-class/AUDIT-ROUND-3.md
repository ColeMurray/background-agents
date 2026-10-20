# Adversarial audit round 3 — cross-session messaging and the capability slices

Scope: the cross-session messaging slice, the Computer VFS, Code Mode, and native execution, audited
against the stated boundary rules. Two auditors read the code independently; this is what was found
and what was changed.

## The blocking defect

**The target session refused every delivery.** The authority function compared the target against
"the session that owns the current runtime". On the inbound path that comparison was the target
against itself, so the rule "a session cannot message itself" fired on every message and the whole
feature could never deliver anything.

The unit test did not catch it because it stubbed the authority function. The fix splits the
authority into two questions with two answers — the _source_ may still act, and the _target_ may
still be addressed — and each one is asked with the real session ids.

## Source checks

| Check                                   | Before                      | Now                                                                                  |
| --------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| The source session is active            | not checked                 | the source's own status is read, and a closed source is refused                      |
| The actor is still active               | checked only for the target | checked for the source and for the target                                            |
| The actor may collaborate in the source | not checked                 | the source's own access row is resolved and the canonical `collaborate` rule decides |
| The turn belongs to this session        | trusted the header          | the operation must be a message of this session                                      |
| The capability permits it               | latched and live gates      | unchanged                                                                            |
| Budget, rate, fan-out, depth            | fan-out and depth only      | fan-out and depth, counted from durable state                                        |
| The request is idempotent               | a receipt per key           | unchanged, and a terminal receipt is never delivered again                           |

## Target checks

| Check                                            | Before                         | Now                                                                                                     |
| ------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| The receipt is confirmed                         | never read                     | the target reads the receipt and refuses one it cannot confirm, so the provenance can never be asserted |
| The sender's authority is revalidated            | the actor only                 | the source, the target, and the actor, all resolved now                                                 |
| The target accepts agent messages                | never checked                  | the target's own capability and the live mode decide                                                    |
| The target's owner and team are standing         | not checked                    | a suspended owner and an archived team are refused                                                      |
| The target is not archived                       | checked                        | unchanged                                                                                               |
| The target's budget admits the message           | the queue refused it, as a 500 | the refusal is a typed reason on the receipt                                                            |
| The message is stored through the target's queue | yes                            | yes, with the receipt id as the request id so a redelivery is idempotent                                |

## The identity of the actor

The receipt records a workspace account. A turn that arrived from Slack with a namespaced identity
(`slack:U123`) has no workspace account, so it may not speak for the session, and a machine identity
may not either. The human behind a turn that another session's agent started is the human recorded
in that message's provenance, so a chain of agents keeps naming the person who started it.

## The idempotency state machine

A receipt that was rejected may be delivered later, so a refusal is not terminal for a delivery. A
receipt that was delivered is never delivered again, and a lost creation race never delivers a
second copy. The fan-out count excludes the request's own key, so a legitimate retry is never
refused as a fan-out violation.

## The scratch workspace, Code Mode, and native execution

The second auditor confirmed the Computer VFS, Code Mode, and native execution boundaries, with two
findings worth changing and three worth writing down.

### Changed

- **"Workspace" was overloaded.** The Pi feature was called `workspace`, the extension was
  `open-inspect.workspace`, the prompt section was `workspace`, the environment variable was
  `PI_WORKSPACE_MODE`, and the sidebar said "Workspace tools" — while "workspace" also means the
  tenant in the team switcher, the permissions, and the session visibility, and the native execution
  sandbox has a third `/workspace`. They are now named distinctly: `scratchWorkspace`,
  `open-inspect.scratch-workspace`, `scratch_workspace`, `PI_SCRATCH_WORKSPACE_MODE`, and "Scratch
  files". The capability snapshot moved to version 3 and reads an older snapshot with the same mode
  under the new name.
- **A scratch write carried no attribution.** The durable record of a scratch write named the tool
  and the path, and nothing else. It now names the task and the call that caused it. The timeline
  attaches the operation, and the operation names the participant, so the write keeps the
  attribution of the turn that caused it.

### Written down

- **Code Mode's nested-call restriction was in memory.** The rule that a nested call may only be a
  replay-safe read was enforced by a map that lives only while the Durable Object is awake. A nested
  task that the scheduler resumed after an eviction could, in principle, run its tool before the
  parent re-registered itself. It is not exploitable today only because the mutating tools happen to
  be declared unsafe to replay. This needs a durable parent marker.
- **The native execution slice cannot execute.** Every provider declares
  `executionIsolation: "canary_blocked"`, so the capability resolves to `off` and the extension is
  never installed. The boundary is structurally complete and tested, and it has never run end to end
  against a real provider. It stays dormant until a live isolation canary passes.
- **The execution endpoint trusts its caller.** The SessionDO's execution-command endpoint accepts
  an approval revision in the body rather than checking the approval itself. It is safe today
  because the endpoint is not publicly reachable, and that reachability is the boundary.
