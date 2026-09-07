# =============================================================================
# Daytona Sandbox Infrastructure
# =============================================================================

# Calculate hash of Daytona snapshot source files for change detection.
# Includes daytona-infra (image definition) and sandbox-runtime (copied into image).
data "external" "daytona_source_hash" {
  count = local.use_daytona_backend ? 1 : 0

  program = ["python3", "${var.project_root}/packages/sandbox-images/cli.py", "hash", "--root", var.project_root, "--provider", "daytona"]
}

module "daytona_infra" {
  count  = local.use_daytona_backend ? 1 : 0
  source = "../../modules/daytona-infra"

  api_key       = var.daytona_api_key
  api_url       = var.daytona_api_url
  target        = var.daytona_target
  snapshot_name = "${var.daytona_base_snapshot}-${substr(data.external.daytona_source_hash[0].result.hash, 0, 16)}"
  deploy_path   = "${var.project_root}/packages/daytona-infra"
  source_hash   = data.external.daytona_source_hash[0].result.hash
}
