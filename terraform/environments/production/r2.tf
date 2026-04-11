# =============================================================================
# R2 Media Storage
# =============================================================================

resource "cloudflare_r2_bucket" "media" {
  account_id = var.cloudflare_account_id
  name       = "open-inspect-media-${local.name_suffix}"
  location   = "ENAM"
}

resource "cloudflare_r2_bucket_cors" "media" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.media.name

  rules = [{
    allowed = {
      origins = [local.web_app_url]
      methods = ["GET"]
      headers = ["*"]
    }
    expose = {
      headers = []
    }
    max_age_seconds = 3600
  }]
}

data "cloudflare_api_token_permission_groups_list" "all" {}

locals {
  media_bucket_permission_group_id = one([
    for group in data.cloudflare_api_token_permission_groups_list.all.result : group.id
    if group.name == "Workers R2 Storage Bucket Item Read"
  ])

  media_bucket_resource_id = "com.cloudflare.edge.r2.bucket.${var.cloudflare_account_id}_default_${cloudflare_r2_bucket.media.name}"
}

resource "cloudflare_account_token" "control_plane_media_read" {
  account_id = var.cloudflare_account_id
  name       = "open-inspect-control-plane-media-read-${local.name_suffix}"

  policies = [{
    effect = "allow"
    permission_groups = [{
      id = local.media_bucket_permission_group_id
    }]
    resources = jsonencode({
      (local.media_bucket_resource_id) = "*"
    })
  }]
}
