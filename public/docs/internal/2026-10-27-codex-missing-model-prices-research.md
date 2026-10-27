# Research: Codex model prices missing in Boat sandboxes

**Date:** 2026-10-27 **Status:** Research only **Scope:** Trace the reported Codex pricing warning
through catalog creation, sandbox persistence, harness startup, and cost accounting.

**Baseline:** Checkout `3f2774e`, before the persistent-catalog fix. Findings describe that
baseline.

This document is intentionally research-only. It does not include recommendations, implementation
plans, proposed code/API/schema changes, task breakdowns, estimates, or rollout steps.

## Summary

The running sandbox reproduces the reported warning because its price catalog is missing. Its build
metadata identifies the provider as Boat. The live bridge log records `model_prices.unavailable`,
with path `/home/user/.cache/opencode/models.json` and reason `catalog file missing`.

There is a mismatch between the pricing dependency and the documented Boat snapshot contract: image
builds refresh the catalog into `~/.cache`, but Boat snapshots exclude that directory. Ordinary
session startup never refreshes the catalog. Native Codex sessions do not launch OpenCode, and their
pricing reader has neither a network fetch nor a catalog bundled into the Python runtime.

The missing file is directly observed. Its loss during snapshot capture is an inference supported by
the provider metadata, documented persistence rules, and the absence of any restoration path. The
original image build's refresh result was not available in this investigation.

## Research Questions

1. What condition produces this exact warning?
2. Where does the price catalog originate, and what preserves it across boots?
3. Why does the native Codex path continue without prices?
4. What do the existing tests and image verification establish?

## Current Behavior

### Warning and accounting

- `CodexHarness.run_prompt()` resolves the requested model's price before submitting the native
  turn. The turn receives that price or an unpriced warning.
- `_unpriced_warning()` returns the reported generic warning when the catalog is unavailable. A
  readable catalog lacking the requested model produces a different message:
  `No price is listed for <model> in this sandbox...`.
- `ModelPriceCatalog` reads a local JSON file and expects `openai.models` to be an object. It does
  not download prices or extract OpenCode's compiled catalog.
- Without prices, token usage is still reported, the step's `cost` is omitted, and `messageCostUsd`
  is zero. The missing-catalog condition does not fail the turn.
- The reader checks the file again on subsequent lookups and can load it if it appears. A turn
  already submitted retains its previously resolved price state.
- The reader logs an unchanged failure reason only once per reader instance. Repeated user-facing
  warnings therefore need not have repeated log entries.

### Catalog location

`default_catalog_path()` uses `OPENCODE_MODELS_PATH` when set. Otherwise, the default source uses
`$XDG_CACHE_HOME/opencode/models.json`, falling back to `~/.cache/opencode/models.json`. A custom
`OPENCODE_MODELS_URL` without an explicit path is treated as having no supported cache path.

In this sandbox, `HOME` is `/home/user`; `XDG_CACHE_HOME`, `OPENCODE_MODELS_PATH`, and
`OPENCODE_MODELS_URL` are unset. The resulting catalog file and its containing OpenCode cache
directory are absent.

## Relevant Workflows

1. The shared base-image filesystem installer runs
   `HOME="$OI_RUNTIME_HOME" timeout 120 opencode models --refresh`. Failure is best-effort, and its
   diagnostics are redirected away.
2. Repository/environment image build mode runs the supervisor's `_refresh_models_catalog()` before
   reporting build success. This is also best-effort; process output is discarded and success means
   a zero exit code.
3. The repository documents that Boat snapshots exclude `~/.cache`, including the refreshed model
   catalog. This applies to the saved base/image and to cross-machine stop/resume persistence
   described in the Boat documentation.
4. Normal session startup does not call `_refresh_models_catalog()`.
5. The supervisor selects `CodexStager` for the Codex harness. It does not start `OpenCodeServer`.
   The bridge constructs a `ModelPriceCatalog` from the current environment and injects it into
   `CodexHarness`.
6. OpenCode's documented compiled-catalog fallback and background refresh belong to the OpenCode
   process. They are not part of the native Codex pricing path.

## Existing Patterns

- Harness dependencies are injected: Codex receives the price catalog through its constructor.
- Pricing failures are intentionally nonfatal and visible as timeline warnings.
- The Boat launcher already keeps conversation and runtime state outside the excluded cache
  directory, under `/home/user/.openinspect/state`.
- The OpenCode OAuth pricing plugin reads the same catalog file. Its behavior is separate from the
  native Codex harness.

## Constraints and Invariants

- A successful catalog refresh during image construction does not establish that the catalog
  survives Boat snapshot creation.
- Rebuilding an image with the current catalog location and snapshot behavior does not establish
  that the deployed sandbox has prices.
