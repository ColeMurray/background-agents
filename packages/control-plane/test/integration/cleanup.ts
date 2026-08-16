import { env } from "cloudflare:test";

/**
 * Clears all D1 tables. Integration tests share a single D1 instance, so call
 * this in beforeEach/afterEach to isolate state between tests.
 */
export async function cleanD1Tables(): Promise<void> {
  await env.DB.exec(
    "DELETE FROM auth_verifications; DELETE FROM auth_sessions; DELETE FROM automation_slack_channels; DELETE FROM automation_runs; DELETE FROM automation_invocations; DELETE FROM automation_repositories; DELETE FROM automation_environments; DELETE FROM automations; DELETE FROM session_read_states; DELETE FROM session_pull_requests; DELETE FROM session_repositories; DELETE FROM child_admission_leases; DELETE FROM session_skill_revisions; DELETE FROM session_skill_manifests; DELETE FROM sessions; DELETE FROM skill_profile_items; DELETE FROM skill_profiles; DELETE FROM skill_assignments; DELETE FROM skill_revision_files; DELETE FROM skill_revisions; DELETE FROM skills; UPDATE skills_catalog_state SET generation = 0 WHERE singleton = 1; DELETE FROM user_scm_tokens; DELETE FROM repo_metadata; DELETE FROM repo_secrets; DELETE FROM global_secrets; DELETE FROM commit_signing_configuration; DELETE FROM integration_settings; DELETE FROM integration_repo_settings; DELETE FROM integration_environment_settings; DELETE FROM model_preferences; DELETE FROM mcp_servers; DELETE FROM user_identities; DELETE FROM users; DELETE FROM image_builds; DELETE FROM environment_secrets; DELETE FROM environment_repositories; DELETE FROM environments;"
  );
}
