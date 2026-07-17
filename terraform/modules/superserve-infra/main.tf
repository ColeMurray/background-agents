# Superserve template containing the Open-Inspect sandbox runtime.

locals {
  template_name = "openinspect-runtime-${substr(var.source_hash, 0, 16)}"
}

resource "null_resource" "superserve_template" {
  count = var.manual_template == "" ? 1 : 0

  triggers = {
    source_hash = var.source_hash
    name        = local.template_name
    api_url     = var.api_url
    script_hash = filesha256("${path.module}/scripts/build-template.sh")
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/build-template.sh"
    interpreter = ["bash"]

    environment = {
      PROJECT_ROOT        = var.project_root
      SUPERSERVE_API_URL  = var.api_url
      SUPERSERVE_API_KEY  = var.api_key
      SUPERSERVE_TEMPLATE = local.template_name
    }
  }
}
