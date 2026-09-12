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
  anthropic_api_key           = "test-anthropic-key"
  token_encryption_key        = "test-token-key"
  repo_secrets_encryption_key = "test-repo-key"
  nextauth_secret             = "test-browser-auth-secret-with-32-characters"
  deployment_name             = "classifier-provider-test"

  modal_token_id     = "test-modal-token-id"
  modal_token_secret = "test-modal-token-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-modal-api-secret"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false

  # Both classifier-bearing bots are deployed so their bindings can be asserted.
  enable_slack_bot     = true
  slack_bot_token      = "xoxb-test"
  slack_signing_secret = "test-signing-secret"

  enable_linear_bot     = true
  linear_client_id      = "test-linear-client-id"
  linear_client_secret  = "test-linear-client-secret"
  linear_webhook_secret = "test-linear-webhook-secret"
  linear_api_key        = "test-linear-api-key"

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"
}

# The reviewer identity and credential must be configured as one unit.
run "reviewer_app_disabled_by_default" {
  command = plan
  assert {
    condition     = var.github_reviewer_username == "" && var.github_reviewer_app_id == ""
    error_message = "Existing deployments must not need a reviewer App."
  }
}

run "reviewer_app_coexists_with_main_app" {
  command = plan
  variables {
    enable_github_bot                    = true
    github_bot_username                  = "my-app[bot]"
    github_webhook_secret                = "test-webhook-secret"
    github_reviewer_username             = "my-reviewer[bot]"
    github_reviewer_app_id               = "2"
    github_reviewer_app_private_key      = "reviewer-private-key"
    github_reviewer_app_installation_id  = "22"
  }
  assert {
    condition = (
      contains(module.control_plane_worker.secret_binding_names, "GITHUB_REVIEWER_APP_PRIVATE_KEY") &&
      contains(module.control_plane_worker.secret_binding_names, "GITHUB_APP_PRIVATE_KEY") &&
      contains(module.github_bot_worker[0].plain_text_binding_names, "GITHUB_REVIEWER_USERNAME") &&
      !contains(module.github_bot_worker[0].secret_binding_names, "GITHUB_REVIEWER_APP_PRIVATE_KEY")
    )
    error_message = "The control plane must hold both App credentials; the bot needs only the reviewer login."
  }
}

run "reviewer_login_requires_credentials" {
  command = plan
  variables { github_reviewer_username = "my-reviewer[bot]" }
  expect_failures = [var.github_reviewer_username]
}

run "reviewer_credentials_require_login" {
  command = plan
  variables {
    github_reviewer_app_id              = "2"
    github_reviewer_app_private_key     = "reviewer-private-key"
    github_reviewer_app_installation_id = "22"
  }
  expect_failures = [var.github_reviewer_username]
}

run "reviewer_app_requires_private_key" {
  command = plan
  variables {
    github_reviewer_username            = "my-reviewer[bot]"
    github_reviewer_app_id              = "2"
    github_reviewer_app_installation_id = "22"
  }
  expect_failures = [var.github_reviewer_username]
}
