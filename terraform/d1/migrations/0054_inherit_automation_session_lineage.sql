WITH RECURSIVE automation_descendants(id, automation_id, automation_run_id) AS (
  SELECT id, automation_id, automation_run_id
  FROM sessions
  WHERE spawn_source = 'automation' AND automation_id IS NOT NULL

  UNION

  SELECT child.id, parent.automation_id, parent.automation_run_id
  FROM sessions child
  JOIN automation_descendants parent ON child.parent_session_id = parent.id
  WHERE child.automation_id IS NULL
)
UPDATE sessions
SET
  automation_id = (
    SELECT automation_id FROM automation_descendants WHERE automation_descendants.id = sessions.id
  ),
  automation_run_id = (
    SELECT automation_run_id FROM automation_descendants WHERE automation_descendants.id = sessions.id
  )
WHERE automation_id IS NULL
  AND id IN (SELECT id FROM automation_descendants);

CREATE INDEX idx_sessions_user_non_automation_updated
  ON sessions(user_id, updated_at DESC)
  WHERE automation_id IS NULL;
