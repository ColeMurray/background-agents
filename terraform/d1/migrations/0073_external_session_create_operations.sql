CREATE TABLE external_session_create_operations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  session_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('reserved', 'session_created', 'completed')),
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, idempotency_key),
  CHECK (
    (stage = 'completed' AND result_json IS NOT NULL)
    OR (stage != 'completed' AND result_json IS NULL)
  )
);

CREATE UNIQUE INDEX idx_external_session_create_operation_session
ON external_session_create_operations(session_id);

CREATE TRIGGER external_session_create_operations_legal_transition
BEFORE UPDATE ON external_session_create_operations
FOR EACH ROW
WHEN
  NEW.user_id != OLD.user_id
  OR NEW.idempotency_key != OLD.idempotency_key
  OR NEW.request_hash != OLD.request_hash
  OR NEW.session_id != OLD.session_id
  OR (OLD.stage = 'reserved' AND NEW.stage != 'session_created')
  OR (OLD.stage = 'session_created' AND NEW.stage != 'completed')
  OR OLD.stage = 'completed'
BEGIN
  SELECT RAISE(ABORT, 'illegal external session create operation transition');
END;
