# Terraform State Backend Configuration
# Uses Cloudflare R2 (S3-compatible storage)
#
# Prerequisites:
# 1. Create R2 bucket: wrangler r2 bucket create open-inspect-terraform-state
# 2. Generate R2 API token with read/write permissions
# 3. Initialize with:
#    terraform init \
#      -backend-config="access_key=<R2_ACCESS_KEY_ID>" \
#      -backend-config="secret_key=<R2_SECRET_ACCESS_KEY>" \
#      -backend-config="endpoints={s3=\"https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com\"}"
#
# Or create a backend.tfvars file (gitignored) with:
#   access_key = "your-r2-access-key-id"
#   secret_key = "your-r2-secret-access-key"
#   endpoints  = { s3 = "https://<account-id>.r2.cloudflarestorage.com" }
#
# Then run: terraform init -backend-config=backend.tfvars

terraform {
  backend "s3" {
    bucket = "open-inspect-terraform-state"
    key    = "production/terraform.tfstate"
    region = "auto"

    # All sensitive/account-specific values passed via -backend-config
    # endpoints = { s3 = "https://<ACCOUNT_ID>.r2.cloudflarestorage.com" }
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
