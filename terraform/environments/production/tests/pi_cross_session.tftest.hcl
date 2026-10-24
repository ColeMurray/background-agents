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
  deployment_name             = "pi-cross-session-test"
  web_platform                = "cloudflare"

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

run "cross_session_messaging_defaults_off" {
  command = plan

  assert {
    condition     = lookup(module.control_plane_worker.plain_text_bindings, "PI_CROSS_SESSION_MESSAGING_MODE", "off") == "off"
    error_message = "Cross-session messaging must fail closed by default."
  }
}

run "cross_session_messaging_reaches_the_worker" {
  command = plan

  variables {
    pi_cross_session_messaging_mode = "enabled"
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_CROSS_SESSION_MESSAGING_MODE"] == "enabled"
    error_message = "The cross-session messaging gate must reach the worker."
  }
}

run "cross_session_messaging_rejects_unknown_modes" {
  command = plan

  variables {
    pi_cross_session_messaging_mode = "maybe"
  }

  expect_failures = [var.pi_cross_session_messaging_mode]
}

run "external_actions_default_off" {
  command = plan

  assert {
    condition     = lookup(module.control_plane_worker.plain_text_bindings, "PI_EXTERNAL_ACTIONS_MODE", "off") == "off"
    error_message = "External publication must fail closed by default."
  }
}

run "external_actions_reaches_the_worker" {
  command = plan

  variables {
    pi_external_actions_mode = "enabled"
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_EXTERNAL_ACTIONS_MODE"] == "enabled"
    error_message = "The external publication gate must reach the worker."
  }
}

run "external_actions_rejects_unknown_modes" {
  command = plan

  variables {
    pi_external_actions_mode = "sometimes"
  }

  expect_failures = [var.pi_external_actions_mode]
}

run "browser_defaults_off" {
  command = plan

  assert {
    condition     = lookup(module.control_plane_worker.plain_text_bindings, "PI_BROWSER_MODE", "off") == "off"
    error_message = "The browser must fail closed by default."
  }

  assert {
    condition     = lookup(module.control_plane_worker.plain_text_bindings, "PI_BROWSER_ALLOWED_DOMAINS", "") == ""
    error_message = "The browser must reach no host until an operator reviews one."
  }
}

run "browser_reaches_the_worker" {
  command = plan

  variables {
    pi_browser_mode            = "enabled"
    pi_browser_allowed_domains = "example.com,*.docs.example.com"
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_BROWSER_MODE"] == "enabled"
    error_message = "The browser gate must reach the worker."
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_BROWSER_ALLOWED_DOMAINS"] == "example.com,*.docs.example.com"
    error_message = "The reviewed hosts must reach the worker."
  }
}

run "browser_rejects_unknown_modes" {
  command = plan

  variables {
    pi_browser_mode = "sometimes"
  }

  expect_failures = [var.pi_browser_mode]
}
