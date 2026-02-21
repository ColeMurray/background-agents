# ADR 0001: SCM Provider Boundaries with Per-Session Provider State

## Status

Accepted

## Context

Open-Inspect now supports both GitHub and Bitbucket integration paths. The codebase has a
`SourceControlProvider` abstraction, but provider-specific details can still leak into non-provider
layers if not guarded.

We need explicit rules for where provider-specific behavior belongs while allowing session-level
provider selection (`vcs_provider`) with deployment defaults.

## Decision

1. **Per-session provider persistence**
   - Session state persists `vcs_provider` at creation time.
   - Deployment config (`SCM_PROVIDER`) is still supported as fallback/default when session value is
     absent.

2. **Provider/auth boundary rules**
   - Provider-specific PR URL and push-transport construction must live in provider implementations.
   - Direct provider API usage is limited to approved auth/provider modules.
   - Session/router/sandbox orchestration layers remain provider-neutral.

3. **Provider-neutral runtime contracts**
   - Participant auth state is stored in provider-neutral SCM columns, with temporary legacy GitHub
     compatibility fields during migration.
   - Sandbox git credentials are injected via provider-neutral `VCS_*` env vars.

4. **Guardrails enforced by code review and focused tests**
   - Provider boundary expectations are documented and validated through provider/factory tests.

## Consequences

### Positive

- Enables GitHub and Bitbucket support without duplicating orchestration logic.
- Keeps provider-specific behavior constrained to well-defined modules.
- Maintains backward compatibility while migrating legacy GitHub-named fields.

### Negative

- Requires schema and token pipeline complexity during migration period.
- Requires tighter test coverage to avoid regressions between providers.

## Follow-Up Rules for Provider Contributions

- Add new provider logic under `packages/control-plane/src/source-control/providers`.
- Register provider in factory and provider resolver paths.
- Do not add provider-specific URL/token logic to router/session/slack/web orchestration layers.
