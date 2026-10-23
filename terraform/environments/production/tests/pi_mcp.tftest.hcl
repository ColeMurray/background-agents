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
  deployment_name             = "pi-mcp-test"
  web_platform                = "cloudflare"

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

run "mcp_defaults_off" {
  command = plan

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_MCP_MODE"] == "off"
    error_message = "The MCP capability must fail closed by default."
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["MCP_CONNECTIONS_ENABLED"] == "false"
    error_message = "Personal MCP connections must fail closed by default."
  }

  assert {
    condition     = !contains(module.control_plane_worker.binding_names, "MCP_CONNECTION")
    error_message = "The personal MCP Durable Object binding must be absent by default."
  }

  assert {
    condition     = !contains(module.control_plane_worker.secret_binding_names, "MCP_OAUTH_ENCRYPTION_KEY")
    error_message = "The personal MCP encryption secret must be absent while its foundation is disabled."
  }
}

run "personal_mcp_foundation_reaches_the_worker" {
  command = plan

  variables {
    mcp_connection_foundation_enabled = true
    mcp_connection_binding_enabled    = true
    mcp_connections_enabled           = true
    mcp_oauth_encryption_key          = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
    control_plane_migration_tag       = "v5"
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["MCP_CONNECTIONS_ENABLED"] == "true"
    error_message = "The personal MCP feature gate must reach the worker."
  }

  assert {
    condition     = module.control_plane_worker.durable_object_bindings["MCP_CONNECTION"].class_name == "McpConnectionDO"
    error_message = "The personal MCP binding must target McpConnectionDO."
  }

  assert {
    condition     = contains(module.control_plane_worker.secret_binding_names, "MCP_OAUTH_ENCRYPTION_KEY")
    error_message = "The personal MCP OAuth key must be a Worker secret."
  }
}

run "mcp_reaches_the_worker" {
  command = plan

  variables {
    pi_mcp_mode = "enabled"
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_MCP_MODE"] == "enabled"
    error_message = "The MCP gate must reach the worker."
  }
}

run "mcp_accepts_the_read_only_mode" {
  command = plan

  variables {
    pi_mcp_mode = "read_only"
  }

  assert {
    condition     = module.control_plane_worker.plain_text_bindings["PI_MCP_MODE"] == "read_only"
    error_message = "A read-only MCP mode must reach the worker unchanged."
  }
}

run "mcp_rejects_unknown_modes" {
  command = plan

  variables {
    pi_mcp_mode = "maybe"
  }

  expect_failures = [
    var.pi_mcp_mode,
  ]
}
