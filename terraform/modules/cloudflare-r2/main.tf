# Cloudflare R2 Bucket Module
# Creates and manages Cloudflare Workers R2 storage buckets
#
# NOTE: Object lifecycle rules (auto-delete after 30 days) must be configured
# via the Cloudflare dashboard or API — not yet supported in the Terraform provider.

resource "cloudflare_r2_bucket" "this" {
  account_id = var.account_id
  name       = var.bucket_name
}
