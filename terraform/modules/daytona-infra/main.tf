# Daytona Infrastructure Module
# Builds the base snapshot used by Daytona sandboxes.
# Mirrors the pattern of terraform/modules/modal-app/ for Modal deployments.

locals {
  snapshot_name = "${var.snapshot_name_prefix}-m${var.memory_gib}-${substr(var.source_hash, 0, 16)}"
}

resource "null_resource" "daytona_snapshot" {
  triggers = {
    source_hash   = var.source_hash
    snapshot_name = local.snapshot_name
    memory_gib    = tostring(var.memory_gib)
    api_url       = var.api_url
    target        = var.target
    script_hash   = filesha256("${path.module}/scripts/build-snapshot.sh")
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/build-snapshot.sh"
    interpreter = ["bash"]

    environment = {
      DAYTONA_API_KEY                  = var.api_key
      DAYTONA_API_URL                  = var.api_url
      DAYTONA_TARGET                   = var.target
      DAYTONA_BASE_SNAPSHOT            = local.snapshot_name
      DAYTONA_BASE_SNAPSHOT_MEMORY_GIB = tostring(var.memory_gib)
      OPENINSPECT_IMAGE_CANDIDATE      = local.snapshot_name
      DEPLOY_PATH                      = var.deploy_path
    }
  }
}
