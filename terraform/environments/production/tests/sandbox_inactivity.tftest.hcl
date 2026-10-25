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
  deployment_name             = "sandbox-inactivity-test"

  sandbox_provider   = "modal"
  modal_token_id     = "test-token"
  modal_token_secret = "test-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-api-secret"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"
}

run "defaults_reach_worker_bindings" {
  command = plan

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["SANDBOX_INACTIVITY_TIMEOUT_MS"] == "600000"
    error_message = "The regular inactivity binding must keep its default."
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS"] == "120000"
    error_message = "The unattended inactivity binding must use its default."
  }
}

run "minimum_unattended_timeout_reaches_worker_binding" {
  command = plan

  variables {
    sandbox_unattended_inactivity_timeout_ms = 60000
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["SANDBOX_UNATTENDED_INACTIVITY_TIMEOUT_MS"] == "60000"
    error_message = "The minimum unattended timeout must reach the Worker binding."
  }
}

run "rejects_unattended_timeout_below_minimum" {
  command = plan

  variables {
    sandbox_unattended_inactivity_timeout_ms = 59999
  }

  expect_failures = [var.sandbox_unattended_inactivity_timeout_ms]
}

run "rejects_fractional_unattended_timeout" {
  command = plan

  variables {
    sandbox_unattended_inactivity_timeout_ms = 60000.5
  }

  expect_failures = [var.sandbox_unattended_inactivity_timeout_ms]
}

run "rejects_unsafe_integer_unattended_timeout" {
  command = plan

  variables {
    sandbox_unattended_inactivity_timeout_ms = 9007199254740992
  }

  expect_failures = [var.sandbox_unattended_inactivity_timeout_ms]
}
