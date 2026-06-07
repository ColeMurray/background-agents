# Islo Infrastructure Module
# Builds the base snapshot used by Islo sandboxes.
# Mirrors the pattern of terraform/modules/daytona-infra.

resource "null_resource" "islo_snapshot" {
  triggers = {
    source_hash   = var.source_hash
    snapshot_name = var.snapshot_name
    base_url      = var.base_url
    script_hash   = filesha256("${path.module}/scripts/build-snapshot.sh")
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/build-snapshot.sh"
    interpreter = ["bash"]

    environment = {
      ISLO_API_KEY       = var.api_key
      ISLO_BASE_URL      = var.base_url
      ISLO_BASE_SNAPSHOT = var.snapshot_name
      DEPLOY_PATH        = var.deploy_path
    }
  }
}
