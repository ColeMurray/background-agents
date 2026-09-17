-- Agent harness discriminator. A session runs on exactly one harness, fixed
-- at create; automations carry the harness for the sessions they create.
-- 'opencode' is the built-in harness every existing row ran on.
ALTER TABLE sessions ADD COLUMN harness TEXT NOT NULL DEFAULT 'opencode'
  CHECK (harness IN ('opencode', 'claude'));
ALTER TABLE automations ADD COLUMN harness TEXT NOT NULL DEFAULT 'opencode'
  CHECK (harness IN ('opencode', 'claude'));
