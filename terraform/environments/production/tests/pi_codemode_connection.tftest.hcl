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
  deployment_name             = "pi-codemode-connection-test"
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

run "codemode_defaults_off_without_external_binding" {
  command = plan

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_CODE_MODE"] == "off"
    error_message = "Code Mode admission must default off."
  }

  assert {
    condition     = !contains(module.control_plane_worker.binding_names, "CODEMODE_SANDBOX")
    error_message = "The control plane must not bind the sandbox before its Wrangler deployment is verified."
  }
}

run "verified_sandbox_binding_survives_feature_rollback" {
  command = plan

  variables {
    pi_codemode_sandbox_deployment_verified = true
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_CODE_MODE"] == "off"
    error_message = "Adding the recovery binding must not enable new Code Mode sessions."
  }

  assert {
    condition     = contains(module.control_plane_worker.binding_names, "CODEMODE_SANDBOX")
    error_message = "Rollback must retain the external binding for already-latched sessions."
  }
}

run "paid_mode_connects_to_the_external_sandbox" {
  command = plan

  variables {
    pi_codemode_mode                        = "paid"
    pi_codemode_sandbox_deployment_verified = true
    pi_codemode_paid_canary_verified        = true
    pi_codemode_sandbox_deployed_version    = "version-1"
    pi_codemode_paid_canary_version         = "version-1"
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_CODE_MODE"] == "enabled"
    error_message = "The explicit paid-plan mode must reach the control plane."
  }

  assert {
    condition = (
      module.control_plane_worker.external_durable_object_bindings["CODEMODE_SANDBOX"].class_name == "CodemodeSandbox" &&
      module.control_plane_worker.external_durable_object_bindings["CODEMODE_SANDBOX"].script_name == "open-inspect-pi-codemode-sandbox-${var.deployment_name}"
    )
    error_message = "Code Mode must use the separately deployed sandbox Durable Object."
  }
}

run "paid_mode_requires_canary_for_the_deployed_version" {
  command = plan

  variables {
    pi_codemode_mode                        = "paid"
    pi_codemode_sandbox_deployment_verified = true
    pi_codemode_paid_canary_verified        = true
    pi_codemode_sandbox_deployed_version    = "version-2"
    pi_codemode_paid_canary_version         = "version-1"
  }

  expect_failures = [terraform_data.pi_codemode_paid_ready_gate]
}

run "paid_mode_requires_the_verified_wrangler_deployment" {
  command = plan

  variables {
    pi_codemode_mode = "paid"
  }

  expect_failures = [terraform_data.pi_codemode_paid_ready_gate]
}

run "paid_mode_requires_a_live_paid_account_canary" {
  command = plan

  variables {
    pi_codemode_mode                        = "paid"
    pi_codemode_sandbox_deployment_verified = true
  }

  expect_failures = [terraform_data.pi_codemode_paid_ready_gate]
}

run "unknown_mode_is_rejected" {
  command = plan

  variables {
    pi_codemode_mode = "enabled"
  }

  expect_failures = [var.pi_codemode_mode]
}
