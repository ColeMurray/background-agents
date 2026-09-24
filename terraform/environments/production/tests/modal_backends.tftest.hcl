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
  deployment_name             = "daytona-snapshot-memory-test"

  sandbox_provider   = "modal"
  modal_token_id     = "test-token"
  modal_token_secret = "test-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-api-secret"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"
}


run "gvisor_uses_shared_modal_infrastructure" {
  command = plan
  assert {
    condition     = local.use_modal_backend && length(module.modal_app) == 1 && length(data.external.modal_source_hash) == 1
    error_message = "Standard Modal must provision its shared infrastructure."
  }
  assert {
    condition     = !module.modal_app[0].vm_image_build_enabled
    error_message = "Standard Modal must not request VM image verification."
  }
}
run "vm_uses_shared_modal_infrastructure" {
  command = plan
  variables { sandbox_provider = "modal-vm" }
  assert {
    condition     = local.use_modal_backend && length(module.modal_app) == 1 && length(data.external.modal_source_hash) == 1
    error_message = "Modal VM must provision the same Modal module and credentials."
  }
  assert {
    condition     = module.modal_app[0].vm_image_build_enabled
    error_message = "Modal VM selection must reach the module deployment trigger."
  }
}
run "vm_requires_modal_credentials" {
  command = plan
  variables {
    sandbox_provider = "modal-vm"
    modal_token_id   = ""
  }
  expect_failures = [var.modal_token_id]
}
