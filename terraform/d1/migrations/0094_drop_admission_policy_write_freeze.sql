-- Managed sign-in rules are editable whenever the deployment allows it, so the
-- operator write freeze that 0093 seeded is gone. The column is unindexed and
-- its CHECK belongs to it alone, so the drop is clean.
--
-- 0093 (already applied) added this column; never edit it — the drop must be its
-- own migration.
ALTER TABLE workspace_admission_policy DROP COLUMN writes_frozen;
