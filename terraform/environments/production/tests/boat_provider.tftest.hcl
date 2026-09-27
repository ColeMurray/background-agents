mock_provider "cloudflare" {}
mock_provider "external" {
  mock_data "external" {
    defaults = {
      result = {
        hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
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
  deployment_name             = "boat-provider-test"

  sandbox_provider           = "boat"
  boat_api_key               = "test-boat-key"
  boat_sandbox_access_secret = "test-stable-access-secret-32-characters"
  boat_template_prefix       = "openinspect-test"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"
}

run "managed_snapshot_is_built_and_bound_before_the_worker" {
  command = plan

  assert {
    condition     = length(module.boat_infra) == 1
    error_message = "An active Boat deployment without a manual pin must build a template."
  }

  assert {
    condition     = module.boat_infra[0].snapshot_name == "openinspect-test-aaaaaaaaaaaaaaaa"
    error_message = "The Boat template name must be immutable and source-hash qualified."
  }

  assert {
    condition = (
      contains(module.control_plane_worker.plain_text_binding_names, "BOAT_BASE_SNAPSHOT") &&
      contains(module.control_plane_worker.plain_text_binding_names, "BOAT_API_URL") &&
      contains(module.control_plane_worker.secret_binding_names, "BOAT_API_KEY") &&
      contains(module.control_plane_worker.secret_binding_names, "BOAT_SANDBOX_ACCESS_SECRET")
    )
    error_message = "Boat runtime configuration must reach the control-plane Worker."
  }
}

run "manual_snapshot_pin_skips_the_managed_build" {
  command = plan

  variables {
    boat_base_snapshot = "operator-verified-snapshot"
  }

  assert {
    condition     = length(module.boat_infra) == 0
    error_message = "A manual Boat snapshot pin must skip managed template construction."
  }

  assert {
    condition     = output.boat_base_snapshot == "operator-verified-snapshot"
    error_message = "The manual Boat snapshot pin must be bound verbatim."
  }
}

run "rejects_missing_runtime_credentials" {
  command = plan

  variables {
    boat_api_key = ""
  }

  expect_failures = [var.boat_api_key]
}

run "rejects_short_access_secret" {
  command = plan

  variables {
    boat_sandbox_access_secret = "short"
  }

  expect_failures = [var.boat_sandbox_access_secret]
}

run "rejects_undocumented_xlarge_type" {
  command = plan

  variables {
    boat_sandbox_type = "xlarge"
  }

  expect_failures = [var.boat_sandbox_type]
}

run "retains_the_boat_runtime_key_after_switching_providers" {
  command = plan

  variables {
    sandbox_provider   = "modal"
    modal_token_id     = "modal-id"
    modal_token_secret = "modal-secret"
    modal_workspace    = "workspace"
    modal_api_secret   = "modal-api-secret"
  }

  assert {
    condition     = contains(module.control_plane_worker.secret_binding_names, "BOAT_API_KEY")
    error_message = "Boat credentials must remain available during the provider rollback window."
  }

  assert {
    condition     = length(module.boat_infra) == 0
    error_message = "Switching away from Boat must not build another Boat template."
  }
}

run "rejects_plaintext_non_loopback_api_urls" {
  command = plan

  variables {
    boat_api_url = "http://boat.example/api/v1"
  }

  expect_failures = [var.boat_api_url]
}

run "rejects_shell_hostile_snapshot_names" {
  command = plan

  variables {
    boat_base_snapshot = "bad'name"
  }

  expect_failures = [var.boat_base_snapshot]
}
