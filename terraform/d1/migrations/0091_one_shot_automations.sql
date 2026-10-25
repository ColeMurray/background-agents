-- A schedule uses either a recurring cron expression or a single absolute instant.
ALTER TABLE automations ADD COLUMN schedule_once_at INTEGER;
