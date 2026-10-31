# Per-service sig1 signing secrets.
#
# One secret per first-party service, generated in Terraform state. The control
# plane binds each verification key as SERVICE_AUTH_SECRET_<SERVICE>; each
# sender binds exactly its own as SERVICE_AUTH_SECRET (a sender signs as
# itself, so naming its own service in its env var adds nothing). The bot and
# web secrets need no operator input; the optional export secret exists only
# while export_service_actor is set.

resource "random_password" "service_auth_secret_web" {
  length  = 64
  special = false
}

resource "random_password" "service_auth_secret_slack_bot" {
  length  = 64
  special = false
}

resource "random_password" "service_auth_secret_github_bot" {
  length  = 64
  special = false
}

resource "random_password" "service_auth_secret_linear_bot" {
  length  = 64
  special = false
}

# Signing secret for unattended trace export (docs/TRACE_EXPORT.md). Only an
# operator holds it, read from the sensitive `export_service_secret` output.
# Re-pinning the actor or user replaces the secret, so a holder of the old one
# cannot act as the new pin.
resource "random_password" "service_auth_secret_export" {
  count   = var.export_service_actor != "" ? 1 : 0
  length  = 64
  special = false
  keepers = {
    actor   = var.export_service_actor
    user_id = var.export_service_user_id
  }
}

# Dedicated pepper for image-build callback token hashes.
resource "random_password" "image_callback_token_pepper" {
  length  = 64
  special = false
}

# Dedicated encryption key for provider-account credentials. Operators may
# supply an existing key during upgrades; new installations use this generated
# value, which remains stable in Terraform state.
resource "random_bytes" "provider_accounts_encryption_key" {
  length = 32
}

locals {
  effective_provider_accounts_encryption_key = trimspace(var.provider_accounts_encryption_key) != "" ? trimspace(var.provider_accounts_encryption_key) : random_bytes.provider_accounts_encryption_key.base64
}
