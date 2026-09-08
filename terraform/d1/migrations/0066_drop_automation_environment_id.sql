-- The normalized automation_environments table has owned environment targets
-- since migration 0037; remove its unused scalar predecessor.
ALTER TABLE automations DROP COLUMN environment_id;
