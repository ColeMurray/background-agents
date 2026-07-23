# E2B Infrastructure Module
# Builds the E2B sandbox template used by E2B sandboxes.
# Mirrors terraform/modules/daytona-infra/ (snapshot build) for the E2B backend.

resource "null_resource" "e2b_template" {
  triggers = {
    source_hash = var.source_hash
    template_id = var.template_id
    api_url     = var.api_url
    cpu         = var.template_cpu
    memory_mb   = var.template_memory_mb
    script_hash = filesha256("${path.module}/scripts/build-template.sh")
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/build-template.sh"
    interpreter = ["bash"]

    environment = {
      E2B_API_KEY      = var.api_key
      E2B_API_URL      = var.api_url
      E2B_TEMPLATE_ID  = var.template_id
      E2B_TEMPLATE_CPU = var.template_cpu
      E2B_TEMPLATE_MEM = var.template_memory_mb
      DEPLOY_PATH      = var.deploy_path
    }
  }
}
