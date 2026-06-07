# Vercel Sandbox Infrastructure Module
# Builds the managed base snapshot used by fresh Vercel sandboxes.
# Mirrors the null_resource/script pattern used by Modal and Daytona.

locals {
  snapshot_name = "openinspect-base-${substr(var.source_hash, 0, 16)}"
}

resource "null_resource" "vercel_base_snapshot" {
  count = var.manual_snapshot_id == "" ? 1 : 0

  triggers = {
    source_hash  = var.source_hash
    name         = local.snapshot_name
    project_id   = var.project_id
    team_id      = var.team_id
    runtime      = var.runtime
    api_base_url = var.api_base_url
    script_hash  = filesha256("${path.module}/scripts/build-base-snapshot.sh")
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/build-base-snapshot.sh"
    interpreter = ["bash"]

    environment = {
      PROJECT_ROOT                        = var.project_root
      VERCEL_TOKEN                        = var.token
      VERCEL_PROJECT_ID                   = var.project_id
      VERCEL_TEAM_ID                      = var.team_id
      VERCEL_RUNTIME                      = var.runtime
      VERCEL_SANDBOX_API_BASE_URL         = var.api_base_url
      VERCEL_BASE_SNAPSHOT_NAME           = local.snapshot_name
      VERCEL_BASE_SNAPSHOT_SOURCE_VERSION = var.source_hash
      VERCEL_RUNTIME_SOURCE_DIR           = "packages/sandbox-runtime"
    }
  }
}
