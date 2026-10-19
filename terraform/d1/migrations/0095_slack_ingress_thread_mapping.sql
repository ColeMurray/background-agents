-- pi-feature: slackIngress
ALTER TABLE slack_ingress_receipts ADD COLUMN thread_mapping_json TEXT
  CHECK (thread_mapping_json IS NULL OR length(thread_mapping_json) <= 16384);
CREATE INDEX idx_slack_ingress_thread_mapping
  ON slack_ingress_receipts(channel_id, thread_ts, updated_at)
  WHERE thread_mapping_json IS NOT NULL;
