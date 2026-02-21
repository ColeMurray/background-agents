# Provider Contribution Checklist

Use this checklist before opening a pull request for a new source-control provider.

## Architecture Checklist

- [ ] Provider implementation lives under `packages/control-plane/src/source-control/providers`.
- [ ] Provider factory (`createSourceControlProvider`) has an explicit case for the new provider.
- [ ] Deployment resolver (`SCM_PROVIDER`) recognizes the new provider name.
- [ ] No provider-specific URL/token construction was added to router/session/slack layers.

## Auth and API Checklist

- [ ] User-authenticated repository lookup and PR creation are implemented via
      `SourceControlProvider`.
- [ ] Push auth/token generation is implemented via provider auth path (not session/router
      hardcoding).
- [ ] Manual PR fallback URL is built via provider method (`buildManualPullRequestUrl`).
- [ ] Push transport spec is built via provider method (`buildGitPushSpec`).
- [ ] OAuth refresh path is implemented for provider tokens (if provider supports refresh tokens).
- [ ] Sandbox clone credential injection uses provider-neutral `VCS_*` env vars.

## Tests Checklist

- [ ] Provider factory tests cover selection and unsupported behavior.
- [ ] Provider implementation tests cover:
  - [ ] manual PR URL building
  - [ ] push spec building
  - [ ] basic API mapping behavior
- [ ] Existing create-PR branch consistency tests still pass.
- [ ] Slack manual-PR button tests still pass.
- [ ] No provider-specific URL/token logic is introduced outside provider/auth modules.
- [ ] Session create + ws-token paths persist provider-neutral SCM columns.

## Documentation Checklist

- [ ] Control-plane README documents any new provider-related env vars or constraints.
- [ ] ADR updated or added when architecture assumptions change.
