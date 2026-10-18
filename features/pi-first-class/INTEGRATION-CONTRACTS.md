# Pi feature integration contracts

These contracts are coordination points for the parallel first-class Pi feature branches. They
validate declarations, latch capability admission, and enforce the composite caller policy. They do
not execute a feature tool effect, apply a migration, or independently enable a feature.

## Tool effects

Import `@open-inspect/shared/pi-tool-effects`. Every feature tool must declare a unique name, one of
the six `ToolEffectKind` values, explicit `callers`, and an explicit Pi Durable `replay` policy.
Attach the feature's declarations to its `PiExtensionContribution`. `PiSessionDO` passes every
active contribution through `assemblePiExtensions(...)`, the single composition point, before the
first `registry.install(...)`. Assembly creates one exact effect registry and rejects duplicate tool
names, undeclared tools, declarations without tools, and caller/replay drift. The composite policy
hook receives that exact registry and default-denies undeclared model and nested calls.

`PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS` includes `codemode` and the reserved `pi.codemode.models.*`
tools. Managed skill tools are in `PI_TOOL_EFFECT_REGISTRATIONS`. MCP must finish stable-name
discovery and attach matching declarations before its contribution is assembled; discovery cannot
widen an already installed registry.

Effect classification does not replace SessionDO authorization, approval, audit, idempotency, or
indeterminate-outcome handling. It is input to those policies.

## Capability gates

Import `@open-inspect/shared/pi-feature-capabilities`. The canonical, independent capabilities are
`workspace`, `repositoryEditing`, `codeMode`, `sandboxExecution`, `externalActions`, and `mcp`.
`PiFeatureCapabilityMatrix` requires an explicit `off`, `read_only`, or `enabled` value for each.
Unknown and omitted deployment values resolve to `off`.

During a new Pi session's `/internal/init`, `SessionDO` resolves one complete, versioned
`PiFeatureCapabilitySnapshot`, persists its exact JSON under additive migration 61, and calls
`PiSessionDO.initialize(sessionId, snapshot)` before creation succeeds. A repeated initialize is
idempotent only for the same identity and exact snapshot; SessionDO retries one unavailable response
before failing creation. A blank Pi object obtains the persisted snapshot from SessionDO authority,
so an early status or submit cannot install a deployment-derived or legacy value. A legacy SessionDO
row without durable capability authority opens all-off, while an already-open session keeps its
stored snapshot across eviction.

Deployment flags therefore admit extensions only for new sessions. Current deployment policy is also
consulted before every new scratch mutation, repository mutation, and top-level Code Mode call. That
emergency deny blocks the effect without uninstalling the latched extension or its
status/cancel/revoke/replay implementation. A durably admitted Code Mode replay remains operable. Pi
Durable's own tool checkpoint is the sole recovery authority: recovery still in `call` reruns
current policy, while recovery after the durable `execute` intent follows the native replay rule and
bypasses `beforeTool`. There is no separate Code Mode admission memo. Broad caller/effect denial
runs before feature delegates, and feature allow memos are written only after every delegate allows.
An `off` capability contributes no extension, tool, or effect declaration. Any enabled contribution
with tools requires the composite policy; mutation and sandbox-execution contributions are rejected
without it. Every live emergency-policy lookup combines the tool abort signal with the single named
lookup timeout and fails closed.

## Migration reservations

Import `@open-inspect/shared/pi-migration-reservations`. The reserved versions are:

| Store     | Version | Owner             | Purpose                              |
| --------- | ------: | ----------------- | ------------------------------------ |
| SessionDO |      58 | sandbox execution | request persistence                  |
| SessionDO |      59 | sandbox execution | lifecycle persistence                |
| SessionDO |      60 | external actions  | approvals and execution persistence  |
| SessionDO |      61 | core authority    | creation-time Pi capability snapshot |
| D1        |    0090 | external actions  | long-lived external action authority |
| D1        |    0091 | MCP               | long-lived MCP authority             |

Do not renumber another feature into these slots. D1 filenames retain the four-digit prefix. Feature
branches import the exported `PI_*_MIGRATION_*` constant rather than repeating a number. Reserved
SessionDO `SchemaMigration` entries set their `feature` owner. Reserved D1 files begin with
`-- pi-feature: <owner>`. `assertMigrationReservation` enforces owner, store, and version, rejecting
unreserved or swapped claims. SessionDO's existing schema test and the D1 migration runner test pass
the repository's artifacts through `validateMigrationArtifacts`; shared tests also reject duplicate
reservations and duplicate artifact versions. Migration 61 is owned by core authority; later feature
branches must not reuse it.

## Extension assembly

`packages/control-plane/src/pi/extension-assembler.ts` is the only extension ordering contract.
Contribute one extension to the assigned slot and let `PiSessionDO` install the assembled result:

1. `policy`
2. `core`
3. `delegation`
4. `skills`
5. `workspace`
6. `repository_editing`
7. `code_mode`
8. `sandbox_execution`
9. `external_actions`
10. `mcp`

The assembler rejects duplicate slots and duplicate extension names. Feature branches must not add
independent `registry.install(...)` calls.

## Branch adoption checklist

- **Permission/audit:** use the sole `policy` slot and extend the composite hook; never install a
  second policy extension. Keep emergency deny in the hook so replay code stays installed.
- **Repository editing:** use `repository_editing`, gate on `repositoryEditing: enabled`, and
  declare every write/edit/delete tool as `local_mutation` or `external_mutation` as appropriate.
- **Code Mode:** use `code_mode`, gate on `codeMode`, and attach
  `PI_CODEMODE_TOOL_EFFECT_REGISTRATIONS` unchanged.
- **Sandbox execution:** use `sandbox_execution`, gate on `sandboxExecution`, and import the two
  SessionDO sandbox-execution migration constants. Classify execution tools as `sandbox_execution`.
- **External actions:** use `external_actions`, gate on `externalActions`, and import the SessionDO
  and D1 external-action migration constants. Classify reads and mutations separately.
- **MCP:** use `mcp`, gate on `mcp`, import `PI_D1_MCP_MIGRATION_VERSION`, and declare every
  discovered stable tool before exposing the extension.
