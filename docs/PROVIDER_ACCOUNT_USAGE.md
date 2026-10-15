# Provider account usage

Settings → Provider accounts has an on-demand **Check usage** action for each active ChatGPT
account. It displays the provider's primary and secondary Codex subscription windows, the percentage
used and remaining, and each reset time. The provider's independent admission flags are preserved; a
displayed percentage is not a guarantee that an inference request will be admitted. A past reset
time does not manufacture a fresh allowance.

xAI and Anthropic accounts explicitly show unsupported usage reporting. Disabled or
reconnect-required accounts show unavailable. A blocked, timed-out, malformed, or failed upstream
request shows unavailable without affecting account management or silently changing an account's
lifecycle state.

## Server boundary

`GET /model-provider-accounts/:id/usage` requires the same human user admission and
`provider_accounts.read` permission as account metadata reads. The BFF validates account IDs and
forwards the authenticated browser session. Responses are `private, no-store` and contain only the
normalized usage union in `@open-inspect/shared/types/provider-account-usage`.

The control plane resolves **that named account** through `ModelProviderAccountBroker`, including
its existing lifecycle, identity, rotating-grant, and credential persistence checks. Usage reads do
not resolve installation defaults, switch accounts, or fall back to
legacy/global/repository/environment OAuth or API keys. Existing legacy credentials must first be
connected as a provider account to use this feature. Tokens, raw provider bodies, credit balances,
and unrelated provider fields never enter the web response or usage cache. Usage fetches do not
independently mark an account as requiring reconnection; the credential broker retains ownership of
authentication failure handling.

The passive official Codex client protocol is pinned and documented alongside the
[fixtures](../packages/control-plane/test/fixtures/provider-usage/README.md). Fixtures are synthetic
protocol examples from official CLI source, not evidence that a deployed endpoint is accessible.

## Bounds, cache, and transport

`PROVIDER_ACCOUNT_USAGE_TIMEOUT_MS` bounds the cache lookup, broker wait, request, and body read as
one operation. Fetches are aborted when the caller stops waiting. The underlying broker promise is
retained through the background-task port so a consumed rotating grant can finish its durable
credential commit after the caller deadline. Cache persistence also runs through that port, outside
the observation's critical path. Responses use the existing bounded provider-body reader. Redirects
are returned manually and rejected, so bearer credentials are never forwarded to a redirect target.

Normalized observations and provider failures share the existing server cache under a dedicated
namespace, keyed by account ID and lifecycle version, which usage attribution does not change. Check
and Refresh use the same explicit browser request; the server owns freshness. Entries are reused for
at most `PROVIDER_ACCOUNT_USAGE_CACHE_MS`, and successful observations expire earlier at the next
future window reset. Account eligibility is checked before cache access. Cache failures degrade to
reads; the cache is best effort and does not provide a cross-isolate request lock. Checks are
initiated by the user, not by background polling of every stored account.

When the host supplies the optional `EGRESS` fetch port, quota reads use it exclusively. This
matches the optional transport shape in
[PR #2415](https://github.com/ColeMurray/background-agents/pull/2415). A configured egress failure
never retries with direct fetch. Without this port, the host's direct fetch is used. This change
does not provision or enable VPC infrastructure. A Cloudflare edge block on direct requests is a
normal unavailable result; operators can qualify their chosen host/egress path independently.

No live authenticated quota endpoint, deployed Cloudflare/VPC path, quota exhaustion, or inference
continuity was verified. Account switching and metered fallback remain in the separate
[rotation PR](https://github.com/ColeMurray/background-agents/pull/2023) and
[fallback PR](https://github.com/ColeMurray/background-agents/pull/1532).
