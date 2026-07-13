import { env } from "cloudflare:test";

/**
 * Clears all D1 tables. Integration tests share a single D1 instance, so call
 * this in beforeEach/afterEach to isolate state between tests.
 */
export async function cleanD1Tables(): Promise<void> {
  await env.DB.exec(
    "DELETE FROM automation_slack_channels; DELETE FROM automation_runs; DELETE FROM automation_invocations; DELETE FROM automation_repositories; DELETE FROM automation_environments; DELETE FROM automations; DELETE FROM session_pull_requests; DELETE FROM session_repositories; DELETE FROM sessions; DELETE FROM user_scm_tokens; DELETE FROM repo_metadata; DELETE FROM repo_secrets; DELETE FROM global_secrets; DELETE FROM integration_settings; DELETE FROM integration_repo_settings; DELETE FROM integration_environment_settings; DELETE FROM mcp_servers; DELETE FROM user_identities; DELETE FROM users; DELETE FROM image_builds; DELETE FROM environment_secrets; DELETE FROM environment_repositories; DELETE FROM environments;"
  );
}
