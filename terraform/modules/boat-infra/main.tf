resource "null_resource" "boat_template" {
  triggers = {
    source_hash        = var.source_hash
    snapshot_name      = var.snapshot_name
    snapshot_prefix    = var.snapshot_prefix
    protected_snapshot = var.protected_snapshot
    sandbox_type       = var.sandbox_type
    api_url            = var.api_url
    script_hash        = filesha256("${path.module}/scripts/build-template.sh")
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/build-template.sh"
    interpreter = ["bash"]
    environment = {
      BOAT_BUILD_API_KEY          = var.api_key
      BOAT_API_URL                = var.api_url
      BOAT_ORG                    = var.org
      BOAT_TEMPLATE_PREFIX        = var.snapshot_prefix
      BOAT_PROTECTED_SNAPSHOT     = var.protected_snapshot
      BOAT_TEMPLATE_SANDBOX_TYPE  = var.sandbox_type
      OPENINSPECT_IMAGE_CANDIDATE = var.snapshot_name
      DEPLOY_PATH                 = var.deploy_path
    }
  }
}
