# OpenComputer Sandbox Infrastructure Module
# Builds the managed base snapshot (declarative template) — baked with the OpenInspect
# runtime — that fresh OpenComputer sandboxes boot from.
# Mirrors the null_resource/script pattern used by Modal, Vercel, and Daytona.

locals {
  # OpenComputer references templates by exact name (createSandbox sends `snapshot: <name>`),
  # One conservative source hash names each managed build.
  snapshot_name = "openinspect-runtime-${substr(var.source_hash, 0, 16)}"
}

resource "null_resource" "opencomputer_base_snapshot" {
  count = var.manual_snapshot_id == "" ? 1 : 0

  triggers = {
    source_hash = var.source_hash
    name        = local.snapshot_name
    api_url     = var.api_url
    script_hash = filesha256("${path.module}/scripts/build-base-snapshot.sh")
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/build-base-snapshot.sh"
    interpreter = ["bash"]

    environment = {
      PROJECT_ROOT                = var.project_root
      OPENCOMPUTER_API_URL        = var.api_url
      OPENCOMPUTER_API_KEY        = var.api_key
      OPENCOMPUTER_TEMPLATE       = local.snapshot_name
      OPENINSPECT_IMAGE_CANDIDATE = local.snapshot_name
    }
  }
}
