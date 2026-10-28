-- Who authored the action that started a firing: 'person', 'bot', 'system'
-- (the scheduler, with no author) or 'unknown' (the source does not say).
-- Limits on bot-started runs count this column instead of matching the
-- serialized trigger_metadata, which miscounts silently if that JSON changes.
--
-- Rows written by a worker that predates the column take the default. There is
-- no CHECK: the set is expected to grow as more sources report their authors,
-- and widening a CHECK means swapping the column (see 0087) and rebuilding the
-- index below. The store's InvocationActorKind type constrains the writers.
ALTER TABLE automation_invocations ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'unknown';

-- Only the Slack event handler writes trigger_metadata, and it writes botId
-- only when a bot posted the message. Bot rows are what the hourly limit
-- counts, so backfilling them keeps firings recorded before this migration in
-- the count. Firings the previous worker records between this migration and
-- the new worker's deploy take 'unknown' and go uncounted, a gap of at most
-- one limit window. Slack person rows (messageTs but no botId) are labelled
-- too. Other legacy rows keep 'unknown'.
UPDATE automation_invocations SET actor_kind = 'bot'
  WHERE source = 'event' AND trigger_metadata LIKE '%"botId":%';
UPDATE automation_invocations SET actor_kind = 'person'
  WHERE source = 'event' AND actor_kind = 'unknown' AND trigger_metadata LIKE '%"messageTs":%';

-- Serves "unskipped firings of an automation by one actor kind since a time".
-- Queries must state skip_reason IS NULL literally to use it.
CREATE INDEX idx_invocations_actor_created
  ON automation_invocations (automation_id, actor_kind, created_at)
  WHERE skip_reason IS NULL;
