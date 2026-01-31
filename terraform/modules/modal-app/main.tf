# Modal App Module
# Wraps Modal CLI commands since no Terraform provider exists
# Uses null_resource with local-exec provisioners

locals {
  # Combine all secrets for the create-secrets script
  # Base64 encode to safely pass multiline values (like PEM keys) through environment variables
  secrets_json_b64 = base64encode(jsonencode(var.secrets))
}

# Create Modal secrets
resource "null_resource" "modal_secrets" {
  count = length(var.secrets) > 0 ? 1 : 0

  triggers = {
    # Re-run when secrets configuration changes
    secrets_hash = sha256(local.secrets_json_b64)
  }

  provisioner "local-exec" {
    command     = "${path.module}/scripts/create-secrets.sh"
    interpreter = ["bash"]

    environment = {
      MODAL_TOKEN_ID     = var.modal_token_id
      MODAL_TOKEN_SECRET = var.modal_token_secret
      SECRETS_JSON_B64   = local.secrets_json_b64
    }
  }
}

# Create Modal volume
resource "null_resource" "modal_volume" {
  count = var.volume_name != null ? 1 : 0

  triggers = {
    volume_name = var.volume_name
  }

  provisioner "local-exec" {
    command = "modal volume create ${var.volume_name} || echo 'Volume may already exist'"

    environment = {
      MODAL_TOKEN_ID     = var.modal_token_id
      MODAL_TOKEN_SECRET = var.modal_token_secret
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
    # Ensure secrets and volume are created first
    secrets_created = length(var.secrets) > 0 ? null_resource.modal_secrets[0].id : "no-secrets"
    volume_created  = var.volume_name != null ? null_resource.modal_volume[0].id : "no-volume"
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
    null_resource.modal_volume
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
