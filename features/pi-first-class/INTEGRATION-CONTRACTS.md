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

`PiSessionDO` creates one versioned `PiFeatureCapabilitySnapshot` and durably latches it before VFS
construction or registry assembly. Deployment flags therefore admit capabilities only for new
sessions; changing them does not uninstall code needed to replay an existing session. Emergency deny
belongs in the composite invocation policy and must block execution without removing the latched
extension or replay implementation. An `off` capability contributes no extension, tool, or effect
declaration. Any enabled contribution with tools requires the composite policy; mutation and
sandbox-execution contributions are rejected without it.

## Migration reservations

Import `@open-inspect/shared/pi-migration-reservations`. The reserved versions are:

| Store     | Version | Owner             | Purpose                              |
| --------- | ------: | ----------------- | ------------------------------------ |
| SessionDO |      58 | sandbox execution | request persistence                  |
| SessionDO |      59 | sandbox execution | lifecycle persistence                |
| SessionDO |      60 | external actions  | approvals and execution persistence  |
| D1        |    0090 | external actions  | long-lived external action authority |
| D1        |    0091 | MCP               | long-lived MCP authority             |

Do not renumber another feature into these slots. D1 filenames retain the four-digit prefix. Feature
branches import the exported `PI_*_MIGRATION_*` constant rather than repeating a number. Reserved
SessionDO `SchemaMigration` entries set their `feature` owner. Reserved D1 files begin with
`-- pi-feature: <owner>`. `assertMigrationReservation` enforces owner, store, and version, rejecting
unreserved or swapped claims. SessionDO's existing schema test and the D1 migration runner test pass
the repository's artifacts through `validateMigrationArtifacts`; shared tests also reject duplicate
reservations and duplicate artifact versions. This contracts branch creates no schema migration.

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
