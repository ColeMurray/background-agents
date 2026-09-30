# Agent World is an optional external caller. Its sig1 key must exist only when
# the deployment opts in, so a default deployment rejects every agent-world
# request for lack of a verification key.

mock_provider "cloudflare" {}
mock_provider "external" {
  mock_data "external" {
    defaults = {
      result = {
        hash = "test-source-hash"
      }
    }
  }
}
mock_provider "local" {}
mock_provider "null" {}
mock_provider "random" {}
mock_provider "vercel" {}

variables {
  cloudflare_api_token        = "test-cloudflare-token"
  cloudflare_account_id       = "test-account"
  cloudflare_worker_subdomain = "test-account"
  github_app_id               = "1"
  github_app_private_key      = "test-private-key"
  github_app_installation_id  = "1"
  token_encryption_key        = "test-token-key"
  repo_secrets_encryption_key = "test-repo-key"
  nextauth_secret             = "test-browser-auth-secret-with-32-characters"
  deployment_name             = "agent-world-test"

  modal_token_id     = "test-modal-token-id"
  modal_token_secret = "test-modal-token-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-modal-api-secret"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"

}

run "agent_world_is_off_by_default" {
  command = plan

  assert {
    condition     = !contains(module.control_plane_worker.secret_binding_names, "SERVICE_AUTH_SECRET_AGENT_WORLD")
    error_message = "The control plane must not bind an agent-world key unless enabled."
  }

  assert {
    condition     = length(random_password.service_auth_secret_agent_world) == 0
    error_message = "No agent-world key may be generated unless enabled."
  }
}

run "enabling_agent_world_binds_its_own_key" {
  command = plan

  variables {
    enable_agent_world_service = true
  }

  assert {
    condition     = contains(module.control_plane_worker.secret_binding_names, "SERVICE_AUTH_SECRET_AGENT_WORLD")
    error_message = "Enabling Agent World must bind its verification key on the control plane."
  }

  assert {
    condition     = length(random_password.service_auth_secret_agent_world) == 1
    error_message = "Enabling Agent World must generate exactly one dedicated key."
  }
}
