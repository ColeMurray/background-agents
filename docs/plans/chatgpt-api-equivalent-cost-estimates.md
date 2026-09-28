# ChatGPT subscription model-cost reporting

## Goal

Show the catalog API-price equivalent of OpenCode usage authenticated through a ChatGPT
subscription. As with Claude subscription usage, this is a model-cost estimate, not an incremental
subscription charge or an OpenAI invoice.

## Existing path

OpenCode emits a priced `step-finish` part. The sandbox runtime forwards its `cost` and cumulative
`messageCostUsd` through the existing event path. The control plane records that amount in
`session.total_cost`, applies the existing session cost limit, and the sidebar displays it as
session cost. No new events, storage columns, accounting service, or UI counter are needed.

Our managed OpenAI OAuth proxy is already loaded as an external OpenCode plugin. OpenCode's built-in
OAuth model hook zeroes catalog prices before the external hook runs; changing models in the auth
loader does not affect the accounting catalog.

## Change

Add an OAuth-only `provider.models` hook to the existing proxy. After the built-in hook, restore
supported Codex models it filtered out and apply prices from the same models.dev catalog OpenCode
uses, including cache, over-200k, and long-context tier rates. Read OpenCode's cached catalog on
each provider catalog rebuild; the image build already refreshes that file. Leave API-key models
unchanged and unknown models unpriced. If the cache is missing or invalid, keep OpenCode's zero
OAuth prices and log a warning instead of blocking the session. The next catalog rebuild can pick up
a refreshed file. The plugin makes no catalog network request and codes no prices into itself.

Because these prices use the existing cost path, they also count toward `max_cost_usd`, exactly as
Claude subscription-reported costs do. This is a usage guardrail, not evidence of a charge.

## Verification and rollout

- Test the OAuth-only catalog transform after the built-in hook, including a missing cache and
  subsequent recovery without a network request, filtered Codex models, API-key behavior, and the
  200k/272k price boundaries.
- Use the existing runtime, control-plane, and sidebar cost tests to verify the unchanged path.
- Do not modify OpenCode or deploy/probe a paid provider as part of this PR. A separate authorized
  canary can compare the displayed estimate with OpenCode token counts after deployment.
