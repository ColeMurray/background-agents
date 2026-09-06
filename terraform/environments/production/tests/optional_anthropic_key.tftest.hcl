# The deployment-wide Anthropic key is optional. A deployment whose sandboxes get
# their model credentials from the per-repository secret store configures no key
# at all, so nothing outside the classifier bots may demand one.

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
  deployment_name             = "optional-anthropic-test"

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

  # The condition under test: no deployment-wide Anthropic key.
  anthropic_api_key = ""
}

# The whole point of the change: a deployment that configures no Anthropic key
# must plan.
run "a_deployment_with_no_anthropic_key_plans" {
  command = plan

  assert {
    condition     = local.modal_llm_secret_values == {}
    error_message = "An unset Anthropic key must leave no deployment-wide LLM keys to inject."
  }
}

# Modal rejects a secret with no keys, so an all-blank secret must be dropped
# from the module input rather than sent as an empty map.
run "a_configured_key_is_injected_into_modal" {
  command = plan

  variables {
    anthropic_api_key = "test-anthropic-key"
  }

  assert {
    condition     = local.modal_llm_secret_values == { ANTHROPIC_API_KEY = "test-anthropic-key" }
    error_message = "A configured Anthropic key must be injected as a deployment-wide LLM key."
  }
}

# Whitespace is not a credential.
run "a_blank_key_is_not_treated_as_configured" {
  command = plan

  variables {
    anthropic_api_key = "   "
  }

  assert {
    condition     = local.modal_llm_secret_values == {}
    error_message = "A whitespace-only Anthropic key must be dropped, not injected."
  }
}

# OpenComputer sandboxes read the key from the control plane. An unset key must
# not reach the worker, where an empty binding would shadow the key a repository
# supplies through the secret store.
run "opencomputer_without_a_key_binds_none" {
  command = plan

  variables {
    sandbox_provider      = "opencomputer"
    opencomputer_api_url  = "https://api.opencomputer.example"
    opencomputer_api_key  = "test-opencomputer-key"
    opencomputer_template = "test-template"
  }

  assert {
    condition = (
      contains(module.control_plane_worker.secret_binding_names, "OPENCOMPUTER_API_KEY") &&
      !contains(module.control_plane_worker.secret_binding_names, "ANTHROPIC_API_KEY")
    )
    error_message = "An unset Anthropic key must not be bound on the control plane worker."
  }
}

run "opencomputer_with_a_key_binds_it" {
  command = plan

  variables {
    sandbox_provider      = "opencomputer"
    opencomputer_api_url  = "https://api.opencomputer.example"
    opencomputer_api_key  = "test-opencomputer-key"
    opencomputer_template = "test-template"
    anthropic_api_key     = "test-anthropic-key"
  }

  assert {
    condition     = contains(module.control_plane_worker.secret_binding_names, "ANTHROPIC_API_KEY")
    error_message = "A configured Anthropic key must reach OpenComputer sandboxes via the control plane."
  }
}

# Whitespace is not a credential here either. The provider's own validation only
# guards sandbox_provider = "opencomputer", so a blank key on any other provider
# would otherwise bind an unusable OPENCOMPUTER_API_KEY.
run "a_blank_opencomputer_key_does_not_enable_its_bindings" {
  command = plan

  variables {
    opencomputer_api_url = "https://api.opencomputer.example"
    opencomputer_api_key = "   "
    anthropic_api_key    = "test-anthropic-key"
  }

  assert {
    condition = (
      !contains(module.control_plane_worker.secret_binding_names, "OPENCOMPUTER_API_KEY") &&
      !contains(module.control_plane_worker.secret_binding_names, "ANTHROPIC_API_KEY")
    )
    error_message = "A whitespace-only OpenComputer key must not enable its control plane bindings."
  }
}

# The classifier bots have no per-repository fallback, so they keep their
# requirement: this is the one place a key is still mandatory.
run "an_anthropic_classifier_still_requires_the_key" {
  command = plan

  variables {
    enable_slack_bot     = true
    slack_bot_token      = "xoxb-test"
    slack_signing_secret = "test-signing-secret"
    classification_model = "claude-haiku-4-5"
    anthropic_api_key    = ""
  }

  expect_failures = [var.anthropic_api_key]
}

# ... but only when it is the classifier's provider.
run "an_openai_classifier_needs_no_anthropic_key" {
  command = plan

  variables {
    enable_slack_bot              = true
    slack_bot_token               = "xoxb-test"
    slack_signing_secret          = "test-signing-secret"
    classification_model          = "gpt-5.4-mini"
    classification_openai_api_key = "test-openai-key"
    anthropic_api_key             = ""
  }

  assert {
    condition = (
      contains(module.slack_bot_worker[0].secret_binding_names, "OPENAI_API_KEY") &&
      !contains(module.slack_bot_worker[0].secret_binding_names, "ANTHROPIC_API_KEY")
    )
    error_message = "An OpenAI classifier must not demand an Anthropic key."
  }
}
