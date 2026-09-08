-- Automation environment targets (multi-repo sessions design §13.3, extended
-- to fan-out): an automation fans out over BOTH its repository selection and
-- its environment selection — one child run per target. An environment child
-- launches one session opening that environment's full workspace.
--
-- Supersedes the scalar automations.environment_id reserved in 0033. That
-- column stays in place (SQLite column drops need a table rebuild) but is
-- never read or written.

CREATE TABLE automation_environments (
  automation_id  TEXT    NOT NULL,
  environment_id TEXT    NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  PRIMARY KEY (automation_id, environment_id),
  FOREIGN KEY (automation_id) REFERENCES automations(id)
);

CREATE INDEX idx_automation_environments_environment
  ON automation_environments (environment_id);

-- Firing-time environment snapshot on the child run (twin of the repo_*
-- snapshot columns): history and launch never depend on the live selection.
ALTER TABLE automation_runs ADD COLUMN environment_id TEXT;

-- At most one run per environment per invocation (twin of
-- idx_runs_invocation_repo, which carries the same guarantee per repository).
CREATE UNIQUE INDEX idx_runs_invocation_environment
  ON automation_runs (invocation_id, environment_id)
  WHERE environment_id IS NOT NULL;
