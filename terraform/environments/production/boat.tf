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
