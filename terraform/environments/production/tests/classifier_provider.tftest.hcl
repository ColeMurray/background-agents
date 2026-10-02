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
  deployment_name             = "classifier-provider-test"

  modal_token_id     = "test-modal-token-id"
  modal_token_secret = "test-modal-token-secret"
  modal_workspace    = "test-workspace"
  modal_api_secret   = "test-modal-api-secret"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false

  # Both classifier-bearing bots are deployed so their bindings can be asserted.
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

# The default must stay identical to a pre-feature deployment: the Anthropic key
# bound, and no OpenAI key binding introduced at all.
run "anthropic_classifier_by_default" {
  command = plan

  assert {
    condition     = !local.classifier_uses_openai
    error_message = "The default classification model must resolve to Anthropic."
  }

  assert {
    condition = (
      contains(module.slack_bot_worker[0].secret_binding_names, "ANTHROPIC_API_KEY") &&
      !contains(module.slack_bot_worker[0].secret_binding_names, "OPENAI_API_KEY")
    )
    error_message = "An Anthropic-classifier deployment must bind only the Anthropic key on the Slack bot."
  }

  assert {
    condition = (
      contains(module.linear_bot_worker[0].secret_binding_names, "ANTHROPIC_API_KEY") &&
      !contains(module.linear_bot_worker[0].secret_binding_names, "OPENAI_API_KEY")
    )
    error_message = "An Anthropic-classifier deployment must bind only the Anthropic key on the Linear bot."
  }

  assert {
    condition = (
      contains(module.slack_bot_worker[0].plain_text_binding_names, "CLASSIFICATION_MODEL") &&
      contains(module.linear_bot_worker[0].plain_text_binding_names, "CLASSIFICATION_MODEL")
    )
    error_message = "Both classifier bots must receive the configured classification model."
  }

  assert {
    condition = (
      output.slack_bot_worker_url == "https://open-inspect-slack-bot-classifier-provider-test.test-account.workers.dev" &&
      output.slack_bot_events_url == "https://open-inspect-slack-bot-classifier-provider-test.test-account.workers.dev/events" &&
      output.slack_bot_interactions_url == "https://open-inspect-slack-bot-classifier-provider-test.test-account.workers.dev/interactions"
    )
    error_message = "Slack setup outputs must expose the worker, events, and interactions URLs."
  }

  # Backwards compatibility: an Anthropic classifier reuses the deployment-wide
  # key, so an existing deployment needs no new variable.
  assert {
    condition = (
      one([for b in local.classifier_secret_bindings : b.value]) == var.anthropic_api_key
    )
    error_message = "An Anthropic classifier must bind the deployment-wide anthropic_api_key."
  }
}

# A classifier-only deployment sets the dedicated key and leaves the sandbox key
# blank: the bots keep their credential while no sandbox path receives one.
run "dedicated_classifier_key_stays_out_of_sandboxes" {
  command = plan

  variables {
    classification_anthropic_api_key = "test-classifier-key"
    anthropic_api_key                = ""
    sandbox_provider                 = "opencomputer"
    opencomputer_api_url             = "https://api.opencomputer.example"
    opencomputer_api_key             = "test-opencomputer-key"
    opencomputer_template            = "test-template"
  }

  assert {
    condition = (
      local.classifier_secret_bindings.ANTHROPIC_API_KEY.value == "test-classifier-key" &&
      contains(module.slack_bot_worker[0].secret_binding_names, "ANTHROPIC_API_KEY") &&
      contains(module.linear_bot_worker[0].secret_binding_names, "ANTHROPIC_API_KEY")
    )
    error_message = "The classifier bots must bind the dedicated classifier key."
  }

  assert {
    condition     = local.modal_llm_secret_values == { ANTHROPIC_API_KEY = "" }
    error_message = "The dedicated classifier key must not reach Modal sandboxes."
  }

  assert {
    condition = (
      contains(module.control_plane_worker.secret_binding_names, "OPENCOMPUTER_API_KEY") &&
      !contains(module.control_plane_worker.secret_binding_names, "ANTHROPIC_API_KEY")
    )
    error_message = "The dedicated classifier key must not reach OpenComputer sandboxes."
  }
}

# With both keys configured, each stays in its own trust domain.
run "dedicated_classifier_key_takes_precedence" {
  command = plan

  variables {
    classification_anthropic_api_key = "test-classifier-key"
  }

  assert {
    condition     = local.classifier_secret_bindings.ANTHROPIC_API_KEY.value == "test-classifier-key"
    error_message = "A configured classifier key must take precedence over anthropic_api_key."
  }

  assert {
    condition     = local.modal_llm_secret_values == { ANTHROPIC_API_KEY = "test-anthropic-key" }
    error_message = "Sandboxes must keep receiving anthropic_api_key, not the classifier key."
  }
}

