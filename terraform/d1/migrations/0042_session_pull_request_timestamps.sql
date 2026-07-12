-- PR outcome timestamps for analytics (docs/pr-analytics-design.md §3): when a
-- pull request was created, merged, and closed according to the provider.
-- provider_updated_at cannot answer these — it keeps drifting after merge
-- (comments bump GitHub's updated_at) and our updated_at is overwritten on
-- every upsert.
--
-- All nullable, epoch ms. No backfill (same philosophy as 0041): the webhook
-- and read-through write paths carry the provider values and repair existing
-- rows on next contact. Analytics buckets PR creation by
-- COALESCE(provider_created_at, created_at) — exact for creation-path rows,
-- corrected by the provider value for fallback-inserted rows.
--
-- merged_at is only meaningful when lifecycle_state = 'merged'; closed_at only
-- when the PR is not open (clears on reopen). Enforced in snapshotToRecord —
-- the single snapshot→record mapping every writer flows through — rather than
-- CHECK constraints (SQLite ADD COLUMN cannot add table-level CHECKs).

ALTER TABLE session_pull_requests ADD COLUMN provider_created_at INTEGER;
ALTER TABLE session_pull_requests ADD COLUMN merged_at INTEGER;
ALTER TABLE session_pull_requests ADD COLUMN closed_at INTEGER;
