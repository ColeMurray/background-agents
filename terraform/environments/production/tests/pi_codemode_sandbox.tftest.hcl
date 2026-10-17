mock_provider "cloudflare" {}
mock_provider "external" {
  mock_data "external" {
    defaults = {
      result = { hash = "test-source-hash" }
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
  anthropic_api_key           = "test-anthropic-key"
  token_encryption_key        = "test-token-key"
  repo_secrets_encryption_key = "test-repo-key"
  nextauth_secret             = "test-browser-auth-secret-with-32-characters"
  deployment_name             = "pi-codemode-test"

  sandbox_provider   = "modal"
  modal_token_id     = "test-token"
  modal_token_secret = "test-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-api-secret"

  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"
}

run "sandbox_is_private_and_credential_free" {
  command = plan

  assert {
    condition     = module.pi_codemode_sandbox_worker.worker_url == null
    error_message = "The Code Mode sandbox must not have a workers.dev endpoint."
  }

  assert {
    condition     = length(module.pi_codemode_sandbox_worker.secret_binding_names) == 0 && length(module.pi_codemode_sandbox_worker.plain_text_binding_names) == 0
    error_message = "The Code Mode sandbox must not receive secrets or configuration values."
  }

  assert {
    condition     = length(module.pi_codemode_sandbox_worker.binding_names) == 0
    error_message = "The sandbox Worker must not expose a runtime binding to its own class."
  }

}
