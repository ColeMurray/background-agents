-- pi-feature: crossSessionMessaging
-- Durable receipts for messages one Pi session hands to another session.
--
-- The receipt is written before the target session is called, so a retry
-- delivers the same message once and an interrupted delivery can always be
-- reconciled. The receipt records who initiated the message and which session
-- it came from; the target never presents the sender as its author.
CREATE TABLE cross_session_receipts (
  id                  TEXT PRIMARY KEY CHECK (id GLOB 'xsr_*'),
  source_session_id   TEXT NOT NULL,
  target_session_id   TEXT NOT NULL,
  operation_id        TEXT NOT NULL,
  human_actor_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  agent_conversation_id TEXT,
  source_task_id      TEXT,
  depth               INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0),
  idempotency_key     TEXT NOT NULL,
  content_sha256      TEXT NOT NULL CHECK (length(content_sha256) = 64),
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'delivered', 'rejected')),
  target_message_id   TEXT,
  rejection_reason    TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  UNIQUE (source_session_id, idempotency_key)
);

CREATE INDEX idx_cross_session_receipts_source
  ON cross_session_receipts(source_session_id, created_at DESC, id);

-- The fan-out limit counts the messages one turn produced.
CREATE INDEX idx_cross_session_receipts_operation
  ON cross_session_receipts(source_session_id, operation_id, created_at DESC, id);
