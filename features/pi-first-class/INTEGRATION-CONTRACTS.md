# Pi feature integration contracts

These contracts are coordination points for the parallel first-class Pi feature branches. They
declare metadata and ordering only: they do not authorize or execute a tool effect, apply a
migration, or enable a feature.

## Tool effects

Import `@open-inspect/shared/pi-tool-effects`. Every feature tool must declare a unique name, one of
the six `ToolEffectKind` values, explicit `callers`, and an explicit Pi Durable `replay` policy.
Compose the feature's declarations with `PI_TOOL_EFFECT_REGISTRATIONS` through
`createToolEffectRegistry(...)` before installing the feature extension. Duplicate names fail
immediately. The existing repository, subagent, and workspace tools already read their replay and
caller metadata from the baseline registry.

Effect classification does not replace SessionDO authorization, approval, audit, idempotency, or
indeterminate-outcome handling. It is input to those policies.

## Capability gates

Import `@open-inspect/shared/pi-feature-capabilities`. Gate snapshots use
`PiFeatureCapabilityMatrix`, which requires an explicit `off`, `read_only`, or `enabled` value for
workspace, Code Mode, sandbox execution, external actions, and MCP. This module intentionally does
not parse environment variables or alter runtime behavior. Each implementation must fail unknown
configuration closed to `off` at its runtime boundary.

## Migration reservations

Import `@open-inspect/shared/pi-migration-reservations`. The reserved versions are:

| Store     | Version | Owner             | Purpose                              |
| --------- | ------: | ----------------- | ------------------------------------ |
| SessionDO |      58 | sandbox execution | request persistence                  |
| SessionDO |      59 | sandbox execution | lifecycle persistence                |
| SessionDO |      60 | external actions  | approvals and execution persistence  |
| D1        |    0090 | external actions  | long-lived external action authority |
| D1        |    0091 | MCP               | long-lived MCP authority             |

Do not renumber another feature into these slots. D1 filenames retain the four-digit prefix.
SessionDO's existing schema test and the D1 migration runner test pass the repository's artifacts
through `validateMigrationArtifacts`; shared tests also reject duplicate reservations and duplicate
artifact versions. This contracts branch creates no schema migration.

## Extension assembly

`packages/control-plane/src/pi/extension-assembler.ts` is the only extension ordering contract.
Contribute one extension to the assigned slot and let `PiSessionDO` install the assembled result:

1. `policy`
2. `core`
3. `delegation`
4. `skills`
5. `workspace`
6. `code_mode`
7. `sandbox_execution`
8. `external_actions`
9. `mcp`

The assembler rejects duplicate slots and duplicate extension names. Feature branches must not add
independent `registry.install(...)` calls.

## Branch adoption checklist

- **Permission/audit:** use the `policy` slot; compose all tool-effect declarations before install;
  default-deny unknown mutation effects.
- **Code Mode:** use `code_mode`; classify the orchestration tool and every nested callable tool;
  consume the capability snapshot without enabling it here.
- **Sandbox execution:** use `sandbox_execution`; claim SessionDO migrations 58 and 59; classify
  execution tools as `sandbox_execution` with explicit replay metadata.
- **External actions:** use `external_actions`; claim SessionDO migration 60 and D1 migration 0090;
  classify read and mutation tools separately.
- **MCP:** use `mcp`; claim D1 migration 0091; register discovered stable tool names in the combined
  effect registry before exposing them.
