# Sandbox launch contract: implementation evidence and rollout

## Delivered versus operationally gated

| Work                                 | Source change                                                                                        | Release gate                                                                 |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Cross-language fixtures and CI       | Real TS sender → Python endpoint → launch environment → runtime/service readers; mutation detector   | `npm run test:launch-contract`                                               |
| Common launch policy                 | Ordered hard prerequisites and unchanged attempt ownership; independent MCP/Slack reads run together | Manager, provider, Node/Workerd tests                                        |
| Shared encoding/effective defaults   | Canonical session serializer; explicit v1 timeout, flags, ports and tunnel inputs                    | Legacy compatibility suite and v1 suite                                      |
| Dual-reading receiver / gated sender | Implemented; legacy remains default                                                                  | Receiver capability + artifact verification + canary before activation       |
| Credential ownership                 | Provider-local generation and legacy paths deliberately retained; see ADR 0005                       | Separate scope/expiry/old-image equivalence evidence before any migration    |
| Legacy retirement                    | Not performed                                                                                        | Caller inventory, rollback window and independent retained-snapshot evidence |

No production or provider-native evidence is implied by local tests. This PR does not deploy, change
production flags, or declare legacy snapshots unsupported.

## Field and reader ledger

| Inputs                     | Owner/encoding                                                                  | Compatibility evidence                                                                               |
| -------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Session/repo/harness/model | Saved session; `buildSessionConfig` snake_case                                  | Repo-less, scalar, nested namespace, multi-repo, pinned helper, both harnesses                       |
| Branch and member SHA      | Saved membership; omit list for unpinned scalar                                 | Non-default Unicode branch and base SHA reach runtime                                                |
| User secrets/auth          | Existing resolver; system identity overlays user values                         | Synthetic reserved-key collisions; no durable plan cache                                             |
| MCP                        | Per-launch lookup; failure logs and omits                                       | Local command list reaches runtime; legacy create model vs restore pass-through preserved            |
| Early connect              | Boolean session-config field                                                    | Deliberate dropped-field mutation fails consumer assertions or v1 validation                         |
| Services                   | Saved flags; provider-generated passwords                                       | `CodeServer` requires a password; `WebTerminal` checks nonempty `TERMINAL_ENABLED`, not boolean text |
| VNC                        | Provider password, runtime entrypoint consumes it                               | Reserved user VNC values do not replace provider values; existing VNC suites retained                |
| Timeout                    | Explicit v1 seconds; Modal default at sender; other providers unchanged         | Native requested timeout and environment agree; not equated to observed lifetime                     |
| Ports/resources            | TS service defaults and tunnel filtering; native safety checks/resource mapping | Explicit non-default ports, exposed-port set, CPU/memory existing tests                              |
| Boot source                | Lifecycle selection; provider environment encoding                              | Base/prepared/snapshot modes; old image/token conventions retained                                   |
| Native results             | Provider identity/access/lifetime                                               | Existing generation claim and result publication; malformed response never triggers downgrade        |

Legacy create explicitly sends null for absent branch/MCP/repositories and its Python reconstruction
skips null values. Legacy restore preserves extensions and explicit nulls. V1 requires the declared
fields, while retaining unknown nested runtime fields. Disabled service variables are not
generically serialized as `"false"`; several readers would interpret that string as enabled.

The schema is generated from `launch_contract.CreateSandboxV1Request | RestoreSandboxV1Request`
using Pydantic `TypeAdapter.json_schema()`, with a Draft 2020-12 `$schema` marker. It lives in
`packages/modal-infra/contracts/launch-v1.schema.json`; the contract suite checks drift against the
actual receiver models. To update it, generate from those models in the same inert-image/import
context used by the tests. Do not update it merely to suppress a compatibility failure.

## Preparation evidence to refresh before activation

1. Record exact sender and receiver SHAs/build identities, endpoints, deployment modes and actual
   receiver Python/Pydantic/FastAPI versions. The function image pins the validator dependency tree
   to the frozen contract lock; CI checks parity. Record deployed identity to confirm that the
   intended artifact actually reached the receiver.
2. Identify bundled receiver runtime and base/prepared/retained-snapshot runtime versions
   separately. Missing metadata is not evidence of current compatibility.
3. Inventory external/self-hosted callers and review overlap with PR #1809, preservation work and
   provider-specific runtime changes before merge/rebase.
4. Record provider defaults, native secret precedence and inherited environment behavior using
   synthetic credentials in disposable authorized resources. Establish spending/cleanup limits
   before starting native canaries.
5. Establish volume, failures, time-to-ready, connection timeouts and restore holds by
   provider/source. Choose canary duration/rollback thresholds from those values. Do not count zero
   traffic as successful coverage of a low-volume path.
