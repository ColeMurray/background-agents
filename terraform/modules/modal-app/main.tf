# Modal App Module
# Wraps Modal CLI commands since no Terraform provider exists
# Uses null_resource with local-exec provisioners

locals {
  # Combine all secrets for the create-secrets script
  secrets_json = jsonencode(var.secrets)
}

# Create Modal secrets
resource "null_resource" "modal_secrets" {
  count = length(var.secrets) > 0 ? 1 : 0

  triggers = {
    # Re-run when secrets configuration changes
    secrets_hash = sha256(local.secrets_json)
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/create-secrets.sh"
    interpreter = ["bash"]

    environment = {
      MODAL_TOKEN_ID     = var.modal_token_id
      MODAL_TOKEN_SECRET = var.modal_token_secret
      DEPLOY_PATH        = var.deploy_path
      SECRETS_JSON       = local.secrets_json
    }
  }
}

# Deploy Modal app
resource "null_resource" "modal_deploy" {
  triggers = {
    # Re-deploy when source files change
    source_hash = var.source_hash
    # Re-deploy when app name changes
    app_name = var.app_name
    # Ensure secrets are created first
    secrets_created = length(var.secrets) > 0 ? null_resource.modal_secrets[0].id : "no-secrets"
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/deploy.sh"
    interpreter = ["bash"]

    environment = {
      MODAL_TOKEN_ID     = var.modal_token_id
      MODAL_TOKEN_SECRET = var.modal_token_secret
      APP_NAME           = var.app_name
      DEPLOY_PATH        = var.deploy_path
      DEPLOY_MODULE      = var.deploy_module
    }
  }

  depends_on = [
    null_resource.modal_secrets,
  ]
}

# Data source to capture deployment info (best effort)
data "external" "modal_app_info" {
  count = var.fetch_app_info ? 1 : 0

  program = ["bash", "-c", <<-EOF
    export MODAL_TOKEN_ID="${var.modal_token_id}"
    export MODAL_TOKEN_SECRET="${var.modal_token_secret}"
    # Return app info as JSON
    echo '{"app_name": "${var.app_name}", "status": "deployed"}'
  EOF
  ]

  depends_on = [null_resource.modal_deploy]
}
