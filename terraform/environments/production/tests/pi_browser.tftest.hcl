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
  deployment_name             = "pi-browser-test"
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

run "browser_is_off_by_default" {
  command = plan

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_BROWSER_MODE"] == "off"
    error_message = "The browser capability must fail closed by default."
  }
}

run "browser_stages_no_binding_by_default" {
  command = plan

  assert {
    condition     = length(module.control_plane_worker.browser_binding_names) == 0
    error_message = "A deployment without the browser capability must stage no browser binding."
  }
}

run "browser_stages_its_binding_when_enabled" {
  command = plan

  variables {
    pi_browser_mode = "enabled"
  }

  assert {
    condition     = contains(module.control_plane_worker.browser_binding_names, "BROWSER")
    error_message = "The browser capability must stage the browser binding it needs."
  }
}

run "browser_stages_its_binding_in_read_only_mode" {
  command = plan

  variables {
    pi_browser_mode = "read_only"
  }

  assert {
    condition     = contains(module.control_plane_worker.browser_binding_names, "BROWSER")
    error_message = "A read-only browser still needs the browser binding."
  }
}

run "browser_rejects_unknown_modes" {
  command = plan

  variables {
    pi_browser_mode = "maybe"
  }

  expect_failures = [
    var.pi_browser_mode,
  ]
}
