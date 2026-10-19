# Slice 5 report: production-safe Pi Code Mode

## Outcome

Hardened the already default-off native Code Mode path without adding a public Pi route or product
state. Code Mode remains a subordinate Pi execution tool under one canonical SessionDO operation;
its top-level and nested activity is projected through the existing SessionDO event/timeline path,
and model-written source is redacted from that projection.

## Runtime authority and lifecycle

- Nested policy now matches the authoritative parent `taskId` and parent call identity. Reusing a
  call string from another task cannot inherit Code Mode authority.
- One session-scoped FIFO admits one Code Mode execution at a time across root, fork, and child
  conversations. The queue is bounded at 16, removes aborted/expired waiters, and rejects new work
  after close.
- Each task persists an absolute deadline before queueing. Queue time counts against it; the default
  is 60 seconds and the maximum is five minutes. The remaining duration is passed to native Code
  Mode without changing the script fingerprint.
- A queued first execution rechecks current SessionDO deployment authority before recording its
  task-bound admission memo. Call-phase recovery can still be denied; execute-phase recovery uses
  the committed admission and native journal rather than admitting new work.
- Session deletion rejects queued work, aborts the harness, closes the remote sandbox, and waits for
  the active host invocation to settle.

## Immutable deployment and attestation

- The sandbox build emits one manifest binding exact SHA-256/byte lengths for `index.js` and
  `quickjs.wasm` to the CPU, migration, class, and privacy contract.
- The protected workflow builds once, uploads that immutable evidence, and deploys the exact entry
  with Wrangler bundling disabled. The Worker-version message carries the aggregate artifact hash.
- The Code Mode and Terraform workflows share one production-infrastructure concurrency group. All
  third-party actions in both privileged workflows are pinned to reviewed 40-character commits.
- The read-only attestation canary validates the active Cloudflare deployment/version, one 100%
  version, artifact annotation, etag, CPU 60000, v1 SQLite export, empty bindings/routes/domains/
  schedules/secrets, disabled workers.dev/previews, and a credential-free runtime evidence record
  containing canonical SessionDO operation/timeline IDs. It has no mutation or deploy method.

## Safety boundary

No live deployment or provider call was made. `PI_CODE_MODE` remains `off` by default, and Terraform
still requires matching deployed/canary version IDs plus explicit paid mode before new sessions can
receive Code Mode. Slice 6 execution tools and credentials remain untouched.
