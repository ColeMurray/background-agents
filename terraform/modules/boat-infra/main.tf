# Boat Infrastructure Module
# Builds the saved snapshot Boat sandboxes deploy from.
# Mirrors terraform/modules/daytona-infra/ (snapshot build) for the Boat backend.

locals {
  snapshot_name = "${var.snapshot_name_prefix}-${substr(var.source_hash, 0, 16)}"
}

resource "null_resource" "boat_snapshot" {
  triggers = {
    source_hash        = var.source_hash
    snapshot_name      = local.snapshot_name
    api_url            = var.api_url
    org                = var.org
    build_sandbox_type = var.build_sandbox_type
    script_hash        = filesha256("${path.module}/scripts/build-snapshot.sh")
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/build-snapshot.sh"
    interpreter = ["bash"]

    environment = {
      BOAT_API_KEY                = var.api_key
      BOAT_API_URL                = var.api_url
      BOAT_ORG                    = var.org
      BOAT_BASE_SNAPSHOT          = var.snapshot_name_prefix
      BOAT_BUILD_SANDBOX_TYPE     = var.build_sandbox_type
      OPENINSPECT_IMAGE_CANDIDATE = local.snapshot_name
      DEPLOY_PATH                 = var.deploy_path
    }
  }
}
