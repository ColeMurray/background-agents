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
  deployment_name             = "worker-bundles-test"

  modal_token_id     = "test-modal-token-id"
  modal_token_secret = "test-modal-token-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-modal-api-secret"

  web_platform = "cloudflare"
  project_root = "../../../"

  # All three bots are deployed so every build resource can be asserted.
  enable_github_bot     = true
  github_webhook_secret = "test-github-webhook-secret"
  github_bot_username   = "test-bot[bot]"

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

# Local applies keep building the bundles from Terraform, exactly as before
# the switch existed.
run "builds_in_terraform_by_default" {
  command = plan

  assert {
    condition = (
      length(null_resource.control_plane_build) == 1 &&
      length(null_resource.slack_bot_build) == 1 &&
      length(null_resource.github_bot_build) == 1 &&
      length(null_resource.linear_bot_build) == 1
    )
    error_message = "With build_workers_in_terraform at its default, every enabled Worker bundle must still be built during apply."
  }
}

# CI builds the bundles before plan, so Terraform must not rebuild them
# mid-apply and deploy different bytes than it planned. The web app's
# OpenNext build is per deployment and stays in Terraform.
run "prebuilt_bundles_skip_terraform_builds" {
  command = plan

  variables {
    build_workers_in_terraform = false
  }

  assert {
    condition = (
      length(null_resource.control_plane_build) == 0 &&
      length(null_resource.slack_bot_build) == 0 &&
      length(null_resource.github_bot_build) == 0 &&
      length(null_resource.linear_bot_build) == 0
    )
    error_message = "build_workers_in_terraform = false must skip every Worker bundle build."
  }

  assert {
    condition     = length(null_resource.web_app_cloudflare_build) == 1
    error_message = "The Cloudflare web build is not covered by build_workers_in_terraform and must still run."
  }
}

# A typo'd key would silently skip the check for the bundle it meant.
run "rejects_an_unknown_bundle_key" {
  command = plan

  variables {
    worker_bundle_sha256 = {
      "control-plne" = "0000000000000000000000000000000000000000000000000000000000000000"
    }
  }

  expect_failures = [var.worker_bundle_sha256]
}

run "rejects_a_malformed_checksum" {
  command = plan

  variables {
    worker_bundle_sha256 = {
      "control-plane" = "not-a-sha256"
    }
  }

  expect_failures = [var.worker_bundle_sha256]
}
