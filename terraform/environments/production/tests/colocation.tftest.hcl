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
  deployment_name             = "colocation-test"

  sandbox_provider   = "modal"
  modal_token_id     = "test-token"
  modal_token_secret = "test-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-api-secret"

  web_platform      = "vercel"
  docs_site_enabled = true
  vercel_team_id    = "test-team"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"
}

run "defaults_preserve_placement" {
  command = plan

  assert {
    condition     = module.web_app[0].serverless_region == "iad1"
    error_message = "The web project must keep its default function region."
  }

  assert {
    condition     = !contains(module.control_plane_worker.plain_text_binding_names, "SESSION_DO_LOCATION_HINT")
    error_message = "The session location hint binding must be absent by default."
  }
}

run "web_region_override_leaves_docs_unchanged" {
  command = plan

  variables {
    web_serverless_region = "fra1"
  }

  assert {
    condition     = module.web_app[0].serverless_region == "fra1"
    error_message = "The configured region must reach the web project."
  }

  assert {
    condition     = module.docs_site[0].serverless_region == "iad1"
    error_message = "The web region override must not affect the docs project."
  }

  assert {
    condition     = !contains(module.control_plane_worker.plain_text_binding_names, "SESSION_DO_LOCATION_HINT")
    error_message = "The web region must not enable a session location hint."
  }
}

run "session_hint_reaches_worker_binding" {
  command = plan

  variables {
    session_do_location_hint = "apac-ne"
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["SESSION_DO_LOCATION_HINT"] == "apac-ne"
    error_message = "The configured hint must reach the control-plane Worker."
  }

  assert {
    condition     = module.web_app[0].serverless_region == "iad1"
    error_message = "The session hint must not affect the web region."
  }
}

run "southeast_asia_pacific_hint_reaches_worker_binding" {
  command = plan

  variables {
    session_do_location_hint = "apac-se"
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["SESSION_DO_LOCATION_HINT"] == "apac-se"
    error_message = "The Southeast Asia-Pacific hint must reach the control-plane Worker."
  }
}

run "rejects_invalid_web_region" {
  command = plan

  variables {
    web_serverless_region = "invalid"
  }

  expect_failures = [var.web_serverless_region]
}

run "rejects_invalid_session_hint" {
  command = plan

  variables {
    session_do_location_hint = "invalid"
  }

  expect_failures = [var.session_do_location_hint]
}
