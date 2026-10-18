# Pi sandbox execution provider canary blockers

## Status

The foundation is **not integration-ready**. `PI_SANDBOX_EXECUTION_ENABLED` defaults to `false`, and
Pi registers no shell, build, test, or generic execution tool. The internal command boundary is
dormant until the separate authority, approval, and credential-release work is complete.

## Blockers before any provider canary

1. Build and deploy sandbox runtime generation 77 for every provider. The manifest raises both the
   execution minimum and rebuild floor to `v77-pi-sandbox-execution`; older images fail closed.
2. Add the model-visible tool only after shared policy authorizes the `sandbox_execution` class,
   including actor approval, per-command audit, and expiry/revocation behavior.
3. Decide which repository and package-registry credentials an approved command may receive. The
   current command child receives only a small non-secret environment allowlist.
4. Keep the feature flag off until the tests below pass against disposable non-production sessions.

## Provider canaries still required

| Provider         | Required proof before enablement                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Modal / Modal VM | Generation-77 image boots in execution mode; `llm-api-keys` is not attached; process-group cancellation and snapshot preservation work.                      |
| OpenComputer     | Generation-77 template boots; no secret store is attached; inherited model keys are blanked on checkpoint forks; bridge restart contains old process groups. |
| Daytona          | Generation-77 snapshot boots without an agent harness; stop/resume preserves bridge generation identity and marks replaced work indeterminate.               |
| Vercel Sandbox   | Generation-77 base snapshot boots; command output replay survives WebSocket reconnect; timeout and stop kill the full process group.                         |
| E2B              | Generation-77 template boots; pause/connect does not revive an old bridge or command group; replacement marks running work indeterminate.                    |

Hosted provider canaries were not run from this worktree because they require deployment
credentials, rebuilt provider images, and explicit authorization to call external infrastructure.
