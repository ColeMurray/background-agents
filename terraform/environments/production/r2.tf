# =============================================================================
# Cloudflare R2 Buckets
# =============================================================================

resource "cloudflare_r2_bucket" "session_attachments" {
  account_id = var.cloudflare_account_id
  name       = "session-attachments"
  location   = "WNAM"
}
