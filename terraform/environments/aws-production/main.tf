# =============================================================================
# Open-Inspect - AWS production
# =============================================================================
# The same module as staging, sized up and left running. No Cloudflare account
# is involved at any point.
#
#   terraform init -backend-config=backend.tfvars
#   terraform apply
#
# See docs/AWS_BRING_UP.md.

locals {
  environment = "production"
}

module "control_plane" {
  source = "../../modules/aws-control-plane"

  name     = "open-inspect-production"
  hostname = var.hostname

  instance_type           = "t4g.large"
  data_volume_size_gb     = 200
  control_plane_image_tag = var.control_plane_image_tag

  # No schedule: production answers at 03:00.
  out_of_hours_stop = null

  log_retention_days       = 30
  snapshot_retention_count = 30

  # A destroy must not be able to take the media, the backups or the images
  # with it; it fails instead.
  force_destroy_storage = false

  route53_zone_id = var.route53_zone_id
  alarm_topic_arn = var.alarm_topic_arn

  config = merge({
    APP_NAME               = "Open-Inspect"
    LOG_LEVEL              = "info"
    SANDBOX_PROVIDER       = "modal"
    UNSAFE_ALLOW_ALL_USERS = "false"
  }, var.config)

  tags = { Environment = local.environment }
}
