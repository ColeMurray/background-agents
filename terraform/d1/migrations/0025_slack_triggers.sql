-- Slack message triggers (#716): a new `slack_event` automation source.
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

-- Per-automation blast-radius controls.
--   max_runs_per_hour: fixed 1-hour windowed cap (NULL = use the app default).
--   reply_in_thread:   post the run result back into the originating thread.
ALTER TABLE automations ADD COLUMN max_runs_per_hour INTEGER;
ALTER TABLE automations ADD COLUMN reply_in_thread INTEGER NOT NULL DEFAULT 1;

-- Slack thread coordinates + posting actor on the run. Nullable; only
-- slack-origin runs populate them. slack_thread_ts is the reply target;
-- slack_message_ts is the triggering message (used to clear the eyes reaction
-- on completion); actor_user_id is the posting Slack user, for attribution.
ALTER TABLE automation_runs ADD COLUMN slack_channel TEXT;
ALTER TABLE automation_runs ADD COLUMN slack_thread_ts TEXT;
ALTER TABLE automation_runs ADD COLUMN slack_message_ts TEXT;
ALTER TABLE automation_runs ADD COLUMN actor_user_id TEXT;

-- The rate-limit window query (automation_id = ? AND created_at >= ?) is already
-- served by idx_runs_automation_created (automation_id, created_at DESC) from
-- migration 0013, so no new automation_runs index is added here.
