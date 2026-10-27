# The Boat backend builds a saved snapshot and binds the control plane to it,
# and only to it: a deployment on another backend neither builds nor binds
# anything Boat.

mock_provider "cloudflare" {}
mock_provider "external" {
  mock_data "external" {
    defaults = {
      result = {
        hash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
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
  deployment_name             = "boat-backend-test"

  sandbox_provider   = "boat"
  boat_api_key       = "boat_test_key"
  boat_base_snapshot = "open-inspect"

  web_platform      = "cloudflare"
  project_root      = "../../../"
  enable_github_bot = false
  enable_slack_bot  = false
  enable_linear_bot = false

  github_client_id     = "github-id"
  github_client_secret = "github-secret"
  allowed_users        = "octocat"
}

run "boat_builds_a_saved_snapshot_and_binds_the_worker_to_it" {
  command = plan

  assert {
    condition     = local.use_boat_backend && length(module.boat_infra) == 1 && length(data.external.boat_source_hash) == 1
    error_message = "The Boat backend must hash its build inputs and build the saved snapshot."
  }

  assert {
    condition     = module.boat_infra[0].snapshot_name == "open-inspect-0123456789abcdef"
    error_message = "The saved snapshot must be the prefix plus the first 16 characters of the source hash."
  }

  assert {
    condition = (
      length(null_resource.boat_base_snapshot_prune) == 1 &&
      null_resource.boat_base_snapshot_prune[0].triggers.snapshot_name == "open-inspect-0123456789abcdef" &&
      null_resource.boat_base_snapshot_prune[0].triggers.api_url == "https://boat.dev/api/v1" &&
      null_resource.boat_base_snapshot_prune[0].triggers.org == ""
    )
    error_message = "The Boat backend must prune superseded bases once per deployed snapshot name, API URL and organization."
  }

  assert {
    condition = (
      contains(module.control_plane_worker.plain_text_binding_names, "BOAT_API_URL") &&
      contains(module.control_plane_worker.plain_text_binding_names, "BOAT_BASE_SNAPSHOT") &&
      contains(module.control_plane_worker.plain_text_binding_names, "BOAT_SANDBOX_TYPE") &&
      contains(module.control_plane_worker.secret_binding_names, "BOAT_API_KEY")
    )
    error_message = "The control plane must receive the Boat API URL, snapshot, machine type and key."
  }

  assert {
    condition     = !contains(module.control_plane_worker.plain_text_binding_names, "BOAT_ORG")
    error_message = "An empty organization must not be bound."
  }

  assert {
    condition     = length(module.e2b_infra) == 0 && length(module.daytona_infra) == 0 && length(module.modal_app) == 0
    error_message = "The Boat backend must not provision another backend's infrastructure."
  }
}

run "boat_api_url_changes_retarget_pruning_with_the_same_snapshot" {
  command = plan

  variables {
    boat_api_url = "https://boat.example.test/api/v1"
  }

  assert {
    condition = (
      module.boat_infra[0].snapshot_name == "open-inspect-0123456789abcdef" &&
      null_resource.boat_base_snapshot_prune[0].triggers.snapshot_name == "open-inspect-0123456789abcdef" &&
      null_resource.boat_base_snapshot_prune[0].triggers.api_url == "https://boat.example.test/api/v1" &&
      null_resource.boat_base_snapshot_prune[0].triggers.org == ""
    )
    error_message = "Changing the API URL must retarget the prune trigger even when the source hash and snapshot name are unchanged."
  }
}

run "boat_organization_changes_bind_the_worker_and_retarget_pruning" {
  command = plan

  variables {
    boat_org = "team_example"
  }

  assert {
    condition     = contains(module.control_plane_worker.plain_text_binding_names, "BOAT_ORG")
    error_message = "A configured organization must reach the control plane."
  }

  assert {
    condition = (
      module.boat_infra[0].snapshot_name == "open-inspect-0123456789abcdef" &&
      null_resource.boat_base_snapshot_prune[0].triggers.snapshot_name == "open-inspect-0123456789abcdef" &&
      null_resource.boat_base_snapshot_prune[0].triggers.api_url == "https://boat.dev/api/v1" &&
      null_resource.boat_base_snapshot_prune[0].triggers.org == "team_example"
    )
    error_message = "Changing the organization must retarget the prune trigger even when the source hash and snapshot name are unchanged."
  }
}

run "rejects_an_invalid_snapshot_prefix" {
  command = plan

  variables {
    boat_base_snapshot = "Open_Inspect"
  }

  expect_failures = [var.boat_base_snapshot]
}

run "rejects_the_control_plane_prebuilt_snapshot_prefix" {
  command = plan

  variables {
    boat_base_snapshot = "oi-img-group-sub-group-a-very-long"
  }

  expect_failures = [var.boat_base_snapshot]
}

run "rejects_the_control_plane_prebuilt_snapshot_namespace_root" {
  command = plan

  variables {
    boat_base_snapshot = "oi-img"
  }

  expect_failures = [var.boat_base_snapshot]
}

run "rejects_an_unknown_machine_type" {
  command = plan

  variables {
    boat_sandbox_type = "huge"
  }

  expect_failures = [var.boat_sandbox_type]
}

run "ignores_the_machine_type_on_other_backends" {
  command = plan

  variables {
    sandbox_provider   = "modal"
    modal_token_id     = "test-modal-token-id"
    modal_token_secret = "test-modal-token-secret"
    modal_workspace    = "test-workspace"
    modal_api_secret   = "test-modal-api-secret"
    boat_api_key       = ""
    boat_base_snapshot = ""
    boat_sandbox_type  = "huge"
  }

  assert {
    condition     = length(module.boat_infra) == 0 && length(null_resource.boat_base_snapshot_prune) == 0
    error_message = "A Boat-only setting must not block a deployment on another backend."
  }
}

run "other_backends_build_and_bind_nothing_boat" {
  command = plan

  variables {
    sandbox_provider   = "modal"
    modal_token_id     = "test-modal-token-id"
    modal_token_secret = "test-modal-token-secret"
    modal_workspace    = "test-workspace"
    modal_api_secret   = "test-modal-api-secret"
    boat_api_key       = ""
    boat_base_snapshot = "oi-img-group-sub-group-a-very-long"
  }

  assert {
    condition     = length(module.boat_infra) == 0 && length(null_resource.boat_base_snapshot_prune) == 0
    error_message = "A deployment on another backend must not build or prune Boat snapshots."
  }

  assert {
    condition = (
      !contains(module.control_plane_worker.plain_text_binding_names, "BOAT_BASE_SNAPSHOT") &&
      !contains(module.control_plane_worker.secret_binding_names, "BOAT_API_KEY")
    )
    error_message = "A deployment on another backend must not bind Boat settings."
  }
}
