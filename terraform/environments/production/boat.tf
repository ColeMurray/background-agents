# =============================================================================
# Boat Sandbox Infrastructure
# =============================================================================

# Shared build-input hash: the runtime, the image package, the Boat builder and
# this module. A change to any of them builds a new named snapshot under a new
# name; the Worker switches to it only after the build has verified it.
data "external" "boat_source_hash" {
  count = local.use_boat_backend ? 1 : 0

  program = ["python3", "${var.project_root}/packages/sandbox-images/cli.py", "hash", "--root", var.project_root, "--provider", "boat"]
}

module "boat_infra" {
  count  = local.use_boat_backend ? 1 : 0
  source = "../../modules/boat-infra"

  api_key              = var.boat_api_key
  api_url              = var.boat_api_url
  org                  = var.boat_org
  snapshot_name_prefix = var.boat_base_snapshot
  deploy_path          = "${var.project_root}/packages/boat-infra"
  source_hash          = data.external.boat_source_hash[0].result.hash
}

# Prune only after the Worker serves the new base. Retain the replaced base for
# rollback and requests still running on the previous Worker version.
resource "null_resource" "boat_base_snapshot_prune" {
  count = local.use_boat_backend ? 1 : 0

  triggers = {
    snapshot_name = module.boat_infra[0].snapshot_name
  }

  provisioner "local-exec" {
    command     = "uv sync --frozen && uv run --frozen python build-template.py prune"
    working_dir = "${var.project_root}/packages/boat-infra"

    environment = {
      # Allow the prune summary in apply logs. The key stays in the environment,
      # never command/triggers; prune must not print it or provider error messages.
      BOAT_API_KEY           = nonsensitive(var.boat_api_key)
      BOAT_API_URL           = var.boat_api_url
      BOAT_ORG               = var.boat_org
      BOAT_BASE_SNAPSHOT     = var.boat_base_snapshot
      BOAT_DEPLOYED_SNAPSHOT = module.boat_infra[0].snapshot_name
    }
  }

  depends_on = [module.control_plane_worker]
}
