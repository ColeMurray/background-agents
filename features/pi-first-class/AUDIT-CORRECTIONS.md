# Post-integration audit corrections

This record captures the concrete findings from the first combined audit, why each existed, and the
regression proof added with the fix. It does not replace the live-provider canary evidence.

| Finding                                                                    | Root cause                                                                                                            | Correction and regression proof                                                                                                                                      |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A queued repository mutation could run after cancellation                  | Cancellation was checked before queueing, not when the shared FIFO granted execution                                  | Recheck the tool abort signal inside the queued invocation; `repository-editing-capability.test.ts` aborts while queued and proves Computer is never called          |
| Repository mutation paths were unbounded                                   | The overlay validated path shape but did not cap raw path length before VFS access                                    | Cap mutation paths at 4,096 characters; `repository-workspace.test.ts` proves the executor is not called                                                             |
| Cold deletion depended on repository access                                | `destroy()` opened the Pi harness to abort it, which rematerialized repositories after eviction                       | Abort/dispose only a harness opened by the current object; the workerd deletion test revokes provider access after eviction and still deletes                        |
| Repository additions could exceed the total materialized-file limit        | Only changed-path count was bounded                                                                                   | Count live tracked files, deletions, and additions before new writes; unit tests cover the live-file limit and durable restore limit                                 |
| Repository editing widened workspace `off` to read-only                    | A Boolean `scratchWritable` collapsed `off` and `read_only`                                                           | Preserve the full capability mode and reject all scratch routes when it is `off`; capability tests prove repository reads remain available                           |
| Repository mutations lacked durable policy memos                           | The scratch policy intentionally delegated repository paths, but the repository delegate recorded no decision/outcome | Add metadata-only before/after memos with no file content; capability tests assert both records and redaction                                                        |
| Repository cold-open refetched all provider data                           | Source manifests were fetched before checking durable Computer state                                                  | Restore and validate manifests, roots, files, and mutation baselines first; fetch only incomplete repository positions and repair without undoing recorded deletions |
| Sandbox execution rollback disabled admitted-session recovery              | SessionDO used the current deployment flag instead of PiSessionDO's durable capability snapshot                       | Remove the live flag from the dormant coordinator; new admission remains in PiSessionDO while durable command recovery survives rollback                             |
| Paid Code Mode admission used an advisory Terraform check                  | A failed `check` can allow apply to continue                                                                          | Replace it with a hard resource precondition and production Terraform tests                                                                                          |
| Code Mode canary approval was not version-bound                            | Deployment and canary were represented only by Booleans                                                               | Require matching deployed/canary Worker version IDs; refuse deploy and rollback until admission is off and prior approval is cleared                                 |
| Privileged Code Mode workflow actions were mutable                         | Checkout and Node setup used moving major tags                                                                        | Pin both actions to reviewed 40-character commit SHAs and enforce the pins in the workflow contract test                                                             |
| Readiness integration assertions described the old outcome/order           | Runtime readiness now returns an explicit outcome and publishes the runtime event after status                        | Update assertions and replace a timing sleep with a deterministic in-object processed marker                                                                         |
| New MCP/external-action routes were absent from frozen admission manifests | Foundation routes landed after the route snapshots were last regenerated                                              | Review the six policies, update the catalog count and snapshots, and derive Viewer expectations from canonical RBAC grants                                           |

## Remaining non-code gates

- A paid Cloudflare canary must prove the exact Code Mode Worker version, SQLite migration, QuickJS
  WASM execution, CPU limit, replay, abort, upgrade, and rollback.
- Generation-77 execution images require live provider canaries before any sandbox command tool is
  exposed.
- MCP remains transport-disabled. Agents SDK 0.28.1 now supports plain-DO lifecycle installation and
  restored HTTP transports, but Open-Inspect still needs identity-first lifecycle composition,
  callback routing, DNS/redirect-safe egress, reviewed-catalog verification, and a read-only OAuth
  canary before activation.
- External actions still have no real provider executor. GitHub, GitLab, Slack, and Linear mutations
  remain unavailable until reversible provider canaries and execution-audit projection pass.
