# ADR 0005: Sandbox launch policy and the interactive Modal contract

## Status

Proposed in this change. The implementation preserves legacy traffic by default; v1 enablement
requires the rollout evidence in the companion runbook.

## Context

Fresh create and snapshot restore resolved common session inputs in separate lifecycle methods.
Modal create then reconstructed a Python `SessionConfig` from flat fields, while restore forwarded
nested fields. Independent unit tests did not prove that actual TypeScript output reached the
runtime consumers.

Research began at `fab55fea1aa6a5e6d1876de22ed237822688c3f7`; the implementation is rebased onto
`232bb74c5b62ea290fa7bfd2b566dc7b1d52c2c5`, retaining PR #2014's lifecycle-preservation protections.
Existing PR #1809 overlaps the extraction but predates current harness and provider-settings
behavior and parallelizes prerequisites. It was inspected, not applied. Check overlap again before
merging either change.

## Decision

### Policy and attempt ownership

`LaunchPolicyResolver` owns common fresh/restore configuration, integration degradation rules,
persisted settings normalization, and read-only prepared-image eligibility. Its result is ephemeral
launch inputs, **not** a durable or globally atomic Launch Plan. The lifecycle manager retains
identity reservation, prior object retirement, image invalidation/retry, snapshot runtime version,
recovery holds, generation claims, access publication, and late-result cleanup.

Hard prerequisites remain ordered; review verified that MCP and Slack have no dependency on one
another:

- fresh: secrets → repository membership → image eligibility → concurrent MCP and Slack;
- restore: secrets → repository membership → concurrent MCP and Slack;
- resume: settings only; no new environment/model/MCP resolution.

`UserEnvResolver` still rereads session state and current secrets using persisted auth bindings.
`SessionCoreRepository` initialization can upsert session fields; repository branch/diff metadata
has separate writers. We do not establish a new cross-store snapshot guarantee or move any read
before identity reservation. An image-unavailable retry reuses resolved inputs but reserves a new
ID/token; a separate launch resolves secrets again.

### One session serializer, separate compatibility envelopes

All Modal session-policy encoding uses `buildSessionConfig`. The legacy create encoder preserves
flat keys, explicit nulls, model defaults and agent session identity. The legacy restore encoder
preserves the nested shape and omission semantics. Provider-native launch/resume/resource/lifetime
behavior is unchanged.

The opt-in v1 envelope uses nested session configuration for both operations. It requires explicit
sandbox identity, timeout, service flags, ports, terminal enablement, tunnel list, user environment,
and session policy. The receiver validates known values and forwards runtime extensions on both
paths, rather than rebuilding create's `SessionConfig`. Missing, null or unknown contract versions
are rejected unless the discriminator is absent (legacy).

The focused `launch_contract.py` module owns transport models, version dispatch and direct mapping
of each wire version to `LaunchCommand`. Endpoints retain auth, URL policy, telemetry and provider
orchestration; v1 never dumps/reparses through legacy models. Shared redacted request-error handling
lives in `request_validation.py`.

The Python transport models own receiver validation. Their published JSON Schema is checked against
those models. Actual TypeScript-emitted payloads run through those same validators and runtime
readers in CI. This avoids a schema-generation framework and a second hand-maintained TS validator.
The schema is descriptive of the receiver contract; producers cannot establish compatibility by
updating the artifact alone.

Top-level v1 fields are closed; nested runtime configuration and repository/MCP extensions remain
forward-compatible. Unknown nested keys cannot override native execution credentials. Transport
version, runtime/image generation, and startup attempt generation remain unrelated identifiers.
Incompatible semantic changes require another version; optional forwarded runtime extensions do not
by themselves.

### Credential and provider boundaries

The review did not identify a required invariant that would justify relocating Modal's random
code-server/VNC password generation. It remains provider-owned, returned through the existing access
result. Persistent-resume providers retain their existing deterministic credential derivation.

Legacy snapshot SCM credentials, SCM host mapping, and native LLM secret attachment remain
explicitly supported provider compatibility behavior. Current code alone does not prove equivalence
of credential scope/expiry across all retained images or self-hosted deployments. This PR does not
remove or relocate these paths. The v1 envelope is a resolved **launch-input contract**, not a claim
that all provider/credential mechanics have become a provider-neutral runtime bundle.

This decision narrows the earlier full-plan proposal: share actual policy, not randomness or
provider-specific resource delivery solely to satisfy terminology. No provider management keys,
signing keys or encrypted-secret root keys enter the new envelope. It has the same sensitive user
environment as legacy and must not be logged, persisted, or fingerprinted for telemetry.

### Deployment

The receiver accepts both versions. `MODAL_LAUNCH_CONTRACT_VERSION` defaults to `legacy`, validates
configured values, and is wired for Node and Terraform. Terraform's
`modal_launch_contract_v1_enabled` defaults to false. There is no automatic negotiation, downgrade,
or retry after an ambiguous provider response.

`api_health` advertises accepted launch versions without launching a resource. It is a capability
signal, not proof of image compatibility or a completed canary. The dedicated contract CI workflow
runs on every PR so neither side can bypass the check via a path-filter omission.

## Consequences

- One owner hides launch lookup/default/failure policy from lifecycle orchestration.
- One end-to-end contract check joins producer, receiver and actual runtime readers.
- Provider resource normalization, secret delivery and restore/resume semantics stay local.
- Two wire decoders remain intentionally during rollout; their retention is owned by
  provider/runtime and deployment maintainers, not an unbounded implicit fallback.
- Native canaries, historical-runtime evidence, activation and eventual legacy retirement remain
  release operations, not side effects of this source change.

See [launch contract implementation and rollout](../plans/sandbox-launch-contract-rollout.md).
