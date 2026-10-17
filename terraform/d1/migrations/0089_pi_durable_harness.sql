-- Extend the constrained harness discriminator without rebuilding either
-- parent table, which would cascade-delete linked rows under D1 foreign keys.
ALTER TABLE sessions ADD COLUMN harness_v2 TEXT NOT NULL DEFAULT 'opencode'
  CHECK (harness_v2 IN ('opencode', 'claude', 'codex', 'pi'));
UPDATE sessions SET harness_v2 = harness;
ALTER TABLE sessions DROP COLUMN harness;
ALTER TABLE sessions RENAME COLUMN harness_v2 TO harness;

ALTER TABLE automations ADD COLUMN harness_v2 TEXT NOT NULL DEFAULT 'opencode'
  CHECK (harness_v2 IN ('opencode', 'claude', 'codex', 'pi'));
UPDATE automations SET harness_v2 = harness;
ALTER TABLE automations DROP COLUMN harness;
ALTER TABLE automations RENAME COLUMN harness_v2 TO harness;
