/** Populated pre-0087 graph seeded into the Node SQLite upgrade test (codex-migration.test.ts). */
export const CODEX_MIGRATION_SEED = [
  "INSERT INTO users (id, created_at, updated_at) VALUES ('owner', 1, 1)",
  "INSERT INTO teams (id, slug, name, created_at, updated_at) VALUES ('team', 'team', 'Team', 1, 1)",
  "INSERT INTO sessions (id, user_id, harness, owner_team_id, visibility, created_at, updated_at) VALUES ('parent', 'owner', 'claude', 'team', 'team', 1, 1)",
  "INSERT INTO sessions (id, harness, parent_session_id, created_at, updated_at) VALUES ('child', 'opencode', 'parent', 1, 1)",
  "INSERT INTO session_repositories (session_id, position, repo_owner, repo_name, base_branch) VALUES ('parent', 0, 'org', 'repo', 'main')",
  "INSERT INTO child_admission_leases (lease_token, parent_session_id, child_session_id, expires_at) VALUES ('lease', 'parent', 'child', 99)",
  "INSERT INTO session_collaborators (session_id, user_id, added_by, created_at) VALUES ('parent', 'owner', 'owner', 1)",
  "INSERT INTO model_provider_accounts (id, provider, display_name, status, created_at, updated_at) VALUES ('account', 'openai', 'Connected', 'active', 1, 1)",
  "INSERT INTO session_model_provider_auth (session_id, provider, auth_mode, provider_account_id, selection_source, created_at) VALUES ('parent', 'openai', 'provider_account', 'account', 'explicit', 1) ON CONFLICT(session_id, provider) DO UPDATE SET auth_mode='provider_account', provider_account_id='account', selection_source='explicit'",
  "INSERT INTO automations (id, name, instructions, model, created_by, harness, owner_team_id, created_at, updated_at) VALUES ('automation', 'Task', 'Do work', 'anthropic/claude-sonnet-4-6', 'owner', 'claude', 'team', 1, 1)",
  "INSERT INTO automation_model_provider_auth (automation_id, provider, auth_mode, provider_account_id, created_at, updated_at) VALUES ('automation', 'openai', 'provider_account', 'account', 1, 1)",
  "INSERT INTO automation_environments (automation_id, environment_id, created_at, updated_at) VALUES ('automation', 'env-snapshot', 1, 1)",
  "INSERT INTO automation_runs (id, automation_id, session_id, status, scheduled_at, created_at, invocation_id) VALUES ('run', 'automation', 'child', 'completed', 1, 1, 'invocation-snapshot')",
];

export const CODEX_MIGRATION_TABLES = [
  "sessions",
  "automations",
  "session_repositories",
  "child_admission_leases",
  "session_collaborators",
  "session_model_provider_auth",
  "automation_model_provider_auth",
  "automation_environments",
  "automation_runs",
];
export const CODEX_MIGRATION_SCHEMA_OBJECTS =
  "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL ORDER BY type, name";
