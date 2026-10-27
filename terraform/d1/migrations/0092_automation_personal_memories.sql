-- Automation runs include their executor's personal memories only after that
-- executor opts in. Changing the executor clears the opt-in.
ALTER TABLE automations ADD COLUMN include_personal_memories INTEGER NOT NULL DEFAULT 0
  CHECK (include_personal_memories IN (0, 1));