- The default path depends on the runtime user's home and cache environment.
- The reported warning alone distinguishes catalog unavailability from a missing model entry, but
  does not distinguish a missing file from unreadable JSON or an unsupported custom source. The
  structured log supplies that distinction.

## Known Gaps and Risks

- **Persistence gap:** the native pricing dependency occupies a directory that the documented Boat
  persistence contract excludes.
- **Recovery gap:** the native Codex path has no automatic catalog acquisition during session
  startup or price lookup.
- **Build verification gap:** `smoke_test.py` verifies installed tool versions, runtime imports, and
  a credential-free Codex handshake/containment probe. It does not verify catalog availability or a
  priced Codex turn after snapshot deployment.
- **Test coverage gap:** pricing and native-wire tests supply fixture catalogs. Supervisor tests
  check that refresh executes, that failure is nonfatal, and that ordinary sessions do not refresh.
  These do not exercise Boat's removal of `~/.cache` between image construction and session
  execution.
- **Documentation mismatch:** the general model-catalog section describes rebuilding as resolving
  missing Codex prices, while the Boat-specific section explicitly says the catalog does not
  persist. Its explanation of OpenCode's fallback does not describe recovery for native Codex.
- **Accounting consequence:** turns with unavailable prices contribute zero to reported spend and
  therefore do not reflect their token usage in dollar-based totals and spend limits.

## Observations and Validation

- `/app/openinspect-build-config.json` identifies this sandbox as `boat`, with runtime version
  `v77-codex-pinned-binary`.
- `/home/user/.openinspect/supervisor.log:52` contains the actual missing-catalog bridge warning for
  this session.
- A read-only invocation of the checkout's catalog reader against the actual environment returned
  `price=None`, `available=False`, and reproduced the exact user-facing warning through
  `_unpriced_warning()`.
- The same reader successfully loaded the checked-in reasoning-model fixture and returned base and
  context-tier prices for `gpt-6.1-sol`.
- Focused validation: **73 tests passed** across `test_model_prices.py`, `test_codex_cost.py`, and
  `test_supervisor_lifecycle.py`. Tests ran sequentially with bytecode and pytest cache writes
  disabled, in an isolated dependency environment. No live catalog refresh was performed.
- Git history identifies `fc445ad` / PR #2466 as the addition of native Codex pricing from the
  existing OpenCode cache file.

## Open Questions

- Did the source image's catalog refresh succeed before capture? The running session's logs do not
  include that build's result.
- Are all reported instances on Boat? This investigation directly confirms the current Boat sandbox;
  no other affected session identifiers were supplied.

## Evidence

- `packages/sandbox-runtime/src/sandbox_runtime/model_prices.py:121`: catalog path resolution,
  local-only loading, availability, and structured diagnostics.
- `packages/sandbox-runtime/src/sandbox_runtime/harness/codex/__init__.py:410`: price resolution
  before native turn submission; `:557` distinguishes warnings.
- `packages/sandbox-runtime/src/sandbox_runtime/harness/__init__.py`: `build_agent_harness()`
  injects the catalog into native Codex.
- `packages/sandbox-runtime/src/sandbox_runtime/entrypoint.py:51`: `build_harness_process()` selects
  the per-harness supervisor dependency.
- `packages/sandbox-images/install/filesystem.sh:21`: best-effort base-image catalog refresh for the
  runtime home.
- `packages/sandbox-runtime/src/sandbox_runtime/supervisor.py:609`: best-effort refresh
  implementation; `:742` restricts its invocation to builds.
- `packages/sandbox-images/src/sandbox_images/configuration.py`: `runtime_environment()` sets the
  runtime home without a separate cache path.
- `docs/BOAT_SANDBOX_PROVIDER.md:55`: documented snapshot exclusions and resume persistence
  behavior.
- `docs/IMAGE_PREBUILD.md:188`: general model-catalog assumptions; `:378` documents Boat's exclusion
  of the catalog from snapshots.
- `packages/sandbox-images/verify/smoke_test.py:264` and
  `packages/sandbox-runtime/src/sandbox_runtime/harness/codex/probe.py`: image verification and
  native handshake scope.
- `packages/sandbox-runtime/tests/test_codex_cost.py:124`: missing-catalog and missing-model
  warning/accounting expectations.
- `packages/sandbox-runtime/tests/test_model_prices.py`: local loading, unavailability, and recovery
  when the file appears.
- `packages/sandbox-runtime/tests/test_supervisor_lifecycle.py:207`: image-build refresh ordering
  and ordinary session startup without refresh.
- `packages/sandbox-runtime/tests/test_model_prices_opencode_contract.py` and
  `packages/sandbox-runtime/tests/codex_native/test_codex_native.py`: fixture-based catalogs in the
  optional real-binary pricing tests.
