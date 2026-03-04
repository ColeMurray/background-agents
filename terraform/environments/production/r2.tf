# =============================================================================
# Cloudflare R2 Storage Buckets
# =============================================================================

module "media_bucket" {
  source = "../../modules/cloudflare-r2"

  account_id  = var.cloudflare_account_id
  bucket_name = "${var.deployment_name}-media"
}