6. Check representative complete payload sizes, including MCP and JSON escaping; the existing
   combined-secret limit is not an overall request-size guarantee.

These are operational gates; no secrets or raw production launch bodies should be exported into
fixture files, PRs, logs, or evidence documents.

## Receiver-first release

1. Ship the dual-reading receiver with all senders still on legacy. Review the actual
   Terraform/workflow dependency order; file order is not readiness proof.
2. Query the exact receiver's health endpoint and verify `data.launch_contract_versions` contains
   `"legacy"` and `1`. Record its build identity; a generic healthy response is insufficient. This
   probe creates no sandbox.
3. In staging, enable `MODAL_LAUNCH_CONTRACT_VERSION=1` (Node) or
   `modal_launch_contract_v1_enabled=true` (local Terraform), or the repository variable
   `MODAL_LAUNCH_CONTRACT_V1_ENABLED=true` (Actions Plan/Apply), preserving the same receiver.
   Verify a base launch, prepared image, current snapshot, retained old snapshot,
   repo-less/multi-repo sessions, and service access. Exercise actual authorized SCM access. Test
   environment inheritance and native secret isolation, not just requests.
4. Verify invalid v1 and unsupported versions fail before provider work. Verify lost/malformed
   responses do not create a second sandbox through protocol fallback. Preserve existing saved-state
   holds and native late-result cleanup.
5. Enable the sender for the approved deployment only after those gates pass. Observe
   `launch_contract_version` on receiver `modal.http_request` and client `modal.request` logs with
   normal controlled request/session correlation. No body capture.
6. Compare against the preselected baseline thresholds; roll back on the agreed failures. A
   capability response alone does not authorize rollout.

## Rollback and retirement

Set the sender back to `legacy` / Terraform false. Keep the dual-reading receiver deployed through
the rollback window and any in-flight v1 requests. Do not roll a receiver back to legacy-only while
v1 senders can still reach it.

Retire the wire decoder only after the supported-caller/release inventory and agreed observation
window justify it. Retire old snapshot credential behavior only after independently proving those
retained binaries no longer need it. No legacy API traffic does not imply no legacy snapshots.
Unknown external callers require an explicit support/deprecation decision, not an inferred absence.

## Failure rules intentionally preserved

- Secret resolution failure prevents provider invocation; optional MCP/Slack and image-lookup
  failures retain their separate degradation rules.
- A failed prepared-image lookup is not a provider image-unavailable response. Only the latter
  follows the existing invalidation/new-identity/base-retry path.
- Timeout, cancellation and malformed success responses can be ambiguous provider outcomes. The
  encoder/client adds no retry or idempotency claims.
- Snapshot restore keeps the snapshot runtime generation and saved-state recovery holds. Persistent
  resume does not receive a new runtime environment/auth token.

## Local checks

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run test:launch-contract
npm run typecheck -w @open-inspect/control-plane
npm run test -w @open-inspect/control-plane
cd packages/modal-infra
uv run --frozen --extra dev --python 3.12 pytest tests/ -q
```

The cross-language runner generates only synthetic payloads in a temporary directory and removes
them on exit. Standalone Python runs skip producer cases without that artifact; the dedicated CI job
must pass the combined command.

## Implementation review and validation

Validated after rebasing onto `232bb74c5` (including PR #2014's preservation changes):

- Control-plane unit suite: 321 files, 5,083 tests passed; all four type-check configurations and
  Worker/Node builds passed.
- Workerd lifecycle, alarm recovery, shutdown, core conformance and state-retention suites: 5 files,
  77 tests passed.
- Combined sender/receiver/runtime contract: 3 TypeScript tests and 72 Python cases passed.
- Modal suite: 297 passed, 2 producer-artifact cases skipped in standalone mode (covered by the
  combined runner). Targeted runtime configuration, boot, repository and service suites: 112 passed.
- Targeted ESLint, Ruff, formatting, Terraform formatting, boundary lint tests and whitespace checks
  passed.

The independent reviewer found a v1 MCP validation gap and missing restore-version telemetry. The
MCP issue was reproduced with eight failing endpoint regressions before adding strict known-field
validation; unknown extensions remain preserved. Contract version now accompanies correlated
success/error outcome logs. Re-review found no remaining blockers, including after the upstream
rebase.

Two diagnostic checks are not green at the research baseline or on this branch: Python mypy reports
the same 15 existing `web_api.py` errors; Knip reports the same 32 unused exports, 10 unused
exported types and one duplicate export. These are not represented as passing checks.

All launch tests use synthetic data and mocked native resource creation. They do not establish live
provider behavior, retained-image compatibility, deployment completion, or permission to activate
v1.
