DROP TRIGGER IF EXISTS assign_default_role_after_user_insert;

CREATE TABLE authorization_audit_events_v2 (
  id TEXT PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  request_id TEXT NOT NULL,
  principal_kind TEXT NOT NULL,
  actor_user_id_snapshot TEXT,
  actor_service_snapshot TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  target_user_id_snapshot TEXT,
  reason_code TEXT NOT NULL,
  operation_result TEXT NOT NULL CHECK (operation_result IN ('applied', 'no_op')),
  metadata_json TEXT NOT NULL CHECK (
    json_valid(metadata_json)
    AND json_type(metadata_json) = 'object'
    AND COALESCE(
      json_type(metadata_json, '$.legacy') = 'true'
      OR (
        json_type(metadata_json, '$.before') = 'object'
        AND json_type(metadata_json, '$.requested') = 'object'
        AND json_type(metadata_json, '$.after') = 'object'
      ),
      0
    )
  )
);

INSERT INTO authorization_audit_events_v2 (
  id, occurred_at, request_id, principal_kind,
  actor_user_id_snapshot, actor_service_snapshot, action, resource_type,
  resource_id, target_user_id_snapshot, reason_code, operation_result, metadata_json
)
SELECT
  id, occurred_at, request_id, principal_kind,
  actor_user_id_snapshot, actor_service_snapshot, action, resource_type,
  resource_id, target_user_id_snapshot, reason_code, 'applied',
  json_object('legacy', json('true'))
FROM authorization_audit_events;

DROP TABLE authorization_audit_events;
ALTER TABLE authorization_audit_events_v2 RENAME TO authorization_audit_events;

CREATE TRIGGER assign_default_role_after_user_insert
AFTER INSERT ON users
BEGIN
  INSERT INTO user_role_assignments (user_id, role_id)
  VALUES (NEW.id, 'role_builtin_member')
  ON CONFLICT(user_id) DO NOTHING;

  INSERT INTO authorization_audit_events (
    id, occurred_at, request_id, principal_kind,
    actor_service_snapshot, action, resource_type, resource_id,
    target_user_id_snapshot, reason_code, operation_result, metadata_json
  ) VALUES (
    lower(hex(randomblob(16))), NEW.created_at, 'default-role:' || NEW.id, 'service',
    'database-trigger', 'workspace.default_role_assigned', 'user', NEW.id,
    NEW.id, 'default_role', 'applied',
    json_object(
      'before', json_object('roleId', NULL),
      'requested', json_object('roleId', 'role_builtin_member'),
      'after', json_object('roleId', 'role_builtin_member')
    )
  );
END;