# Whitespace is not a credential: the classifier falls back to anthropic_api_key.
run "blank_classifier_key_falls_back" {
  command = plan

  variables {
    classification_anthropic_api_key = "   "
  }

  assert {
    condition     = local.classifier_secret_bindings.ANTHROPIC_API_KEY.value == var.anthropic_api_key
    error_message = "A whitespace-only classifier key must fall back to anthropic_api_key."
  }
}

run "openai_classifier_binds_openai_key" {
  command = plan

  variables {
    classification_model          = "gpt-5.4-mini"
    classification_openai_api_key = "test-openai-key"
  }

  assert {
    condition     = local.classifier_uses_openai
    error_message = "A bare gpt- classification model must resolve to OpenAI."
  }

  assert {
    condition = (
      contains(module.slack_bot_worker[0].secret_binding_names, "OPENAI_API_KEY") &&
      contains(module.linear_bot_worker[0].secret_binding_names, "OPENAI_API_KEY")
    )
    error_message = "An OpenAI-classifier deployment must bind the OpenAI key on both classifier bots."
  }

  # Exactly one provider credential reaches the classifier bots.
  assert {
    condition = (
      !contains(module.slack_bot_worker[0].secret_binding_names, "ANTHROPIC_API_KEY") &&
      !contains(module.linear_bot_worker[0].secret_binding_names, "ANTHROPIC_API_KEY")
    )
    error_message = "An OpenAI-classifier deployment must not bind an Anthropic key it never uses."
  }
}

run "prefixed_openai_model_resolves_to_openai" {
  command = plan

  variables {
    classification_model          = "openai/gpt-5.4-mini"
    classification_openai_api_key = "test-openai-key"
  }

  assert {
    condition     = local.classifier_uses_openai
    error_message = "An openai/-prefixed classification model must resolve to OpenAI."
  }
}

run "prefixed_anthropic_model_resolves_to_anthropic" {
  command = plan

  variables {
    classification_model = "anthropic/claude-haiku-4-5"
  }

  assert {
    condition     = !local.classifier_uses_openai
    error_message = "An anthropic/-prefixed classification model must resolve to Anthropic."
  }
}

# CI renders an unset secret as an empty string, so this must fail at plan time
# rather than deploying a classifier with no usable credential.
run "openai_classifier_requires_openai_key" {
  command = plan

  variables {
    classification_model          = "gpt-5.4-mini"
    classification_openai_api_key = ""
  }

  expect_failures = [var.classification_openai_api_key]
}

# No classifier is deployed, so an unused OpenAI credential must not be demanded.
run "openai_model_without_bots_needs_no_key" {
  command = plan

  variables {
    classification_model          = "gpt-5.4-mini"
    classification_openai_api_key = ""
    enable_slack_bot              = false
    enable_linear_bot             = false
  }

  assert {
    condition     = length(module.slack_bot_worker) == 0 && length(module.linear_bot_worker) == 0
    error_message = "Neither classifier bot should be deployed in this configuration."
  }
}

run "rejects_unknown_classifier_provider" {
  command = plan

  variables {
    classification_model = "llama-3-70b"
  }

  expect_failures = [var.classification_model]
}

# An unset CI variable renders as an empty string. The workflow supplies an
# explicit fallback, and this asserts the configuration also refuses to treat a
# blank override as "use the default" — it fails loudly instead.
run "rejects_blank_classification_model" {
  command = plan

  variables {
    classification_model = ""
  }

  expect_failures = [var.classification_model]
}

# A prefix with no model id after it satisfies startswith but names nothing —
# the bots' resolver would accept it and send it to the provider verbatim.
run "rejects_a_bare_provider_prefix" {
  command = plan

  variables {
    classification_model = "claude-"
  }

  expect_failures = [var.classification_model]
}

run "rejects_a_bare_openai_namespace" {
  command = plan

  variables {
    classification_model          = "openai/"
    classification_openai_api_key = "test-openai-key"
  }

  expect_failures = [var.classification_model]
}

run "rejects_whitespace_after_a_prefix" {
  command = plan

  variables {
    classification_model = "anthropic/   "
  }

  expect_failures = [var.classification_model]
}

run "accepts_a_prefixed_model_with_one_character" {
  command = plan

  variables {
    classification_model = "claude-x"
  }

  assert {
    condition     = !local.classifier_uses_openai
    error_message = "A minimal claude- id must still resolve to Anthropic."
  }
}
