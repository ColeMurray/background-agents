-- Webhook follow-ups do not create invocations, but their idempotency keys must
-- remain recognizable after the session continuity window expires. Retain these
-- receipts alongside invocation history rather than extending session continuity.
CREATE TABLE automation_follow_up_receipts (
  automation_id       TEXT    NOT NULL,
  trigger_key         TEXT    NOT NULL,
  invocation_id       TEXT,
  claim_id            TEXT,
  claim_invocation_id TEXT,
  claim_expires_at    INTEGER,
  accepted_at         INTEGER,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (automation_id, trigger_key),
  CHECK (
    (accepted_at IS NOT NULL AND invocation_id IS NOT NULL AND claim_id IS NULL
      AND claim_invocation_id IS NULL AND claim_expires_at IS NULL)
    OR (accepted_at IS NULL AND invocation_id IS NULL AND claim_id IS NOT NULL
      AND claim_invocation_id IS NOT NULL AND claim_expires_at IS NOT NULL)
  ),
  FOREIGN KEY (automation_id) REFERENCES automations(id),
  FOREIGN KEY (invocation_id) REFERENCES automation_invocations(id)
);
