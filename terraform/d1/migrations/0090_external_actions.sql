-- pi-feature: externalActions
-- Executor-owned unattended external-action grants. These authorize only a
-- provider/action pair; credentials remain in their existing provider stores.
CREATE TABLE automation_external_action_grants (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  executor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  action TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_reason TEXT,
  CHECK ((revoked_at IS NULL) = (revoked_reason IS NULL))
);

CREATE UNIQUE INDEX idx_automation_external_action_grants_active
  ON automation_external_action_grants(automation_id, provider, action)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_automation_external_action_grants_executor
  ON automation_external_action_grants(executor_user_id, automation_id)
  WHERE revoked_at IS NULL;

-- Temporary rollback bridge for binaries that predate application-level
-- executor-change revocation. Remove only in a later forward migration after
-- those binaries are outside every rollback window.
CREATE TRIGGER revoke_external_action_grants_on_executor_change
AFTER UPDATE OF user_id ON automations
WHEN OLD.user_id IS NOT NEW.user_id
BEGIN
  UPDATE automation_external_action_grants
  SET revoked_at = NEW.updated_at, revoked_reason = 'executor_changed'
  WHERE automation_id = NEW.id AND revoked_at IS NULL;
END;
