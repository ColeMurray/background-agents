CREATE TABLE workspace_admission_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  rules_json TEXT NOT NULL,
  updated_at INTEGER,
  updated_by_user_id_snapshot TEXT,
  writes_frozen INTEGER NOT NULL DEFAULT 1 CHECK (writes_frozen IN (0, 1))
);

-- Operators unfreeze only after all deployment-only admission runtimes have drained.
INSERT INTO workspace_admission_policy (id, schema_version, revision, rules_json, writes_frozen)
VALUES (1, 1, 0, '{"allowedGitHubUsers":[],"allowedEmails":[],"allowedEmailDomains":[],"allowedGitHubOrganizations":[]}', 1);
