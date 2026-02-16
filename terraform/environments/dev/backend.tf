# Terraform State Backend Configuration
# Uses Cloudflare R2 (S3-compatible storage)
# Same R2 bucket as production, but different state key for isolation.
#
# Initialize with: terraform init -backend-config=backend.tfvars

terraform {
  backend "s3" {
    bucket = "open-inspect-terraform-state"
    key    = "dev/terraform.tfstate"
    region = "auto"

    # All sensitive/account-specific values passed via -backend-config
    # endpoint   = "https://<ACCOUNT_ID>.r2.cloudflarestorage.com"
    # access_key = "..."
    # secret_key = "..."

    # Required for R2 compatibility
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
  }
}
