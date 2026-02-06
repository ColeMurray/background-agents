# ADR 0001: Single-Provider SCM Deployment and Boundary Rules

## Status

Accepted

## Context

Open-Inspect currently runs with GitHub as the only production SCM integration, while external
contributors have requested Bitbucket support. The codebase already has a `SourceControlProvider`
abstraction, but GitHub-specific details can still leak into non-provider layers if not guarded.

The team decision is to keep deployments single-provider. We need a safe foundation that preserves
existing GitHub behavior and prevents unsafe coupling during future provider contributions.

## Decision

1. **Single provider per deployment**
   - Deployment config (`SCM_PROVIDER`) selects the provider.
   - No per-session provider state is persisted.

2. **Fail fast for unimplemented providers**
   - If `SCM_PROVIDER` resolves to a provider without implementation (currently `bitbucket`),
     control-plane returns explicit `501 Not Implemented` responses for non-public routes.

3. **Provider/auth boundary rules**
   - Provider-specific PR URL and push-transport construction must live in provider implementations.
   - Direct GitHub API base URL usage is limited to approved auth/provider modules.

4. **Guardrails enforced by code review + focused tests**
   - Provider boundary expectations are documented and validated through provider/factory tests.

## Consequences

### Positive

- Minimizes migration risk by avoiding schema/API expansion.
- Keeps GitHub paths stable and auditable.
- Gives contributors a clear and safe insertion point for future providers.

### Negative

- Multi-provider-per-deployment use cases are intentionally unsupported.
- A future shift to multi-provider would require a new ADR and migration plan.

## Follow-Up Rules for Provider Contributions

- Add new provider logic under `packages/control-plane/src/source-control/providers`.
- Register provider in factory and env resolver.
- Do not add provider-specific URL/token logic to router/session/slack layers.
