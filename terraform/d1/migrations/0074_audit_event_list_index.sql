CREATE INDEX idx_authorization_audit_events_occurred_at_id
ON authorization_audit_events(occurred_at DESC, id DESC);
