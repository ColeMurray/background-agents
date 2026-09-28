# ChatGPT OAuth API-equivalent cost estimates

## Goal

Show the API-list-price equivalent of OpenCode usage authenticated through a
ChatGPT subscription. This is **not** a subscription charge, API invoice,
remaining quota, or credit balance. Do not change OpenCode itself or stop a
session because this estimate crosses a real-spend budget.

## Existing path

OpenCode emits a priced `step-finish` part. The sandbox runtime accumulates its
cost across parent and child steps and reports the cumulative turn cost to the
control plane, which persists `session.total_cost` and enforces
`max_cost_usd`. The session sidebar displays that real-cost counter. Our managed
OpenAI OAuth proxy is already loaded as an external OpenCode plugin; OpenCode's
built-in OAuth model hook currently zeroes catalog prices before the proxy's
auth loader runs. The auth loader receives a copy of the catalog, so editing its
model costs alone cannot change OpenCode accounting.

## Changes

1. Add an OAuth-only `provider.models` hook to the existing proxy. It runs
   after OpenCode's built-in hook and restores a pinned, reviewed API price
   snapshot for eligible model IDs, including cache and long-context tiers.
   Do not alter API-key models or guess a price for unknown IDs. Record the
   snapshot source and date; refresh it deliberately when models/prices change.
2. Attribute each priced OpenCode step to its assistant message's provider in
   the sandbox runtime. Route managed OpenAI OAuth prices into a distinct
   cumulative `messageApiEquivalentCostUsd` field; leave real `cost` and
   `messageCostUsd` unchanged for other providers. Preserve child steps,
   corrected parts, cancellation, and final completion recovery.
3. Add idempotent persistence for the estimated turn and session totals in the
   session Durable Object. Expose the estimate in snapshots and live updates,
   but keep it out of `total_cost`, budgets, and spend analytics. Older
   runtimes omit the new field and continue to work.
4. Show a separately labeled "API-equivalent estimate" in the session sidebar,
   explaining that it is not a ChatGPT bill. Leave the existing real-cost
   budget control and label intact.

## Verification and rollout

- Unit-test the plugin's OAuth-only model transform, known/missing prices, and
  long-context tiers without provider calls.
- Test parent/child and mixed-provider step attribution, corrected/replayed
  parts, and failed or cancelled turn completion.
- Test idempotent DO accounting, schema migration, snapshot/reconnect, and
  sidebar labeling; build shared before dependent typechecks.
- Land the code without deployment or live paid-provider probes. Check a
  managed OAuth session against OpenCode's reported token counts in a separate
  authorized canary before describing the estimate as production-verified.
