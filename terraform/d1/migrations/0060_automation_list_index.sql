CREATE INDEX IF NOT EXISTS idx_automations_active_created_id
  ON automations(created_at DESC, id DESC)
  WHERE deleted_at IS NULL;
