ALTER TABLE authorization_audit_events
ADD COLUMN operation_result TEXT NOT NULL DEFAULT 'applied'
CHECK (operation_result IN ('applied', 'no_op', 'denied', 'rejected'));

ALTER TABLE authorization_audit_events
ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'
CHECK (json_valid(metadata_json));

DROP TRIGGER IF EXISTS assign_default_role_after_user_insert;

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
