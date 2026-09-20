mock_provider "cloudflare" {}
mock_provider "vercel" {}
mock_provider "random" {}
mock_provider "external" {}
mock_provider "local" {}
mock_provider "null" {}

variables {
  cloudflare_api_token             = "test-cloudflare-token"
  cloudflare_account_id            = "test-account"
  cloudflare_worker_subdomain      = "test-account"
  github_app_id                    = "1"
  github_app_private_key           = "test-private-key"
  github_app_installation_id       = "1"
  token_encryption_key             = "test-token-key"
  repo_secrets_encryption_key      = "test-repo-key"
  provider_accounts_encryption_key = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY="
  nextauth_secret                  = "test-browser-auth-secret-with-32-characters"
  deployment_name                  = "daytona-oci-test"
  web_platform                     = "cloudflare"
  project_root                     = "../../../"
  enable_github_bot                = false
  enable_slack_bot                 = false
  enable_linear_bot                = false
  github_client_id                 = "github-id"
  github_client_secret             = "github-secret"
  allowed_users                    = "octocat"
  sandbox_provider                 = "daytona"
  daytona_api_key                  = "test-api-key"
  daytona_api_url                  = "https://app.daytona.io/api"
  daytona_base_image               = "ghcr.io/example/open-inspect-daytona@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}

run "digest_is_preserved" {
  command = plan

  assert {
    condition     = output.daytona_base_image == var.daytona_base_image
    error_message = "Expected the exact configured Daytona digest in Terraform output."
  }
}

run "rejects_tag_only_reference" {
  command = plan

  variables {
    daytona_base_image = "ghcr.io/example/open-inspect-daytona:latest"
  }

  expect_failures = [var.daytona_base_image]
}
