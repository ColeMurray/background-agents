mock_provider "cloudflare" {}
mock_provider "external" {}
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
  deployment_name             = "sandbox0-test"
  sandbox_provider            = "sandbox0"
  sandbox0_api_key            = "test-sandbox0-key"
  sandbox0_template_id        = "verified-template"
  web_platform                = "cloudflare"
  project_root                = "../../../"
  enable_github_bot           = false
  enable_slack_bot            = false
  enable_linear_bot           = false
  github_client_id            = "github-id"
  github_client_secret        = "github-secret"
  allowed_users               = "octocat"
}

run "sandbox0_uses_a_secret_binding" {
  command = plan
  assert {
    condition     = contains(module.control_plane_worker.secret_binding_names, "SANDBOX0_API_KEY")
    error_message = "Sandbox0 API keys must reach the control plane as secrets."
  }
}

run "requires_a_verified_template" {
  command = plan
  variables {
    sandbox0_template_id = ""
  }
  expect_failures = [var.sandbox0_template_id]
}

run "requires_an_api_key" {
  command = plan
  variables {
    sandbox0_api_key = ""
  }
  expect_failures = [var.sandbox0_api_key]
}
