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
- [ ] Control-plane generates the clone/build token and passes it to Modal as `clone_token`.
- [ ] Modal scheduler no longer contains provider-specific SHA lookup or token generation logic.
- [ ] Manual PR fallback URL is built via provider method (`buildManualPullRequestUrl`).
- [ ] Push transport spec is built via provider method (`buildGitPushSpec`).

## Tests Checklist

- [ ] Provider factory tests cover selection and unsupported behavior.
- [ ] Provider implementation tests cover:
  - [ ] manual PR URL building
  - [ ] push spec building
  - [ ] basic API mapping behavior
- [ ] Existing create-PR branch consistency tests still pass.
- [ ] Repo-image scheduler tests cover provider-neutral `headSha` inputs from control-plane.
- [ ] Slack manual-PR button tests still pass.
- [ ] No provider-specific URL/token logic is introduced outside provider/auth modules.

## Documentation Checklist

- [ ] Control-plane README documents any new provider-related env vars or constraints.
- [ ] Provider-selectable UI gating is documented for SCM-specific settings or integrations.
- [ ] ADR updated or added when architecture assumptions change.
