-- Slack message triggers: a new `slack_event` automation source.
-- Additive only. No DO storage-schema change, so no two-phase DO-binding deploy.

-- Channels watched by each slack_event automation. This join table is the
-- candidate / watched-channel key for channel-keyed selection, replacing a
-- full-scan + JSON parse of every automation's trigger_config.
CREATE TABLE IF NOT EXISTS automation_slack_channels (
  automation_id TEXT NOT NULL,
  channel_id    TEXT NOT NULL,
  PRIMARY KEY (automation_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_slack_channels_channel
  ON automation_slack_channels (channel_id);

-- Per-automation rate limit (generic; consumed by slack_event today). A fixed
-- 1-hour windowed cap; NULL means use the app default. reply_in_thread is NOT a
-- column — it lives in the automation's trigger_config JSON, keyed by trigger_type.
ALTER TABLE automations ADD COLUMN max_runs_per_hour INTEGER;

-- Source-specific run metadata as JSON; only slack-origin runs populate it
-- today. For slack: {channel, threadTs?, messageTs} — threadTs is the reply
-- target (falls back to messageTs), messageTs is the triggering message used to
-- clear the eyes reaction on completion. Read back only to post the result into
-- the originating thread; never queried, so no index.
ALTER TABLE automation_runs ADD COLUMN trigger_run_metadata TEXT;

-- The rate-limit window query (automation_id = ? AND created_at >= ?) is already
-- served by idx_runs_automation_created (automation_id, created_at DESC) from
-- migration 0013, so no new automation_runs index is added here.
