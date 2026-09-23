# =============================================================================
# Vercel Sandbox Infrastructure
# =============================================================================

# Calculate hash of Vercel base snapshot source files for change detection.
# Includes sandbox-runtime plus the Vercel bootstrap/builder code that is copied into the snapshot.
data "external" "vercel_source_hash" {
  count = local.use_vercel_backend ? 1 : 0

  program = ["python3", "${var.project_root}/packages/sandbox-images/cli.py", "hash", "--root", var.project_root, "--provider", "vercel"]
}

module "vercel_sandbox_infra" {
  count  = local.use_vercel_backend ? 1 : 0
  source = "../../modules/vercel-sandbox-infra"

  token              = var.vercel_sandbox_token
  project_id         = var.vercel_sandbox_project_id
  team_id            = var.vercel_sandbox_team_id
  runtime            = var.vercel_sandbox_runtime
  api_base_url       = var.vercel_sandbox_api_base_url
  manual_snapshot_id = var.vercel_base_snapshot_id
  project_root       = var.project_root
  source_hash        = data.external.vercel_source_hash[0].result.hash
}
