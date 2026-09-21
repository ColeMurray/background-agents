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
  deployment_name             = "modal-vm-sandboxes-test"

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

run "docker_admission_is_closed_by_default" {
  command = plan

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["ENABLE_MODAL_VM_SANDBOXES"] == "false"
    error_message = "New Docker sessions must not be admitted unless an operator opens the gate."
  }
}

run "admission_requires_provisioning" {
  command = plan

  variables {
    enable_modal_vm_sandboxes = true
  }

  expect_failures = [var.enable_modal_vm_sandboxes]
}

run "provisioning_alone_keeps_admission_closed" {
  command = plan

  variables {
    provision_modal_vm_sandboxes = true
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["ENABLE_MODAL_VM_SANDBOXES"] == "false"
    error_message = "Provisioning the Docker image must not admit new Docker sessions on its own."
  }
}

run "provisioned_and_enabled_admits_docker_sessions" {
  command = plan

  variables {
    provision_modal_vm_sandboxes = true
    enable_modal_vm_sandboxes    = true
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["ENABLE_MODAL_VM_SANDBOXES"] == "true"
    error_message = "The control plane must learn that Docker sessions are admitted."
  }
}
