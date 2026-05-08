# =============================================================================
# Custom domain override tests
# =============================================================================
# Verifies that web_app_domain and control_plane_domain correctly override the
# default workers.dev URLs in cross-service config (and that empty values
# preserve the existing fallback behavior).
#
# These tests run in plan mode with mocked Cloudflare and Vercel providers, so
# they require no real credentials and create no infrastructure. Run locally
# from this directory with:
#
#   terraform init -backend=false
#   terraform test

mock_provider "cloudflare" {}
mock_provider "vercel" {}

# Defaults applied to every run; individual runs can override.
variables {
  cloudflare_api_token        = "test-cf-token"
  cloudflare_account_id       = "test-account-id"
  cloudflare_worker_subdomain = "test-subdomain"

  modal_token_id     = "test-modal-id"
  modal_token_secret = "test-modal-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-modal-api-secret"

  github_client_id           = "test-client-id"
  github_client_secret       = "test-client-secret"
  github_app_id              = "1"
  github_app_installation_id = "1"
  github_app_private_key     = "test-private-key"

  anthropic_api_key           = "test-anthropic-key"
  token_encryption_key        = "test-token-key"
  repo_secrets_encryption_key = "test-repo-key"
  internal_callback_secret    = "test-internal-secret"
  nextauth_secret             = "test-nextauth-secret"

  deployment_name = "test"
  web_platform    = "cloudflare"

  # Disable bot integrations so their validation rules don't require
  # additional secrets we don't care about for these assertions.
  enable_slack_bot  = false
  enable_github_bot = false

  # Skip the access-control safety check.
  unsafe_allow_all_users = true
  allowed_users          = ""
  allowed_email_domains  = ""
}

run "defaults_use_workers_dev" {
  command = plan

  variables {
    web_app_domain       = ""
    control_plane_domain = ""
  }

  assert {
    condition     = local.web_app_url == "https://open-inspect-web-test.test-subdomain.workers.dev"
    error_message = "Empty web_app_domain must fall back to the workers.dev URL."
  }

  assert {
    condition     = local.control_plane_host == "open-inspect-control-plane-test.test-subdomain.workers.dev"
    error_message = "Empty control_plane_domain must fall back to the workers.dev host."
  }

  assert {
    condition     = local.control_plane_url == "https://open-inspect-control-plane-test.test-subdomain.workers.dev"
    error_message = "control_plane_url must derive https:// from control_plane_host."
  }

  assert {
    condition     = local.ws_url == "wss://open-inspect-control-plane-test.test-subdomain.workers.dev"
    error_message = "ws_url must derive wss:// from control_plane_host."
  }
}

run "web_app_domain_overrides_only_web" {
  command = plan

  variables {
    web_app_domain       = "app.example.com"
    control_plane_domain = ""
  }

  assert {
    condition     = local.web_app_url == "https://app.example.com"
    error_message = "web_app_url must use the custom web_app_domain when set."
  }

  assert {
    condition     = local.control_plane_host == "open-inspect-control-plane-test.test-subdomain.workers.dev"
    error_message = "control_plane_host must remain on workers.dev when only web_app_domain is set."
  }

  assert {
    condition     = local.ws_url == "wss://open-inspect-control-plane-test.test-subdomain.workers.dev"
    error_message = "ws_url must remain on workers.dev when only web_app_domain is set."
  }
}

run "control_plane_domain_overrides_only_control_plane" {
  command = plan

  variables {
    web_app_domain       = ""
    control_plane_domain = "api.example.com"
  }

  assert {
    condition     = local.web_app_url == "https://open-inspect-web-test.test-subdomain.workers.dev"
    error_message = "web_app_url must remain on workers.dev when only control_plane_domain is set."
  }

  assert {
    condition     = local.control_plane_host == "api.example.com"
    error_message = "control_plane_host must use the custom control_plane_domain when set."
  }

  assert {
    condition     = local.control_plane_url == "https://api.example.com"
    error_message = "control_plane_url must derive https:// from the custom control_plane_domain."
  }

  assert {
    condition     = local.ws_url == "wss://api.example.com"
    error_message = "ws_url must derive wss:// from the custom control_plane_domain."
  }
}

run "both_domains_set" {
  command = plan

  variables {
    web_app_domain       = "app.example.com"
    control_plane_domain = "api.example.com"
  }

  assert {
    condition     = local.web_app_url == "https://app.example.com"
    error_message = "web_app_url must use the custom web_app_domain when both are set."
  }

  assert {
    condition     = local.control_plane_host == "api.example.com"
    error_message = "control_plane_host must use the custom control_plane_domain when both are set."
  }

  assert {
    condition     = local.control_plane_url == "https://api.example.com"
    error_message = "control_plane_url must derive https:// from the custom control_plane_domain."
  }

  assert {
    condition     = local.ws_url == "wss://api.example.com"
    error_message = "ws_url must derive wss:// from the custom control_plane_domain."
  }
}

run "vercel_platform_rejects_web_app_domain" {
  command = plan

  variables {
    web_platform   = "vercel"
    web_app_domain = "app.example.com"
  }

  expect_failures = [var.web_app_domain]
}

run "vercel_platform_with_empty_web_app_domain_is_allowed" {
  command = plan

  variables {
    web_platform   = "vercel"
    web_app_domain = ""
  }

  assert {
    condition     = local.web_app_url == "https://open-inspect-test.vercel.app"
    error_message = "Empty web_app_domain on Vercel must produce the default vercel.app URL — the validation should only fire when a value is supplied."
  }
}
