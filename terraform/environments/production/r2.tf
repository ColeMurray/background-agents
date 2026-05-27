# =============================================================================
# R2 Media Storage
# =============================================================================

resource "cloudflare_r2_bucket" "media" {
  account_id = var.cloudflare_account_id
  name       = var.r2_media_bucket_name != "" ? var.r2_media_bucket_name : "open-inspect-media-${local.name_suffix}"
  location   = var.r2_media_location
}
