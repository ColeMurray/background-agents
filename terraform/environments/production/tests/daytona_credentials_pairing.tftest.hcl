# Daytona credentials are kept after a deployment switches to another sandbox
# backend, so the control plane can still finalize and reclaim what Daytona
# created. That reclamation needs the URL as much as the key: the adapter
# factory refuses to build a client without both. A key retained without a URL
# is therefore not a lesser configuration, it is a broken one.

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
  deployment_name             = "daytona-credentials-pairing-test"

  # The deployment has moved off Daytona; the credentials outlive the switch.
  sandbox_provider   = "modal"
  modal_token_id     = "test-modal-token-id"
  modal_token_secret = "test-modal-token-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-modal-api-secret"
  daytona_api_key    = "test-daytona-key"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"
}

run "retained_daytona_credentials_stay_bound_after_a_provider_switch" {
  command = plan

  variables {
    daytona_api_url = "https://daytona.example/api"
  }

  assert {
    condition = (
      contains(module.control_plane_worker.plain_text_binding_names, "DAYTONA_API_URL") &&
      contains(module.control_plane_worker.secret_binding_names, "DAYTONA_API_KEY")
    )
    error_message = "Retained Daytona credentials must stay bound so existing sandboxes remain reclaimable."
  }

  assert {
    condition     = length(module.daytona_infra) == 0
    error_message = "A deployment that switched away from Daytona must not build a Daytona snapshot."
  }
}

run "rejects_a_retained_daytona_key_without_a_url" {
  command = plan

  variables {
    daytona_api_url = ""
  }

  expect_failures = [var.daytona_api_url]
}
