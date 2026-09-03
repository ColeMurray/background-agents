# Claude Subscription Accounts

## Status and support boundary

This document describes the implementation for using a Claude subscription as a managed model
provider account. The implementation is deliberately isolated behind the existing provider-account
boundary so that rotating credentials remain in the control plane.

Anthropic does not currently publish the Claude subscription OAuth endpoints as a third-party OAuth
contract. Anthropic's current legal and compliance guidance also says third-party applications must
not offer Claude.ai login, collect or intermediate Claude.ai credentials, or route Free, Pro, or Max
credentials on behalf of users. OpenCode removed its bundled Anthropic subscription plugin after an
Anthropic legal request. Deployments must therefore obtain Anthropic approval before enabling this
integration. The supported fallback is an Anthropic API key or a supported cloud provider.

Sources reviewed on 2026-08-29:

- [Claude Code authentication](https://code.claude.com/docs/en/authentication)
- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [OpenCode Anthropic provider documentation](https://opencode.ai/docs/providers/#anthropic)
- [OpenCode removal PR](https://github.com/anomalyco/opencode/pull/18186)
- [Meridian token refresh](https://github.com/rynfar/meridian/blob/099741dd7a341daa767b08e20649456c51675b62/src/proxy/tokenRefresh.ts)
- [Meridian OpenCode adapter](https://github.com/rynfar/meridian/blob/099741dd7a341daa767b08e20649456c51675b62/src/proxy/adapters/opencode.ts)
- [Orca account registration](https://github.com/stablyai/orca/blob/446110810c63687c73274920f60d279526d41f36/src/main/claude-accounts/claude-account-registration.ts)
- [Orca runtime auth service](https://github.com/stablyai/orca/blob/446110810c63687c73274920f60d279526d41f36/src/main/claude-accounts/runtime-auth-service.ts)
- [opencode-with-claude](https://github.com/ianjwhite99/opencode-with-claude/tree/e88b2c5a76e2a2ed2694d318abcb575031b68534)
- [Background Agents issue 1542](https://github.com/ColeMurray/background-agents/issues/1542)

## Goals

1. Register and reconnect Claude subscription accounts from Provider Accounts settings.
2. Select a Claude account per interactive session or as the unattended installation default.
3. Pin that selection for the session lifetime and inherit it in child sessions.
4. Keep refresh tokens encrypted in D1 and out of browsers after registration, sandboxes, snapshots,
   OpenCode auth files, process arguments, and logs.
5. Coordinate refresh across any number of Cloudflare Worker isolates and Modal sandboxes.
6. Persist a rotated refresh token before releasing its access token to a sandbox.
7. Preserve existing Anthropic API-key behavior for installations and sessions that do not select a
   Claude account.
8. Fail closed on ambiguous rotation outcomes instead of retrying a potentially consumed token.

## Non-goals

- Pooling quota or failing over between Claude accounts.
- Sharing one account across tenants. Provider accounts remain installation-wide under the current
  single-tenant architecture.
- Proxying prompts or response streams through Cloudflare.
- Giving refresh tokens to Meridian, OpenCode, or Claude Code in a sandbox.
- Treating community-observed OAuth endpoints as a stable Anthropic API.
- Automatically renewing an expired login after its refresh credential is no longer valid.

## Selected architecture

```text
Browser PKCE registration
  -> control-plane token exchange
  -> encrypted account credential in D1

OpenCode in sandbox
  -> Anthropic request fetch override
  -> session-bound access-token broker route
  -> immutable session provider-account selection
  -> D1 credential claim and generation fence
  -> Anthropic token refresh (only when required)
  -> encrypted rotated credential committed to D1
  -> short-lived access token returned to sandbox
  -> direct Anthropic inference request
```

The existing `ModelProviderAccountBroker` and `ClaimedProviderCredentialExchange` are the refresh
coordinator. Their D1 compare-and-swap claim is the cross-isolate correctness boundary; the local
single-flight promise only reduces duplicate work within one Worker isolate.

The existing minute Worker cron also queries a bounded batch of active Anthropic accounts whose
access expires within six minutes and invokes that same broker. This keeps idle refresh chains
active without creating a second exchange implementation. The broker's five-minute buffer means the
one-minute lookahead margin tolerates cron jitter; claim fencing still coordinates the cron with
live sandbox requests and other Worker isolates.

No provider-account Durable Object is needed. A Durable Object would serialize calls, but it cannot
make the external token exchange atomic with persistence and would create another state authority.
The existing D1 generation, owner, credential-version, lifecycle, and account-status fences already
cover reconnect, disable, stale completion, and concurrent refresh races.

## Registration flow

Anthropic's observed flow is OAuth authorization code with PKCE S256 rather than device
authorization.

1. The settings browser generates independent random `code_verifier` and `state` values.
2. It derives `code_challenge = base64url(SHA-256(code_verifier))`.
3. It opens the Claude authorization page with the public Claude Code client ID, redirect URI,
   scopes, PKCE challenge, and state.
4. Anthropic displays or redirects with a callback value in `code#state` form.
5. The browser verifies that the returned state equals its pending state.
6. The browser submits the authorization code, verifier, and state over the authenticated Provider
   Accounts API. These one-time values are bounded and rejected if extra fields are present.
7. The control plane exchanges the code directly with Anthropic. The browser never receives the
   resulting access or refresh token.
8. The account service encrypts and atomically persists the initial credential. The account becomes
   available only after persistence succeeds.

The PKCE values intentionally live only in the browser during the short registration operation. They
are public-client proof values, not reusable provider credentials. A future provider-approved hosted
callback can move these values into the encrypted authorization transaction store without changing
the account credential or broker design.

Claude does not currently provide a trusted stable external account identity in the observed token
response. Claude accounts therefore have a null external identity and are not automatically
deduplicated. Reconnect updates a specific account selected by its Open Inspect account ID.

## Credential model

The encrypted version 1 payload contains:

```ts
{
  refreshToken: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
  refreshTokenExpiresAt?: number;
  scopes?: string[];
}
```

Only `access_token_expires_at` is duplicated into a plaintext D1 column so that refresh scheduling
and broker decisions do not require decrypting every credential. Token values remain solely in the
authenticated encrypted payload.

The adapter accepts both `expires_in` and provider-observed refresh-expiry fields, applies bounded
defaults, and preserves the previous refresh token only when a successful refresh response omits a
replacement. Any malformed success response is ambiguous because the provider may already have
consumed the rotating token.

## Refresh and concurrency invariants

For each account:

1. Reuse a cached access token only outside the refresh buffer.
2. Claim `idle -> in_flight` with the expected credential version.
3. Allow only the claim owner to call Anthropic's refresh endpoint.
4. Parse and validate the complete response before constructing a replacement credential.
5. Commit the encrypted replacement using account status, credential version, exchange generation,
   and exchange owner predicates.
6. Return access only after that commit succeeds.
7. Make losing isolates reread the winner's credential and reuse the committed access token.
8. Reject late completion after reconnect, disable, archive, or stale-claim recovery.
9. Mark the account `reconnect_required` after unauthorized or ambiguous rotation failure.
10. Clear the claim and allow retry only for failures proven to occur before provider dispatch.

This avoids the Meridian/Orca failure mode where multiple processes read refresh token `R0`, one
rotates it to `R1`, and another retries or overwrites state using consumed `R0`.

## Session routing and migration

`anthropic` is added to the closed subscription-provider registry, selection schemas, automation
schemas, defaults, and complete session-auth snapshot.

Existing sessions receive an Anthropic `api_key` row during migration. This is necessary because
they predate account selection and currently use `ANTHROPIC_API_KEY`; assigning the generic
`legacy_scoped_oauth` mode would point at a nonexistent legacy Anthropic refresh route.

New sessions resolve Anthropic in this order:

1. Explicit Claude account or API-key selection.
2. Installation default account.
3. Unattended API-key policy.
4. API-key compatibility fallback when no Anthropic default exists.

OpenAI and xAI retain their legacy scoped-OAuth fallback. Child sessions continue copying the
parent's complete auth snapshot verbatim.

## Sandbox integration

Managed account mode emits `ANTHROPIC_OAUTH_MANAGED=1`. It removes or overrides the ordinary
`ANTHROPIC_API_KEY` for the OpenCode process so the selected account cannot silently fall back to
API billing. The generated OpenCode `auth.json` contains only the same harmless managed sentinel
used by the other provider-account plugins.

The Anthropic OpenCode plugin:

- Activates only for the managed OAuth sentinel.
- Obtains access from `/sessions/:id/provider-auth/anthropic/access-token` using the sandbox
  principal. It never submits an account ID.
- Caches access only in memory and refreshes through the broker before expiry.
- Deletes `x-api-key` and sets bearer authorization.
- Adds the observed OAuth beta headers and compatible Claude CLI user agent.
- Adds `?beta=true` only to `/v1/messages`, matching the prior OpenCode integration.
- Applies the current observed Claude Agent SDK identity, billing marker, and Claude-style tool-name
  transformations required by subscription inference, then restores tool names in streamed output.
- Preserves model IDs and zeroes displayed costs for subscription-backed models.
- Does not write the real access token to OpenCode's auth file.

This direct fetch integration is smaller than embedding Meridian and avoids Meridian's local
credential scheduler. Meridian currently has no external credential-provider interface, so a
sandbox-local Meridian process would either need a fork or would receive a credential it can try to
refresh. A future Meridian integration should add a broker-managed profile that accepts an access
token callback and disables all local/background refresh paths.

## Failure handling

- `invalid_grant`, HTTP 401, or an expired refresh credential: mark reconnect required.
- Timeout, network reset, malformed success, oversized body, or persistence failure after dispatch:
  treat as ambiguous, fence the credential, and require reconnect.
- A known failure before request dispatch: release the claim for bounded retry.
- D1 unavailable: fail closed; do not fall back to an API key or another account.
- Account disabled or archived: deny future broker calls. Already issued access remains usable only
  until its provider expiry.
- Sandbox restored from a snapshot: no durable provider token exists in the snapshot; its in-memory
  cache is gone and the first request returns the current committed access from the broker.
- Access expires during streaming: do not replay a partial generation. Refresh applies to the next
  request.
- Provider contract drift: surface an explicit provider-account failure rather than passing unknown
  fields or credentials through to the sandbox.

## Verification plan

Shared contracts:

- Accept Anthropic selections and PKCE connect/reconnect requests.
- Reject unknown fields, missing state, malformed verifier/code values, and credential leakage.
- Map canonical Claude catalog models to the Anthropic subscription provider.

Control plane:

- Parse initial and refresh token responses, expiry values, and rotated refresh tokens.
- Classify unauthorized and ambiguous failures.
- Verify cached access and refresh-buffer boundaries.
- Exercise account creation, reconnect, verification, defaults, session pinning, and API-key
  fallback.
- Verify the migration backfills every existing session with Anthropic API-key mode and updates the
  insert trigger.
- Reuse existing broker concurrency tests for one-winner refresh, stale ownership, lifecycle races,
  and persistence-before-release.

Sandbox runtime:

- Generate only a managed sentinel in `auth.json`.
- Deploy the Anthropic plugin only when marked managed.
- Ensure plugin source contains no refresh endpoint or refresh-token environment reference.
- Verify bearer header replacement, API-key removal, beta-header merging, and broker single-flight.
- Confirm managed environment preparation suppresses ordinary Anthropic API-key routing.

Web:

- Generate independent verifier/state values and a valid S256 challenge.
- Parse callback URLs and `code#state`, and reject mismatched state before submission.
- Create and reconnect an account through the Provider Accounts UI.
- Show Anthropic in session and automation selectors while retaining API-key mode.

End to end before production enablement:

- Run at least two concurrent sandboxes against one account across access expiry and verify one
  upstream refresh and one persisted rotated credential.
- Terminate the refresh-winning Worker before and after provider dispatch to verify conservative
  recovery.
- Restore an old sandbox snapshot after rotation and verify it cannot revive stale state.
- Exercise streaming, tools, subagents, reasoning variants, and child-session inheritance.
- Verify disable and reconnect behavior against already-running sessions.
- Confirm no refresh token appears in sandbox environment, filesystem, snapshots, logs, or browser
  responses.

## Rollout

1. Obtain written Anthropic approval and confirm OAuth client/endpoints, scopes, headers, allowed
   products, and refresh-rotation semantics.
2. Run contract tests against a non-production subscription account.
3. Deploy the D1 migration and control plane before exposing the web registration UI.
4. Rebuild the sandbox image so the Anthropic plugin is present.
5. Enable one installation/account and monitor broker failures and reconnect transitions.
6. Test concurrent sandboxes through an access-token rollover.
7. Expand only after confirming account limits and acceptable-use behavior.

Rollback is configuration-first: remove the Anthropic default and use API-key mode for new sessions.
Existing sessions stay pinned; disabling the account blocks new access leases. The schema and
historical auth rows can remain because removing them would make old session snapshots incomplete.
