# The export service is off by default. Enabling it pins one actor and the user
# that actor belongs to; the control plane refuses export unless the secret and
# both pins are bound, and the secret is replaced whenever a pin changes.

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
  deployment_name             = "export-service-test"

  sandbox_provider   = "modal"
  modal_token_id     = "test-modal-token-id"
  modal_token_secret = "test-modal-token-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-modal-api-secret"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"
}

run "export_service_is_off_by_default" {
  command = plan

  assert {
    condition = (
      length(random_password.service_auth_secret_export) == 0 &&
      !contains(module.control_plane_worker.secret_binding_names, "SERVICE_AUTH_SECRET_EXPORT")
    )
    error_message = "The export service must stay off until an operator pins an actor."
  }
}

run "binds_the_export_credential_as_one_unit" {
  command = plan

  variables {
    export_service_actor   = "github:12345"
    export_service_user_id = "0123456789abcdef0123456789abcdef"
  }

  assert {
    condition = alltrue([
      for name in ["SERVICE_AUTH_SECRET_EXPORT", "SERVICE_AUTH_EXPORT_ACTOR", "SERVICE_AUTH_EXPORT_USER_ID"] :
      contains(module.control_plane_worker.secret_binding_names, name)
    ])
    error_message = "The export secret and both pins must be bound together."
  }

  assert {
    condition = (
      random_password.service_auth_secret_export[0].keepers["actor"] == "github:12345" &&
      random_password.service_auth_secret_export[0].keepers["user_id"] == "0123456789abcdef0123456789abcdef"
    )
    error_message = "Changing either pin must replace the export secret."
  }
}

run "rejects_an_actor_without_a_user_id" {
  command = plan

  variables {
    export_service_actor = "github:12345"
  }

  expect_failures = [var.export_service_user_id]
}

run "rejects_a_user_id_without_an_actor" {
  command = plan

  variables {
    export_service_user_id = "0123456789abcdef0123456789abcdef"
  }

  expect_failures = [var.export_service_user_id]
}
