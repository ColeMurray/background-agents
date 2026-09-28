data "external" "boat_source_hash" {
  count = local.use_boat_backend && var.boat_base_snapshot == "" ? 1 : 0

  program = ["python3", "${var.project_root}/packages/sandbox-images/cli.py", "hash", "--root", var.project_root, "--provider", "boat"]
}

locals {
  effective_boat_template_prefix = var.boat_template_prefix != "" ? var.boat_template_prefix : "openinspect-${substr(sha256(var.deployment_name), 0, 12)}-boat"
  managed_boat_snapshot_name = (
    local.use_boat_backend && var.boat_base_snapshot == ""
    ? "${local.effective_boat_template_prefix}-${substr(data.external.boat_source_hash[0].result.hash, 0, 16)}"
    : ""
  )
  effective_boat_base_snapshot = (
    var.boat_base_snapshot != ""
    ? var.boat_base_snapshot
    : (local.use_boat_backend ? module.boat_infra[0].snapshot_name : "")
  )
  effective_boat_build_api_key = var.boat_build_api_key != "" ? var.boat_build_api_key : var.boat_api_key
}

module "boat_infra" {
  count  = local.use_boat_backend && var.boat_base_snapshot == "" ? 1 : 0
  source = "../../modules/boat-infra"

  api_key            = local.effective_boat_build_api_key
  api_url            = var.boat_api_url
  org                = var.boat_org
  snapshot_name      = local.managed_boat_snapshot_name
  snapshot_prefix    = local.effective_boat_template_prefix
  protected_snapshot = var.boat_previous_base_snapshot
  sandbox_type       = var.boat_template_sandbox_type
  deploy_path        = "${var.project_root}/packages/boat-infra"
  source_hash        = data.external.boat_source_hash[0].result.hash
}

# Reclaim deployment-owned candidates only after the Worker has switched to the
# verified snapshot. Keep the prior artifact for immediate rollback.
resource "null_resource" "boat_snapshot_cleanup" {
  count = local.use_boat_backend && var.boat_base_snapshot == "" ? 1 : 0

  triggers = {
    current_snapshot  = local.managed_boat_snapshot_name
    previous_snapshot = var.boat_previous_base_snapshot
    build_id          = module.boat_infra[0].template_build_id
  }

  provisioner "local-exec" {
    command = join(" ", compact([
      "uv run --frozen python build_template.py --cleanup --keep '${local.managed_boat_snapshot_name}'",
      var.boat_previous_base_snapshot != "" ? "--keep '${var.boat_previous_base_snapshot}'" : "",
    ]))
    working_dir = "${var.project_root}/packages/boat-infra"
    interpreter = ["bash", "-c"]
    environment = {
      BOAT_BUILD_API_KEY   = local.effective_boat_build_api_key
      BOAT_API_URL         = var.boat_api_url
      BOAT_ORG             = var.boat_org
      BOAT_TEMPLATE_PREFIX = local.effective_boat_template_prefix
    }
  }

  depends_on = [module.control_plane_worker]
}
