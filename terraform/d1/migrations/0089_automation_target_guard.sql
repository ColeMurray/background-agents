-- D1 batches cannot branch on earlier statement results. A named CHECK lets the
-- final target assertion abort the entire mutation transaction on a stale edit.
-- Assertion rows are inserted and deleted in the same batch, never retained.
CREATE TABLE automation_target_guards (
  automation_id TEXT PRIMARY KEY REFERENCES automations(id),
  consistent INTEGER NOT NULL CONSTRAINT automation_target_consistent CHECK (consistent = 1)
);
