-- Webhook follow-ups do not create invocations, but their idempotency keys must
-- remain recognizable after the session continuity window expires. Retain these
-- receipts alongside invocation history rather than extending session continuity.
CREATE TABLE automation_follow_up_receipts (
  automation_id TEXT    NOT NULL,
  trigger_key   TEXT    NOT NULL,
  invocation_id TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (automation_id, trigger_key),
  FOREIGN KEY (automation_id) REFERENCES automations(id),
  FOREIGN KEY (invocation_id) REFERENCES automation_invocations(id)
);
