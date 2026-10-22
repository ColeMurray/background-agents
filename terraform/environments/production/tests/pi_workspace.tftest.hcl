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
  deployment_name             = "pi-workspace-test"

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

run "workspace_defaults_off" {
  command = plan

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_SCRATCH_WORKSPACE_MODE"] == "off"
    error_message = "The Pi workspace must fail closed by default."
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_REPOSITORY_EDITING_MODE"] == "off"
    error_message = "Pi repository editing must fail closed independently by default."
  }

  assert {
    condition     = !var.pi_computer_preview_acknowledged
    error_message = "Cloudflare Computer preview risk acknowledgement must default off."
  }
}

run "pi_binding_survives_admission_rollback" {
  command = plan

  variables {
    pi_durable_enabled         = false
    pi_durable_binding_enabled = true
  }

  assert {
    condition     = contains(module.control_plane_worker.binding_names, "PI_SESSION")
    error_message = "PI_SESSION must remain installed when new Pi admission is rolled back."
  }
}

run "sandbox_execution_defaults_off" {
  command = plan

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_SANDBOX_EXECUTION_MODE"] == "off"
    error_message = "Pi sandbox execution must fail closed by default."
  }
}

run "sandbox_execution_gate_reaches_the_worker" {
  command = plan

  variables {
    pi_sandbox_execution_mode = "enabled"
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_SANDBOX_EXECUTION_MODE"] == "enabled"
    error_message = "The Pi sandbox execution gate must reach the control-plane Worker."
  }
}

run "sandbox_execution_rejects_boolean_era_values" {
  command = plan

  variables {
    pi_sandbox_execution_mode = "true"
  }

  expect_failures = [var.pi_sandbox_execution_mode]
}

run "workspace_read_only_reaches_the_worker" {
  command = plan

  variables {
    pi_scratch_workspace_mode        = "read_only"
    pi_computer_preview_acknowledged = true
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_SCRATCH_WORKSPACE_MODE"] == "read_only"
    error_message = "The read-only Pi workspace mode must reach the control-plane Worker."
  }
}

run "workspace_writable_reaches_the_worker" {
  command = plan

  variables {
    pi_scratch_workspace_mode        = "writable"
    pi_computer_preview_acknowledged = true
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_SCRATCH_WORKSPACE_MODE"] == "writable"
    error_message = "The writable Pi workspace mode must reach the control-plane Worker."
  }
}

run "repository_editing_reaches_the_worker_independently" {
  command = plan

  variables {
    pi_scratch_workspace_mode        = "read_only"
    pi_repository_editing_mode       = "enabled"
    pi_computer_preview_acknowledged = true
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_SCRATCH_WORKSPACE_MODE"] == "read_only" && module.control_plane_worker.plain_text_bindings["PI_REPOSITORY_EDITING_MODE"] == "enabled"
    error_message = "Repository editing must not widen the independent scratch workspace mode."
  }
}

run "computer_preview_acknowledgement_is_required_for_workspace" {
  command = plan

  variables {
    pi_scratch_workspace_mode = "read_only"
  }

  expect_failures = [terraform_data.pi_computer_preview_gate]
}

run "computer_preview_acknowledgement_is_required_for_repository_editing" {
  command = plan

  variables {
    pi_repository_editing_mode = "enabled"
  }

  expect_failures = [terraform_data.pi_computer_preview_gate]
}

run "workspace_rejects_unknown_modes" {
  command = plan

  variables {
    pi_scratch_workspace_mode = "write"
  }

  expect_failures = [var.pi_scratch_workspace_mode]
}
