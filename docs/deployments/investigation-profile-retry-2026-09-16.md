# DIV-77 replacement smoke — startup failure, cancellation unresolved

Mason explicitly approved three additional sequential executions (replacement smoke, A, B),
retaining the time/spend thresholds, stop-on-failure rule and separate concrete-task selection for
B. Only the replacement smoke ran as a dispatch attempt; the two remaining slots do not authorize
another retry after failure. No A or B was dispatched. Publication was never enabled.

## Provenance

| Item                    | Identity                                               |
| ----------------------- | ------------------------------------------------------ |
| Issue                   | [DIV-82](https://linear.app/divinedesign/issue/DIV-82) |
| Exact task comment      | `e891f5dd-f34c-47f8-a314-a81c11ac40e1`                 |
| Native Linear session   | `7794af2d-3476-470b-9a70-3c3262238155`                 |
| OpenInspect session     | `4d503f4c1ef79561c455554a81da881b`                     |
| Pending message         | `11ba12219d8393c7a4448a3877c4314c`                     |
| Creation                | 2026-09-16 18:29:37.913 UTC                            |
| First stop request      | 18:36:55.979 UTC; 7m18.066s after creation             |
| Restored Linear version | `3441ec5f-2356-4d52-8ad8-82611852be35`, 18:37:47 UTC   |

The corrected [Modal v5 release](investigation-profile-pilot-2026-09-16.md) remains deployed: source
`63ce1fe338e4609f58d273db9054320a4962e28b`, image `im-O9SN8sTS5qzxtJiKOogXRH`, SDK 1.5.5.
Control-plane remains `0c4dbf1a-6392-4f61-b5fd-d2e714ae8b08`. A reviewed targeted apply selected
Linear read-only routing with publication false; a subsequent reviewed apply restored implementation
routing and retained publication false. Existing automation and access settings were unchanged.

## Results

The authenticated WebSocket snapshot reports `sandboxStatus: failed`, `isProcessing: false`, one
pending message and
`spawnError: Failed to create sandbox: Modal request timeout after 60000ms (createSandbox)`. Zero
runtime events, source/tool calls, completion reports or model charges were recorded. The selected
model was never exercised; this does not show failure of the DIV-81 fix.

A separate read-only Modal app lookup returned provider InternalError `QC2HBPC8`; an AppList
diagnostic timed out after 25 seconds. Health calls intermittently timed out, then returned 200.
These observations do not establish the underlying cause. The
[provider status page](https://status.modal.com/) reported operational services when checked. Local
available memory was approximately 2.1 GiB; no VPS-memory causal claim is established.

An authenticated wrong-profile follow-up requiring implementation returned HTTP 409 before enqueue.
An initial actorless request returned 403 and is not counted as profile evidence. No harness existed
for the prepared filesystem, tool-denial, credential, network or source-integrity probes. Those
checks and useful report delivery remain unproven in this attempt. Publication, callback replay and
durable transfer were not attempted.

## Cleanup limitation and follow-ups

Stop returned `stopping` but did not cancel the pending message. Archive returned HTTP 409 because
work was queued. Authenticated WebSocket `cancel_prompt` returned `PROMPT_NOT_CANCELLABLE`, while
the message API still showed `pending` with null start/completion times. Source review explains the
gap: `execution-stop-coordinator.ts` only selects a processing message, while
`message-repository.ts` permits pending cancellation only for web-origin messages without callback
context. Further stop requests, including the deadline watchdog, did not terminalize the request. No
state was edited directly, authentication bypassed, or index row deleted to conceal it.

Modal sandbox listings after stop, most recently at 18:42:55 UTC, were empty. No sandbox ID was
available to terminate or obtain an exit code from. This supports no observed running sandbox, not
full cancellation or proof against a delayed provider effect. The active/pending session must not be
prompted or restarted until a supported settlement path is available. Model cost remains $0
recorded; classifier/infrastructure cost is unavailable and the overall $2 target is unproven.

- [DIV-83](https://linear.app/divinedesign/issue/DIV-83): diagnose Modal createSandbox timeout,
  distinguish provider/startup/transport causes, and reconcile possible delayed create effects.
- [DIV-84](https://linear.app/divinedesign/issue/DIV-84): provide safe cancellation for pending
  Linear-origin work, preserving callbacks/evidence and preventing later dispatch; include a repair
  procedure for this stuck session.

Both block downstream testing and require separate review. No automatic retry, source fix or
unrelated infrastructure change was made under this failed test. Exact prompts and private
operational evidence remain under `/home/orca/.local/state/openinspect/div77-resume-20260916/`.
