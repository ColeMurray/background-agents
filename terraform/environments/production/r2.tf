# =============================================================================
# R2 Media Storage
# =============================================================================

resource "cloudflare_r2_bucket" "media" {
  account_id = var.cloudflare_account_id
  name       = "open-inspect-media-${local.name_suffix}"
  location   = "ENAM"
}
