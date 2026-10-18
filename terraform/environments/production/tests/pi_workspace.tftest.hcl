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
  deployment_name             = "pi-workspace-test"

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

run "workspace_defaults_off" {
  command = plan

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_WORKSPACE_MODE"] == "off"
    error_message = "The Pi workspace must fail closed by default."
  }
}

run "workspace_read_only_reaches_the_worker" {
  command = plan

  variables {
    pi_workspace_mode = "read_only"
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_WORKSPACE_MODE"] == "read_only"
    error_message = "The read-only Pi workspace mode must reach the control-plane Worker."
  }
}

run "workspace_rejects_unknown_modes" {
  command = plan

  variables {
    pi_workspace_mode = "writable"
  }

  expect_failures = [var.pi_workspace_mode]
}
