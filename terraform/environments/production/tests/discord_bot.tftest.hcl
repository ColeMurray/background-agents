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
  token_encryption_key        = "test-token-key"
  repo_secrets_encryption_key = "test-repo-key"
  nextauth_secret             = "test-browser-auth-secret-with-32-characters"
  deployment_name             = "discord-bot-test"

  modal_token_id     = "test-modal-token-id"
  modal_token_secret = "test-modal-token-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-modal-api-secret"

  web_platform = "cloudflare"
  project_root = "../../../"

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"

  # Slack defaults to on; this suite covers Discord alone.
  enable_slack_bot = false

  # Each run enables the bot itself so the suite also covers the real default.
  discord_application_id      = "123456789012345678"
  discord_public_key          = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  discord_bot_token           = "test-discord-token"
  discord_allowed_role_ids    = "456"
  discord_allowed_channel_ids = "789"
}

# The bot runs on the Claude Agent harness by default so sessions can use a
# connected Claude subscription, and needs no Anthropic API key to deploy.
run "defaults_reach_the_worker_and_control_plane" {
  command = plan

  variables {
    enable_discord_bot = true
  }

  assert {
    condition     = module.discord_bot_worker[0].plain_text_bindings["HARNESS"] == "claude"
    error_message = "The Discord bot must default to the Claude Agent harness."
  }

  assert {
    condition     = module.discord_bot_worker[0].plain_text_bindings["DEFAULT_MODEL"] == "anthropic/claude-opus-5"
    error_message = "The Discord bot's default model must be anthropic/claude-opus-5."
  }

  assert {
    condition     = module.discord_bot_worker[0].plain_text_bindings["DISCORD_ALLOWED_ROLE_IDS"] == "456"
    error_message = "The allowed roles must reach the worker."
  }

  assert {
    condition     = contains(module.control_plane_worker.secret_binding_names, "SERVICE_AUTH_SECRET_DISCORD_BOT")
    error_message = "The control plane must hold the Discord bot's verification key."
  }
}

# An empty role list would admit nobody; refuse it at plan time instead.
run "requires_an_allowed_role" {
  command = plan

  variables {
    enable_discord_bot       = true
    discord_allowed_role_ids = " "
  }

  expect_failures = [var.enable_discord_bot]
}

# A separator alone names no role either.
run "requires_a_non_empty_role_id" {
  command = plan

  variables {
    enable_discord_bot       = true
    discord_allowed_role_ids = " , "
  }

  expect_failures = [var.enable_discord_bot]
}

run "rejects_a_malformed_public_key" {
  command = plan

  variables {
    enable_discord_bot = true
    discord_public_key = "abcdef"
  }

  expect_failures = [var.discord_public_key]
}

run "rejects_a_malformed_application_id" {
  command = plan

  variables {
    enable_discord_bot     = true
    discord_application_id = "123"
  }

  expect_failures = [var.discord_application_id]
}

run "rejects_a_whitespace_bot_token" {
  command = plan

  variables {
    enable_discord_bot = true
    discord_bot_token  = "test discord token"
  }

  expect_failures = [var.discord_bot_token]
}

run "rejects_an_unknown_harness" {
  command = plan

  variables {
    enable_discord_bot  = true
    discord_bot_harness = "codex"
  }

  expect_failures = [var.discord_bot_harness]
}

# The Claude Agent harness runs Anthropic models only; catch the mismatch at plan time.
run "rejects_a_non_anthropic_model_on_the_claude_harness" {
  command = plan

  variables {
    enable_discord_bot        = true
    discord_bot_default_model = "openai/gpt-5.5"
  }

  expect_failures = [var.discord_bot_default_model]
}

run "accepts_any_provider_on_opencode" {
  command = plan

  variables {
    enable_discord_bot        = true
    discord_bot_harness       = "opencode"
    discord_bot_default_model = "openai/gpt-5.5"
  }

  assert {
    condition     = module.discord_bot_worker[0].plain_text_bindings["DEFAULT_MODEL"] == "openai/gpt-5.5"
    error_message = "OpenCode sessions may use any provider's model."
  }
}

run "disabled_by_default" {
  command = plan

  assert {
    condition     = length(module.discord_bot_worker) == 0
    error_message = "No Discord worker should deploy unless enabled."
  }
}
