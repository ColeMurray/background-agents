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
  deployment_name             = "bot-default-model-test"

  modal_token_id     = "test-modal-token-id"
  modal_token_secret = "test-modal-token-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-modal-api-secret"

  web_platform = "cloudflare"
  project_root = "../../../"

  # All three bots are deployed so every DEFAULT_MODEL binding can be asserted.
  enable_github_bot     = true
  github_webhook_secret = "test-github-webhook-secret"
  github_bot_username   = "test-bot[bot]"

  enable_slack_bot     = true
  slack_bot_token      = "xoxb-test"
  slack_signing_secret = "test-signing-secret"

  enable_linear_bot     = true
  linear_client_id      = "test-linear-client-id"
  linear_client_secret  = "test-linear-client-secret"
  linear_webhook_secret = "test-linear-webhook-secret"
  linear_api_key        = "test-linear-api-key"

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"
}

# The defaults must reproduce the values these bindings carried while they were
# hardcoded, so making them configurable changes no existing deployment. Each
# bot keeps its own default deliberately: they are not required to agree.
run "defaults_preserve_the_previously_hardcoded_models" {
  command = plan

  assert {
    condition     = module.github_bot_worker[0].plain_text_bindings["DEFAULT_MODEL"] == "anthropic/claude-haiku-4-5"
    error_message = "The GitHub bot's default model binding must stay anthropic/claude-haiku-4-5."
  }

  assert {
    condition     = module.slack_bot_worker[0].plain_text_bindings["DEFAULT_MODEL"] == "claude-haiku-4-5"
    error_message = "The Slack bot's default model binding must stay claude-haiku-4-5."
  }

  assert {
    condition     = module.linear_bot_worker[0].plain_text_bindings["DEFAULT_MODEL"] == "claude-sonnet-4-6"
    error_message = "The Linear bot's default model binding must stay claude-sonnet-4-6."
  }
}

# The point of the variables: a deployment picks its models in tfvars, and the
# choice reaches the workers instead of requiring an edit to tracked .tf files.
run "overrides_reach_each_bot_binding" {
  command = plan

  variables {
    github_bot_default_model = "anthropic/claude-opus-4-5"
    slack_bot_default_model  = "openai/gpt-5.4"
    linear_bot_default_model = "claude-sonnet-5"
  }

  assert {
    condition     = module.github_bot_worker[0].plain_text_bindings["DEFAULT_MODEL"] == "anthropic/claude-opus-4-5"
    error_message = "An overridden github_bot_default_model must reach the GitHub bot's DEFAULT_MODEL binding."
  }

  assert {
    condition     = module.slack_bot_worker[0].plain_text_bindings["DEFAULT_MODEL"] == "openai/gpt-5.4"
    error_message = "An overridden slack_bot_default_model must reach the Slack bot's DEFAULT_MODEL binding."
  }

  assert {
    condition     = module.linear_bot_worker[0].plain_text_bindings["DEFAULT_MODEL"] == "claude-sonnet-5"
    error_message = "An overridden linear_bot_default_model must reach the Linear bot's DEFAULT_MODEL binding."
  }

  # One bot's override must not leak into another's binding.
  assert {
    condition = (
      module.github_bot_worker[0].plain_text_bindings["DEFAULT_MODEL"] !=
      module.slack_bot_worker[0].plain_text_bindings["DEFAULT_MODEL"] &&
      module.slack_bot_worker[0].plain_text_bindings["DEFAULT_MODEL"] !=
      module.linear_bot_worker[0].plain_text_bindings["DEFAULT_MODEL"]
    )
    error_message = "Each bot's default model must be sourced from its own variable."
  }
}

# An unset CI variable renders as an empty string. Treating that as "use the
# default" would silently deploy whichever model the configuration last shipped,
# so a blank override must fail at plan time instead.
run "rejects_a_blank_github_model" {
  command = plan

  variables {
    github_bot_default_model = "  "
  }

  expect_failures = [var.github_bot_default_model]
}

run "rejects_a_blank_slack_model" {
  command = plan

  variables {
    slack_bot_default_model = ""
  }

  expect_failures = [var.slack_bot_default_model]
}

run "rejects_a_blank_linear_model" {
  command = plan

  variables {
    linear_bot_default_model = ""
  }

  expect_failures = [var.linear_bot_default_model]
}

# A provider namespace with no model after it satisfies a prefix check but names
# nothing, and the bots would forward it to the provider verbatim.
run "rejects_a_bare_provider_namespace" {
  command = plan

  variables {
    slack_bot_default_model = "anthropic/"
  }

  expect_failures = [var.slack_bot_default_model]
}

run "rejects_a_bare_model_prefix" {
  command = plan

  variables {
    linear_bot_default_model = "claude-"
  }

  expect_failures = [var.linear_bot_default_model]
}

# A bare id with no recognized prefix names no provider — the bots cannot
# normalize it, and it would reach session creation unresolvable.
run "rejects_an_unprefixed_bare_id" {
  command = plan

  variables {
    github_bot_default_model = "haiku-4-5"
  }

  expect_failures = [var.github_bot_default_model]
}

# Whitespace inside the id is not cosmetic: the value reaches each worker's
# DEFAULT_MODEL binding verbatim, so a stray space produces a model id no
# provider resolves. Each shape a hand-edited tfvars or a CI variable can
# introduce must fail at plan time.
run "rejects_whitespace_after_the_provider_namespace" {
  command = plan

  variables {
    github_bot_default_model = "anthropic/ claude-haiku-4-5"
  }

  expect_failures = [var.github_bot_default_model]
}

run "rejects_a_trailing_space_on_a_bare_id" {
  command = plan

  variables {
    slack_bot_default_model = "claude-haiku-4-5 "
  }

  expect_failures = [var.slack_bot_default_model]
}

run "rejects_a_leading_space_before_the_provider" {
  command = plan

  variables {
    linear_bot_default_model = " anthropic/claude-sonnet-4-6"
  }

  expect_failures = [var.linear_bot_default_model]
}

# A canonical id names exactly one provider and one model. More segments than
# that is not a namespace the bots can normalize, however the id begins.
run "rejects_more_than_one_slash" {
  command = plan

  variables {
    github_bot_default_model = "claude-haiku/4-5/beta"
  }

  expect_failures = [var.github_bot_default_model]
}
