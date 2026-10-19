mock_provider "cloudflare" {}
mock_provider "external" {
  mock_data "external" {
    defaults = { result = { hash = "test" } }
  }
}
mock_provider "local" {}
mock_provider "null" {}
mock_provider "random" {}
mock_provider "vercel" {}
variables {
  cloudflare_api_token        = "test"
  cloudflare_account_id       = "test"
  cloudflare_worker_subdomain = "test"
  github_app_id               = "1"
  github_app_private_key      = "key"
  github_app_installation_id  = "1"
  anthropic_api_key           = "key"
  token_encryption_key        = "key"
  repo_secrets_encryption_key = "key"
  nextauth_secret             = "test-browser-auth-secret-with-32-characters"
  deployment_name             = "slack-ingress-test"
  modal_token_id              = "id"
  modal_token_secret          = "secret"
  modal_workspace             = "workspace"
  modal_api_secret            = "secret"
  web_platform                = "cloudflare"
  project_root                = "../../../"
  enable_slack_bot            = true
  slack_bot_token             = "xoxb-test"
  slack_signing_secret        = "secret"
  github_client_id            = "id"
  github_client_secret        = "secret"
  allowed_users               = "octocat"
}
run "durable_ingress_defaults_off" {
  command = plan
  assert {
    condition     = length(cloudflare_queue.slack_ingress) == 0 && !contains(module.slack_bot_worker[0].binding_names, "SLACK_INGRESS_QUEUE") && module.slack_bot_worker[0].plain_text_bindings["PI_SLACK_DURABLE_INGRESS_ENABLED"] == "false"
    error_message = "durable Slack ingress must default off"
  }
}
run "durable_ingress_opt_in_wires_queue" {
  command = plan
  variables { pi_slack_durable_ingress_enabled = true }
  assert {
    condition     = length(cloudflare_queue.slack_ingress) == 1 && length(cloudflare_queue.slack_ingress_dlq) == 1 && contains(module.slack_bot_worker[0].binding_names, "SLACK_INGRESS_QUEUE") && module.slack_bot_worker[0].plain_text_bindings["PI_SLACK_DURABLE_INGRESS_ENABLED"] == "true"
    error_message = "opt-in must wire Queue, DLQ, and runtime flag"
  }
}
