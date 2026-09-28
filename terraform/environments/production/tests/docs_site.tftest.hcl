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
  deployment_name             = "docs-site-test"

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

run "docs_site_is_opt_in" {
  command = plan
  assert {
    condition     = length(module.docs_site) == 0
    error_message = "The docs site must not be provisioned unless docs_site_enabled is set."
  }
}

run "docs_site_builds_from_the_docs_package" {
  command = plan
  variables {
    docs_site_enabled = true
    vercel_team_id    = "test-team"
  }
  # docs-vercel.tf passes no git_repository, so Vercel has no git integration to
  # deploy from: only the Deploy Docs workflow publishes. That is the gate
  # documented in packages/docs/README.md.
  assert {
    condition     = module.docs_site[0].root_directory == "packages/docs"
    error_message = "The docs project must build from packages/docs."
  }
}

run "docs_site_is_separate_from_the_web_app" {
  command = plan
  variables {
    docs_site_enabled = true
    web_platform      = "vercel"
    vercel_team_id    = "test-team"
  }
  assert {
    condition     = module.docs_site[0].project_name != module.web_app[0].project_name
    error_message = "The docs site must be its own Vercel project, so a docs publish cannot touch the product."
  }
}
